import express from "express";
import cors from "cors";
import pg from "pg";
import dotenv from "dotenv";

// Load the values from .env into process.env (PORT + the DB_* settings below).
dotenv.config();

// ---------------------------------------------------------------------------
// DATABASE
// ---------------------------------------------------------------------------
// The Postgres connection pool — same pattern as your existing apps.
// It reads the connection details from your .env file.
const { Pool } = pg;
const db = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

// ---------------------------------------------------------------------------
// APP SETUP
// ---------------------------------------------------------------------------
const app = express();
const PORT = process.env.PORT || 4000;

// Middleware: small helpers that run on every incoming request.
app.use(cors());          // let the React app (on a different port) call this API
app.use(express.json());  // understand JSON sent in request bodies



// Effective status of a room = its stored status, except a Booked room is
// upgraded to "1hr Left" or "Overdue" based on its active stay's expected
// checkout. Computed at read time (Option 1) so it's always current with no
// background job. `expectedCheckout` is the active stay's timestamp (or null).
function effectiveRoomStatus(storedStatus, expectedCheckout) {
  if (storedStatus !== "Booked") return storedStatus;
  if (!expectedCheckout) return "Booked";

  const now = Date.now();
  const due = new Date(expectedCheckout).getTime();
  const oneHour = 60 * 60 * 1000;

  if (now >= due) return "Overdue";
  if (now >= due - oneHour) return "1hour Left";   // <-- exact match to STATUSES
  return "Booked";
}

// Rooms need servicing every morning, and again whenever a guest leaves. So a
// room is CLEAN only if it was cleaned since this morning's cutoff AND nobody
// has checked out since that cleaning.
//
// Derived, never stored: no scheduled job to keep running, and it stays correct
// even if the machine was off for a week.
//
// The cutoff is 6am WAT (05:00 UTC) — before that hour we're still measuring
// against yesterday's, so an overnight shift doesn't see every room flip.
function housekeepingState(lastCleanedAt, lastCheckoutAt) {
  if (!lastCleanedAt) return "Dirty";        // never recorded as cleaned

  const cleaned = new Date(lastCleanedAt).getTime();

  const now = new Date();
  const cutoff = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 5, 0, 0
  ));
  if (now.getTime() < cutoff.getTime()) {
    cutoff.setUTCDate(cutoff.getUTCDate() - 1);
  }

  if (cleaned < cutoff.getTime()) return "Dirty";          // a new day
  if (lastCheckoutAt && new Date(lastCheckoutAt).getTime() > cleaned) {
    return "Dirty";                                        // a guest left since
  }
  return "Clean";
}

// Rooms of one category that are free across a date range, in room-number
// order. The reservation auto-assign takes the first N of these.
//
// `runner` is `db` for a plain read, or the transaction client when assigning.
// Pass lockCategory=true inside a transaction to serialise concurrent
// reservations for the same category (see POST /api/reservations).
async function freeRoomsInCategory(runner, category, startDate, endDate, lockCategory = false) {
  if (lockCategory) {
    // Held until the transaction ends. Two people reserving the same category
    // at the same time now queue instead of both grabbing the same rooms.
    await runner.query("SELECT pg_advisory_xact_lock(hashtext($1))", [category]);
  }

  const result = await runner.query(
    `SELECT r.*
       FROM rooms r
      WHERE r.category = $1
        AND r.is_disabled = FALSE
        -- not already reserved for an overlapping range
        AND NOT EXISTS (
          SELECT 1
            FROM reservation_rooms rr
            JOIN reservations res ON res.id = rr.reservation_id
           WHERE rr.room_id = r.id
             AND res.start_date < $3
             AND res.end_date   > $2
        )
        -- not occupied by a stay that overlaps the range. We compare against
        -- expected_checkout so a guest leaving tomorrow doesn't block a booking
        -- next month. Stays with no expected_checkout are treated as blocking.
        AND NOT EXISTS (
          SELECT 1
            FROM stays s
           WHERE s.room_id = r.id
             AND s.is_active = TRUE
             AND (s.expected_checkout IS NULL OR s.expected_checkout > $2)
             AND s.check_in < $3
        )
      ORDER BY r.number`,
    [category, startDate, endDate]
  );
  return result.rows;
}

// Format a DATE column as YYYY-MM-DD without going through UTC.
//
// pg hands back a DATE as LOCAL midnight. toISOString() converts to UTC, which
// in WAT (UTC+1) rolls the date back a day. Reading the local parts sidesteps
// that entirely — a calendar date has no timezone, so it shouldn't be put
// through one.
// Today's calendar date, locally. NOT toISOString(), which converts to UTC —
// between midnight and 1am WAT that returns YESTERDAY, so a sale rung up at
// 00:30 would be logged to the previous day.
function todayString() {
  return toDateString(new Date());
}

function toDateString(value) {
  if (!value) return null;
  const d = new Date(value);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}


// ---------------------------------------------------------------------------
// ROUTES
// ---------------------------------------------------------------------------

// Root + health check — quick ways to confirm the server is alive.
app.get("/", (req, res) => {
  res.send("Premium Hotel API is running! 🎉");
});



// GET /api/rooms — return all rooms from the database as JSON.
// GET /api/rooms — return rooms, optionally filtered by category and/or status.
//
// Examples:
//   /api/rooms                          -> all rooms
//   /api/rooms?category=VIP             -> only VIP rooms
//   /api/rooms?status=Available         -> only available rooms
//   /api/rooms?category=VIP&status=Available  -> both filters (reception default)
//
// We build the WHERE clause piece by piece so it works whether zero, one, or
// both filters are supplied. Each value goes into `params` and is referenced by
// a numbered placeholder ($1, $2) — never glued into the string — so it's safe
// from SQL injection.
app.get("/api/rooms", async (req, res) => {
  try {
    const { category, status, active_only } = req.query;

    const conditions = [];
    const params = [];

    if (category) {
      params.push(category);
      conditions.push(`r.category = $${params.length}`);
    }
    if (active_only === "true") {
      conditions.push(`r.is_disabled = FALSE`);
    }
    // NOTE: status is intentionally NOT filtered here anymore — it's computed
    // below and filtered in JS, because "1hr Left"/"Overdue" aren't stored.

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

        const result = await db.query(
      `SELECT r.*, s.expected_checkout,
              -- the most recent checkout on this room, for the clean/dirty rule
              (SELECT MAX(st.check_out) FROM stays st
                WHERE st.room_id = r.id AND st.check_out IS NOT NULL) AS last_checkout
         FROM rooms r
         LEFT JOIN stays s ON s.room_id = r.id AND s.is_active = TRUE
        ${whereClause}
        ORDER BY r.id`,
      params
    );

        let rooms = result.rows.map((room) => {
      const effective = effectiveRoomStatus(room.status, room.expected_checkout);
      const housekeeping = housekeepingState(room.last_cleaned_at, room.last_checkout);
      const { expected_checkout, last_checkout, ...rest } = room;
      return { ...rest, status: effective, housekeeping };
    });

    // Now apply the status filter (if any) against the COMPUTED status.
    if (status) {
      rooms = rooms.filter((r) => r.status === status);
    }

    res.json(rooms);
  } catch (err) {
    console.error("Error fetching rooms:", err.message);
    res.status(500).json({ error: "Could not fetch rooms" });
  }
});

// GET /api/rooms/availability?start=2026-08-12&end=2026-08-15
// Feeds the "N available" column and the price column on the create form.
app.get("/api/rooms/availability", async (req, res) => {
  try {
    const { start, end } = req.query;
    if (!start || !end) {
      return res.status(400).json({ error: "start and end are required" });
    }
    if (new Date(end) <= new Date(start)) {
      return res.status(400).json({ error: "end must be after start" });
    }

    const cats = await db.query(
      `SELECT category, MIN(price) AS price
         FROM rooms
        WHERE is_disabled = FALSE
        GROUP BY category
        ORDER BY category`
    );

    const out = [];
    for (const row of cats.rows) {
      const free = await freeRoomsInCategory(db, row.category, start, end);
      out.push({
        category: row.category,
        price: Number(row.price),
        available: free.length,
      });
    }
    res.json(out);
  } catch (err) {
    console.error("Availability failed:", err.message);
    res.status(500).json({ error: "Could not fetch availability" });
  }
});

// PATCH /api/rooms/:id/clean — record that a room has just been serviced.
//
// This is what the housekeeping module will call. Clean/Dirty is derived from
// this timestamp, so writing it is the only thing needed to flip a room.
app.patch("/api/rooms/:id/clean", async (req, res) => {
  try {
    const result = await db.query(
      "UPDATE rooms SET last_cleaned_at = NOW() WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Room not found" });
    }
    res.json({ message: "Room marked clean", room: result.rows[0] });
  } catch (err) {
    console.error("Mark clean failed:", err.message);
    res.status(500).json({ error: "Could not mark the room clean" });
  }
});

// ===========================================================================
// ISSUES — faults reported by any department
// ===========================================================================

// GET /api/issues?department=Bar
// Every report, newest first, with a status tally. Omit `department` for all.
app.get("/api/issues", async (req, res) => {
  try {
    const { department } = req.query;

    const result = await db.query(
      `SELECT i.*,
              -- Reception points at a real room; everyone else names a place.
              COALESCE(r.number, i.location) AS place,
              r.category
         FROM issues i
         LEFT JOIN rooms r ON r.id = i.room_id
        WHERE ($1::text IS NULL OR i.department = $1)
        ORDER BY i.created_at DESC`,
      [department || null]
    );

    const counts = { Received: 0, "In Progress": 0, Resolved: 0 };
    for (const row of result.rows) counts[row.status] = (counts[row.status] || 0) + 1;

    res.json({
      // The badge shows what still needs attention — resolved drops out.
      openCount: counts["Received"] + counts["In Progress"],
      counts,
      issues: result.rows.map((i) => ({
        id: i.id,
        department: i.department,
        roomId: i.room_id,
        // One field the frontend can always show, whatever the department.
        place: i.place || "—",
        category: i.category,
        issue: i.issue,
        priority: i.priority,
        status: i.status,
                reportedBy: i.reported_by,
        createdAt: i.created_at,
        // Needed by the activity sheet: a fault reported last week and fixed
        // today is TODAY's event, not last week's.
        resolvedAt: i.resolved_at,
      })),
    });
  } catch (err) {
    console.error("Fetch issues failed:", err.message);
    res.status(500).json({ error: "Could not fetch reports" });
  }
});

// POST /api/issues
// Reception sends { department: "Reception", room_id, issue, priority }.
// Everyone else sends { department: "Bar", location: "Bar 1", issue, priority }.
app.post("/api/issues", async (req, res) => {
  try {
    const { department, room_id, location, issue, priority } = req.body;
    if (!issue || issue.trim() === "") {
      return res.status(400).json({ error: "Please describe the issue" });
    }
    if (!room_id && !location) {
      return res.status(400).json({ error: "Say where the issue is" });
    }
    if (priority && !["Low", "Medium", "High"].includes(priority)) {
      return res.status(400).json({ error: "priority must be Low, Medium or High" });
    }

    const result = await db.query(
      `INSERT INTO issues (department, room_id, location, issue, priority, reported_by)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [department || "Reception", room_id || null, location || null,
       issue.trim(), priority || "Medium", req.body.reported_by || department || "Staff"]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Report issue failed:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/issues/:id — move a report along.
app.patch("/api/issues/:id", async (req, res) => {
  const { status } = req.body;
  if (!["Received", "In Progress", "Resolved"].includes(status)) {
    return res.status(400).json({ error: "Invalid status" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const result = await client.query(
      `UPDATE issues
          SET status = $1,
              resolved_at = CASE WHEN $1 = 'Resolved' THEN NOW() ELSE NULL END
        WHERE id = $2 RETURNING *`,
      [status, req.params.id]
    );
    if (result.rows.length === 0) throw new Error("Report not found");

    // A fault that's fixed has nothing left to fund. Any request still sitting
    // with the admin is moot, so it closes itself rather than staying live for
    // someone to approve money against finished work.
    if (status === "Resolved") {
      await client.query(
        `UPDATE maintenance_requests
            SET status = 'Declined', decided_at = NOW(),
                decided_by = 'Closed — fault resolved'
          WHERE issue_id = $1 AND status = 'Pending'`,
        [req.params.id]
      );
    }

    await client.query("COMMIT");
    res.json(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Update issue failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/rooms/activity?date=2026-08-14
// Everything that happened across the rooms on one day, for the shift handover.
//
// No new table — the events already exist across stays, reservations, rooms
// and issues. This gathers them into one ordered list, the same way the
// account summary merges deposits and charges.
app.get("/api/rooms/activity", async (req, res) => {
  try {
    const date = req.query.date || todayString();
        // $1 is the date parameter — interpolating the raw value would have
    // Postgres read 2026-08-14 as arithmetic rather than a date.
    const next = "$1::date + 1";

    // --- Check-ins ---
    const checkIns = await db.query(
      `SELECT s.id, s.check_in AS at, s.amount_paid, s.payment_method,
              r.number AS room,
              (SELECT g.name FROM stay_guests sg JOIN guests g ON g.id = sg.guest_id
                WHERE sg.stay_id = s.id AND sg.is_primary = TRUE LIMIT 1) AS guest
         FROM stays s JOIN rooms r ON r.id = s.room_id
        WHERE s.check_in >= $1::date AND s.check_in < ${next}`,
      [date]
    );

    // --- Check-outs ---
    const checkOuts = await db.query(
      `SELECT s.id, s.check_out AS at, s.amount_paid, r.number AS room,
              (SELECT g.name FROM stay_guests sg JOIN guests g ON g.id = sg.guest_id
                WHERE sg.stay_id = s.id AND sg.is_primary = TRUE LIMIT 1) AS guest
         FROM stays s JOIN rooms r ON r.id = s.room_id
        WHERE s.check_out >= $1::date AND s.check_out < ${next}`,
      [date]
    );

    // --- Reservations made ---
    const reservations = await db.query(
      `SELECT res.id, res.created_at AS at, res.amount_paid, g.name AS guest,
              (SELECT COUNT(*) FROM reservation_rooms rr WHERE rr.reservation_id = res.id) AS rooms
         FROM reservations res JOIN guests g ON g.id = res.guest_id
        WHERE res.created_at >= $1::date AND res.created_at < ${next}`,
      [date]
    );

    // --- Rooms cleaned ---
    const cleaned = await db.query(
      `SELECT id, number AS room, last_cleaned_at AS at
         FROM rooms
        WHERE last_cleaned_at >= $1::date AND last_cleaned_at < ${next}`,
      [date]
    );

    // --- Issues reported ---
    const issues = await db.query(
      `SELECT i.id, i.created_at AS at, i.issue, i.priority, i.status,
              r.number AS room
         FROM issues i JOIN rooms r ON r.id = i.room_id
        WHERE i.department = 'Reception'
          AND i.created_at >= $1::date AND i.created_at < ${next}`,
      [date]
    );

    // Merge into one list, newest first. `amount` is null where no money moved,
    // so the column can stay blank rather than showing a misleading zero.
    const events = [
      ...checkIns.rows.map((e) => ({
        type: "Check-in", at: e.at, room: e.room,
        details: `${e.guest || "Guest"} · ${e.payment_method || "—"}`,
        amount: Number(e.amount_paid) || null, staff: "Reception",
      })),
      ...checkOuts.rows.map((e) => ({
        type: "Check-out", at: e.at, room: e.room,
        details: `${e.guest || "Guest"} · stay closed`,
        amount: null, staff: "Reception",
      })),
      ...reservations.rows.map((e) => ({
        type: "Reservation", at: e.at, room: "—",
        details: `${e.guest} · ${e.rooms} room${Number(e.rooms) === 1 ? "" : "s"}`,
        amount: Number(e.amount_paid) || null, staff: "Reception",
      })),
      ...cleaned.rows.map((e) => ({
        type: "Cleaned", at: e.at, room: e.room,
        details: "Room serviced", amount: null, staff: "Housekeeping",
      })),
      ...issues.rows.map((e) => ({
        type: "Issue", at: e.at, room: e.room,
        details: `${e.issue} · ${e.priority}`, amount: null, staff: "Reception",
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    // The five figures, each with a second line of context.
    const stillDirty = await db.query(
      `SELECT COUNT(*) AS c FROM rooms
        WHERE last_cleaned_at IS NULL OR last_cleaned_at < $1::date`,
      [date]
    );
    const openIssues = await db.query(
      `SELECT COUNT(*) AS c FROM issues
        WHERE department = 'Reception' AND status <> 'Resolved'`
    );
    const resvTotal = reservations.rows.reduce((s, r) => s + Number(r.amount_paid || 0), 0);

    res.json({
      date,
      stats: {
        checkIns:     { value: checkIns.rows.length,     note: `${checkOuts.rows.length} checked out` },
        checkOuts:    { value: checkOuts.rows.length,    note: "rooms vacated" },
        reservations: { value: reservations.rows.length, note: `₦${resvTotal.toLocaleString()} booked` },
        cleaned:      { value: cleaned.rows.length,      note: `${stillDirty.rows[0].c} still to do` },
        issues:       { value: issues.rows.length,       note: `${openIssues.rows[0].c} still open` },
      },
      events,
    });
  } catch (err) {
    console.error("Activity failed:", err.message);
    res.status(500).json({ error: "Could not build today's activity" });
  }
});

// GET /api/rooms/:id/details — everything the Room Details popup shows.
//
// Amenities come back as the FULL master list, each marked with whether this
// room has it and how many. That's what lets the popup show "No WiFi" struck
// through: without the master list, a missing amenity would just be absent and
// reception would be left guessing.
app.get("/api/rooms/:id/details", async (req, res) => {
  try {
    const { id } = req.params;

    const roomResult = await db.query("SELECT * FROM rooms WHERE id = $1", [id]);
    if (roomResult.rows.length === 0) {
      return res.status(404).json({ error: "Room not found" });
    }
    const room = roomResult.rows[0];

    // Every amenity the hotel has, LEFT JOINed to what this room carries.
    const amenities = await db.query(
      `SELECT a.id, a.name, COALESCE(ra.count, 0) AS count
         FROM amenities a
         LEFT JOIN room_amenities ra
                ON ra.amenity_id = a.id AND ra.room_id = $1
        ORDER BY a.sort_order, a.name`,
      [id]
    );

    res.json({
      id: room.id,
      number: room.number,
      category: room.category,
      price: Number(room.price),
      status: room.status,
      location: {
        floor: room.floor,
        wing: room.wing,
        directions: room.directions,
      },
      capacity: {
        sleeps: room.sleeps,
        bed: room.bed_type,
        size: room.size_sqm ? Number(room.size_sqm) : null,
      },
      amenities: amenities.rows.map((a) => ({
        id: a.id,
        name: a.name,
        count: Number(a.count),
        has: Number(a.count) > 0,
      })),
    });
  } catch (err) {
    console.error("Room details failed:", err.message);
    res.status(500).json({ error: "Could not fetch room details" });
  }
});

// ===========================================================================
// GUESTS — add / search (used by the check-in & reserve popups)
// ===========================================================================

// GET /api/guests/search?name=ada — find existing guests by name (partial,
// case-insensitive). Powers the "Search Existing Guest" box and its suggestions
// for both the main guest and co-guests.
app.get("/api/guests/search", async (req, res) => {
  try {
    // Accept either ?q= (new) or ?name= (old) so nothing else breaks.
    const term = (req.query.q ?? req.query.name ?? "").trim();
    if (term === "") {
      return res.json([]);   // no search text -> empty, not every guest
    }

    // Match name OR phone. ILIKE = case-insensitive "contains".
    const result = await db.query(
      `SELECT * FROM guests
        WHERE name ILIKE $1 OR phone ILIKE $1
        ORDER BY name
        LIMIT 10`,
      [`%${term}%`]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Guest search failed:", err.message);
    res.status(500).json({ error: "Could not search guests" });
  }
});

// POST /api/guests — add a new guest (the "Add New Guest" form).
// Blocks exact duplicates: if a guest with the same name AND phone already
// exists, we return that existing one instead of creating a copy.
//
// Body: { "name": "Ada", "phone": "080...", "email": "a@x.com", "address": "Lagos" }
app.post("/api/guests", async (req, res) => {
  try {
    const { name, phone, email, address } = req.body;
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "Guest name is required" });
    }

    // Duplicate check: same name + same phone = treat as the same person.
    // (We compare name case-insensitively; phone is matched as-is.)
    const existing = await db.query(
      `SELECT * FROM guests
        WHERE name ILIKE $1 AND COALESCE(phone, '') = COALESCE($2, '')
        LIMIT 1`,
      [name, phone || null]
    );
    if (existing.rows.length > 0) {
      // 200 (not 201) + a flag so the frontend knows it wasn't newly created.
      //if guest already exists, no need to send an error, we send back the data of the existing guest
      return res.json({ ...existing.rows[0], already_existed: true });
    }

    const result = await db.query(
      `INSERT INTO guests (name, phone, email, address)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [name, phone || null, email || null, address || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add guest failed:", err.message);
    res.status(500).json({ error: "Could not add guest" });
  }
});

// ===========================================================================
// RECEPTION — CHECK-IN (guests already exist; we just link them to a stay)
// ===========================================================================

// POST /api/checkin — check already-existing guests into a room.
//
// By this point the popup has already created/selected each guest, so we only
// receive their IDs:
// {
//   "room_id": 6,
//   "amount_paid": 60000,
//   "payment_method": "Cash",
//   "primary_guest_id": 3,          // the main guest
//   "co_guest_ids": [4, 7]          // optional — [] or omitted is fine
// }
//
// Still a transaction: create the stay + all the links + flip the room, all or
// nothing.
app.post("/api/checkin", async (req, res) => {
  const { room_id, amount_paid, payment_method, primary_guest_id, co_guest_ids, nights } =
    req.body;

  if (!room_id || !primary_guest_id) {
    return res
      .status(400)
      .json({ error: "room_id and primary_guest_id are required" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Room must exist and be available.
    const roomResult = await client.query(
      "SELECT status FROM rooms WHERE id = $1",
      [room_id]
    );
    if (roomResult.rows.length === 0) throw new Error("Room not found");
    if (roomResult.rows[0].status !== "Available") throw new Error("Room is not available");

    // 1. Create the (active) stay.
    // Expected checkout = noon WAT (UTC+1) on the Nth day after check-in.
    // WAT is UTC+1 with no daylight saving, so noon WAT is always 11:00 UTC.
    // e.g. check in any time Monday for "3 Nights" -> Thursday 12:00 WAT.
    const nightCount = Number(nights) || 1;
    const checkoutDate = new Date();
    checkoutDate.setUTCDate(checkoutDate.getUTCDate() + nightCount);
    checkoutDate.setUTCHours(11, 0, 0, 0);   // 11:00 UTC = 12:00 noon WAT

    // 1. Create the (active) stay.
    const stayResult = await client.query(
      `INSERT INTO stays (room_id, check_in, expected_checkout, amount_paid, payment_method, is_active)
       VALUES ($1, NOW(), $2, $3, $4, TRUE)
       RETURNING id`,
      [room_id, checkoutDate, amount_paid || 0, payment_method || null]
    );
    const stayId = stayResult.rows[0].id;
    // 1b. If paid on a company account, charge the tab.
    //     payment_method holds the account NAME when an account was chosen.
    //     Cash / Transfer / Card / POS won't match any account, so they skip
    //     this entirely and behave exactly as before.
    if (payment_method) {
      const acct = await client.query(
        "SELECT id, balance, credit_limit, status FROM accounts WHERE name = $1 FOR UPDATE",
        [payment_method]
      );

      if (acct.rows.length > 0) {
        const account = acct.rows[0];
        const charge = Number(amount_paid || 0);

        // A suspended account can't be charged.
        if (account.status !== "Active") {
          throw new Error("This account is suspended and cannot be charged");
        }

        // Credit floor: balance may fall to -credit_limit, no further.
        // Block when balance - charge < -credit_limit.
        const newBalance = Number(account.balance) - charge;
        if (newBalance < -Number(account.credit_limit)) {
          throw new Error("This account has insufficient credit for this charge");
        }

        // Draw the charge down from the account balance.
        await client.query(
          "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
          [charge, account.id]
        );
      }
    }

    // 2. Link the main guest (primary).
    await client.query(
      `INSERT INTO stay_guests (stay_id, guest_id, is_primary)
       VALUES ($1, $2, TRUE)`,
      [stayId, primary_guest_id]
    );

    // 3. Link any co-guests (not primary). Skip the primary if it sneaks in.
    for (const gid of co_guest_ids || []) {
      if (gid && gid !== primary_guest_id) {
        await client.query(
          `INSERT INTO stay_guests (stay_id, guest_id, is_primary)
           VALUES ($1, $2, FALSE)`,
          [stayId, gid]
        );
      }
    }

    // 4. Flip the room to Booked.
    await client.query("UPDATE rooms SET status = 'Booked' WHERE id = $1", [
      room_id,
    ]);

    // 5. Log the cash, unless it went on a company tab (no cash moved).
    const stayOnAccount = await client.query(
      "SELECT 1 FROM accounts WHERE name = $1", [payment_method]
    );
    if (stayOnAccount.rows.length === 0 && Number(amount_paid || 0) > 0) {
      await recordCashMovement(client, {
        moved_on: todayString(),
        direction: "in",
        kind: "sales_paid",
        amount: Number(amount_paid),
        method: payment_method,
        description: "Room booking",
        source_type: "stay",
        source_id: stayId,
      });
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Guest checked in", stay_id: stayId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Check-in failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/rooms/:id/guest — for "View Guest": fetch the guest(s) currently
// staying in a given room. Returns the main guest plus any co-guests.
app.get("/api/rooms/:id/guest", async (req, res) => {
  try {
    const roomId = req.params.id;

    // Find the active stay for this room, then all guests linked to it.
    // We join stays -> stay_guests -> guests, ordered so the primary (main)
    // guest comes first.
    const result = await db.query(
      `SELECT g.*, sg.is_primary, s.id AS stay_id, s.amount_paid, s.payment_method, s.check_in, s.expected_checkout
        FROM stays s
         JOIN stay_guests sg ON sg.stay_id = s.id
         JOIN guests g ON g.id = sg.guest_id
        WHERE s.room_id = $1 AND s.is_active = TRUE
        ORDER BY sg.is_primary DESC, g.id`,
      [roomId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: "No active guest in this room" });
    }

    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching room guest:", err.message);
    res.status(500).json({ error: "Could not fetch guest" });
  }
});

// GET /api/stays/:id/guests — the guests on ONE specific stay, past or present.
// Same row shape as /api/rooms/:id/guest, so BookingDetails can render either.
app.get("/api/stays/:id/guests", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT g.*, sg.is_primary,
              s.id AS stay_id, s.amount_paid, s.payment_method,
              s.check_in, s.expected_checkout, s.check_out
         FROM stays s
         JOIN stay_guests sg ON sg.stay_id = s.id
         JOIN guests g ON g.id = sg.guest_id
        WHERE s.id = $1
        ORDER BY sg.is_primary DESC, g.id`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Stay not found" });
    }
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching stay guests:", err.message);
    res.status(500).json({ error: "Could not fetch stay guests" });
  }
});

// POST /api/rooms/:id/checkout — end the active stay and free the room.
// We keep the stay row (is_active -> false) so it stays in history and still
// counts toward the guest's spending totals later.
app.post("/api/rooms/:id/checkout", async (req, res) => {
  const client = await db.connect();
  try {
    const roomId = req.params.id;
    await client.query("BEGIN");

    // Close the active stay for this room (record the check-out time).
    const stayResult = await client.query(
      `UPDATE stays
          SET is_active = FALSE, check_out = NOW()
        WHERE room_id = $1 AND is_active = TRUE
        RETURNING id`,
      [roomId]
    );

    if (stayResult.rows.length === 0) {
      throw new Error("No active stay found for this room");
    }

    // Free the room.
    await client.query("UPDATE rooms SET status = 'Available' WHERE id = $1", [
      roomId,
    ]);

    await client.query("COMMIT");
    res.json({ message: "Guest checked out, room now available" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Check-out failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===========================================================================
// RECEPTION — RESERVATION FLOW (guest already exists; we just reserve the room)
// ===========================================================================

// POST /api/reservations — reserve N rooms across one or more categories.
//
// Body:
// {
//   "guest_id": 3,
//   "start_date": "2026-08-12",
//   "end_date": "2026-08-15",
//   "payment_method": "Cash",
//   "rooms": [ { "category": "Deluxe King", "qty": 5, "amount": 635000 } ]
// }
//
// `amount` is that category's total for the whole stay. Rooms are auto-assigned:
// the first N free rooms of the category, by room number.
//
// One transaction: the header, every room row, and the account charge either
// all land or none do.
app.post("/api/reservations", async (req, res) => {
  const { guest_id, start_date, end_date, payment_method, rooms } = req.body;

  if (!guest_id) return res.status(400).json({ error: "guest_id is required" });
  if (!start_date || !end_date) {
    return res.status(400).json({ error: "start_date and end_date are required" });
  }
  if (!Array.isArray(rooms) || rooms.length === 0) {
    return res.status(400).json({ error: "at least one room category is required" });
  }
  if (new Date(end_date) <= new Date(start_date)) {
    return res.status(400).json({ error: "end_date must be after start_date" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Total across every category — what the reserver pays now.
    const total = rooms.reduce((sum, r) => sum + Number(r.amount || 0), 0);

    // 1. The header.
    const head = await client.query(
      `INSERT INTO reservations (guest_id, start_date, end_date, amount_paid, payment_method)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [guest_id, start_date, end_date, total, payment_method || null]
    );
    const reservationId = head.rows[0].id;

    // 2. Auto-assign rooms, category by category.
    for (const line of rooms) {
      const qty = Number(line.qty);
      if (!Number.isInteger(qty) || qty <= 0) continue;   // skip empty rows

            // lockCategory=true — serialises against other reservations in flight.
      const free = await freeRoomsInCategory(
        client, line.category, start_date, end_date, true
      );

      // A line can name a specific room (reception reserving the card they
      // clicked). Put it first so it's the one taken; without this the
      // auto-assign would hand back whichever room sorts first by number.
      let candidates = free;
      if (line.room_id) {
        const wanted = free.find((r) => r.id === Number(line.room_id));
        if (!wanted) {
          throw new Error("That room isn't available for those dates");
        }
        candidates = [wanted, ...free.filter((r) => r.id !== wanted.id)];
      }

      if (candidates.length < qty) {
        throw new Error(
          `Only ${candidates.length} ${line.category} room(s) free for those dates`
        );
      }

      // Each room carries its share of the line total, so cancelling one room
      // refunds the right amount.
      const perRoom = Number(line.amount || 0) / qty;

      for (const room of candidates.slice(0, qty)) {
        await client.query(
          `INSERT INTO reservation_rooms (reservation_id, room_id, category, amount)
           VALUES ($1, $2, $3, $4)`,
          [reservationId, room.id, line.category, perRoom]
        );
      }
    }

    // 3. If paid on a company account, charge the tab now (same rule as
    //    check-in: suspended accounts refused, credit floor enforced).
    if (payment_method) {
      const acct = await client.query(
        "SELECT id, balance, credit_limit, status FROM accounts WHERE name = $1 FOR UPDATE",
        [payment_method]
      );
      if (acct.rows.length > 0) {
        const account = acct.rows[0];
        if (account.status !== "Active") {
          throw new Error("This account is suspended and cannot be charged");
        }
        if (Number(account.balance) - total < -Number(account.credit_limit)) {
          throw new Error("This account has insufficient credit for this reservation");
        }
        await client.query(
          "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
          [total, account.id]
        );
      }
    }

    // Log the deposit, unless it went on a tab (no cash moved).
    const resvOnAccount = await client.query(
      "SELECT 1 FROM accounts WHERE name = $1", [payment_method]
    );
    if (resvOnAccount.rows.length === 0 && total > 0) {
      await recordCashMovement(client, {
        moved_on: todayString(),
        direction: "in",
        kind: "deposit",
        amount: total,
        method: payment_method,
        description: `Reservation — ${rooms.length} categor${rooms.length === 1 ? "y" : "ies"}`,
        source_type: "reservation",
        source_id: reservationId,
      });
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Rooms reserved", reservation_id: reservationId, total });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reservation failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// GET /api/reservations — every upcoming reservation, one entry per reserved
// room, soonest arrival first. Each entry also carries the rooms it could be
// reassigned to (the free ones for those dates, plus its own current room).
app.get("/api/reservations", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT rr.id, rr.category, rr.amount, rr.room_id,
              rm.number        AS room_number,
              res.id           AS reservation_id,
              res.start_date, res.end_date, res.payment_method,
              g.id AS guest_id, g.name AS reserver, g.phone, g.email, g.address
         FROM reservation_rooms rr
         JOIN reservations res ON res.id = rr.reservation_id
         JOIN rooms rm        ON rm.id = rr.room_id
         JOIN guests g        ON g.id  = res.guest_id
        ORDER BY res.start_date, rr.id`
    );

    // Work out the swap options for each row. Small volumes, so a query per row
    // is fine; if this ever gets slow, cache by category+dates.
    const rows = [];
    for (const r of result.rows) {
      const free = await freeRoomsInCategory(
        db, r.category, r.start_date, r.end_date
      );
      // Its own room isn't "free" (it's taken by this very reservation), so add
      // it back in and sort, otherwise it couldn't stay selected.
      const options = [
        ...free.map((f) => ({ id: f.id, number: f.number })),
        { id: r.room_id, number: r.room_number },
      ].sort((a, b) => a.number.localeCompare(b.number));

      rows.push({ ...r, room_options: options });
    }

    res.json(rows);
  } catch (err) {
    console.error("Error fetching reservations:", err.message);
    res.status(500).json({ error: "Could not fetch reservations" });
  }
});

// PATCH /api/reservation-rooms/:id — swap this reserved room for another.
// Body: { "room_id": 12 }
app.patch("/api/reservation-rooms/:id", async (req, res) => {
  const { id } = req.params;
  const newRoomId = Number(req.body.room_id);
  if (!newRoomId) return res.status(400).json({ error: "room_id is required" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const current = await client.query(
      `SELECT rr.*, res.start_date, res.end_date
         FROM reservation_rooms rr
         JOIN reservations res ON res.id = rr.reservation_id
        WHERE rr.id = $1`,
      [id]
    );
    if (current.rows.length === 0) throw new Error("Reservation room not found");
    const row = current.rows[0];

    // No-op if it's already that room.
    if (row.room_id === newRoomId) {
      await client.query("COMMIT");
      return res.json({ message: "No change" });
    }

    // The target must be free for these dates, and the same category.
    const free = await freeRoomsInCategory(
      client, row.category, row.start_date, row.end_date, true
    );
    if (!free.some((f) => f.id === newRoomId)) {
      throw new Error("That room isn't available for these dates");
    }

    const updated = await client.query(
      "UPDATE reservation_rooms SET room_id = $1 WHERE id = $2 RETURNING *",
      [newRoomId, id]
    );

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reassign room failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// DELETE /api/reservation-rooms/:id — cancel ONE reserved room.
//
// The row is deleted outright (no cancelled state). Its share of the money is
// refunded: the account balance goes back up, and the reservation's total comes
// down. Cancelling the last room removes the reservation header as well.
app.delete("/api/reservation-rooms/:id", async (req, res) => {
  const { id } = req.params;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
      `SELECT rr.id, rr.amount, rr.reservation_id, res.payment_method
         FROM reservation_rooms rr
         JOIN reservations res ON res.id = rr.reservation_id
        WHERE rr.id = $1`,
      [id]
    );
    if (found.rows.length === 0) throw new Error("Reservation room not found");
    const row = found.rows[0];
    const refund = Number(row.amount || 0);

    // 1. Remove the room.
    await client.query("DELETE FROM reservation_rooms WHERE id = $1", [id]);

    // 2. Put the money back on the account, if it was paid on one.
    if (row.payment_method && refund > 0) {
      const acct = await client.query(
        "SELECT id FROM accounts WHERE name = $1 FOR UPDATE",
        [row.payment_method]
      );
      if (acct.rows.length > 0) {
        await client.query(
          "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
          [refund, acct.rows[0].id]
        );
      }
    }

    // 3. Reduce the header's total.
    await client.query(
      "UPDATE reservations SET amount_paid = amount_paid - $1 WHERE id = $2",
      [refund, row.reservation_id]
    );
    // A refund is cash leaving — but only if cash came in originally. A tab
    // reservation was never cash, so cancelling it just restores the credit.
    const refundOnAccount = await client.query(
      "SELECT 1 FROM accounts WHERE name = $1", [row.payment_method]
    );
    if (refundOnAccount.rows.length === 0 && refund > 0) {
      await recordCashMovement(client, {
        moved_on: todayString(),
        direction: "out",
        kind: "refund",
        amount: refund,
        method: row.payment_method,
        description: "Reservation cancelled",
        source_type: "reservation",
        source_id: row.reservation_id,
      });
    }

    // 4. If that was the last room, drop the empty reservation.
    const left = await client.query(
      "SELECT COUNT(*) AS c FROM reservation_rooms WHERE reservation_id = $1",
      [row.reservation_id]
    );
    if (Number(left.rows[0].c) === 0) {
      await client.query("DELETE FROM reservations WHERE id = $1", [row.reservation_id]);
    }

    await client.query("COMMIT");
    res.json({ message: "Reservation cancelled", refunded: refund });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Cancel reservation failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/reservation-rooms/:id/checkin — turn ONE reserved room into a stay.
//
// Body: { "primary_guest_id": 3, "co_guest_ids": [4] }
//
// The reserver is not necessarily the guest, so the actual guest(s) are sent in.
// The reservation row is consumed: the stay is created, the room flips to
// Booked, and the reservation_rooms row is deleted (it now shows under Booked
// instead of on the Reservations table).
//
// IMPORTANT: this route does NOT charge an account. The money was taken when
// the reservation was made. The stay records payment_method as
// "Reservation #<id>" rather than the account name, so it can't be counted a
// second time by the account usage query (which matches on account name).
app.post("/api/reservation-rooms/:id/checkin", async (req, res) => {
  const { id } = req.params;
  const { primary_guest_id, co_guest_ids } = req.body;

  if (!primary_guest_id) {
    return res.status(400).json({ error: "primary_guest_id is required" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Pull the reserved room plus its reservation.
    const found = await client.query(
      `SELECT rr.id, rr.room_id, rr.amount, rr.reservation_id,
              res.start_date, res.end_date, res.payment_method
         FROM reservation_rooms rr
         JOIN reservations res ON res.id = rr.reservation_id
        WHERE rr.id = $1
        FOR UPDATE`,
      [id]
    );
    if (found.rows.length === 0) throw new Error("Reservation room not found");
    const row = found.rows[0];

    // The room must actually be free right now (nobody else in it).
    const active = await client.query(
      "SELECT 1 FROM stays WHERE room_id = $1 AND is_active = TRUE",
      [row.room_id]
    );
    if (active.rows.length > 0) {
      throw new Error("That room is currently occupied");
    }

    // 1. Create the stay. expected_checkout comes from the reservation's end
    //    date at noon WAT (11:00 UTC), matching how /api/checkin does it.
    const checkout = new Date(row.end_date);
    checkout.setUTCHours(11, 0, 0, 0);

    const stayResult = await client.query(
      `INSERT INTO stays (room_id, check_in, expected_checkout, amount_paid, payment_method, is_active)
       VALUES ($1, NOW(), $2, $3, $4, TRUE)
       RETURNING id`,
      [row.room_id, checkout, row.amount || 0, `Reservation #${row.reservation_id}`]
    );
    const stayId = stayResult.rows[0].id;

    // 2. Link the primary guest.
    await client.query(
      `INSERT INTO stay_guests (stay_id, guest_id, is_primary) VALUES ($1, $2, TRUE)`,
      [stayId, primary_guest_id]
    );

    // 3. Link any co-guests.
    for (const gid of co_guest_ids || []) {
      if (gid && gid !== primary_guest_id) {
        await client.query(
          `INSERT INTO stay_guests (stay_id, guest_id, is_primary) VALUES ($1, $2, FALSE)`,
          [stayId, gid]
        );
      }
    }

    // 4. Flip the room to Booked.
    await client.query("UPDATE rooms SET status = 'Booked' WHERE id = $1", [row.room_id]);

    // 5. Consume the reservation row.
    await client.query("DELETE FROM reservation_rooms WHERE id = $1", [id]);

    // 6. If that was the last room on the reservation, drop the empty header.
    const left = await client.query(
      "SELECT COUNT(*) AS c FROM reservation_rooms WHERE reservation_id = $1",
      [row.reservation_id]
    );
    if (Number(left.rows[0].c) === 0) {
      await client.query("DELETE FROM reservations WHERE id = $1", [row.reservation_id]);
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Guest checked in", stay_id: stayId });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Reservation check-in failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===========================================================================
// BAR — CATEGORIES & PRODUCTS
// ===========================================================================

// GET /api/bar-categories?bar_location=Kitchen
//
// With a location, only categories that actually HAVE products there — so the
// bar doesn't show "Main Course" and the kitchen doesn't show "Spirits".
// Derived from the products rather than stored on the category, so adding a
// dish to a new category is all it takes.
app.get("/api/bar-categories", async (req, res) => {
  try {
    const { bar_location } = req.query;

    const result = bar_location
      ? await db.query(
          `SELECT DISTINCT c.id, c.name
             FROM bar_categories c
             JOIN products p ON p.category_id = c.id
            WHERE p.bar_location = $1
            ORDER BY c.name`,
          [bar_location]
        )
      : await db.query("SELECT * FROM bar_categories ORDER BY name");

    res.json(result.rows);
  } catch (err) {
    console.error("Fetch bar categories failed:", err.message);
    res.status(500).json({ error: "Could not fetch categories" });
  }
});

// GET /api/products — drinks, optionally filtered by bar_location and/or
// category_id. Same "build the WHERE clause piece by piece" pattern as rooms.
//   /api/products?bar_location=Bar 1
//   /api/products?bar_location=Bar 1&category_id=2
app.get("/api/products", async (req, res) => {
  try {
    const { bar_location, category_id } = req.query;

    const conditions = [];
    const params = [];

    if (bar_location) {
      params.push(bar_location);
      conditions.push(`p.bar_location = $${params.length}`);
    }
    if (category_id) {
      params.push(category_id);
      conditions.push(`p.category_id = $${params.length}`);
    }
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Join to categories so each drink also carries its category NAME (handy
    // for the UI, which shows "Spirits" not the raw id).
    const result = await db.query(
      `SELECT p.*, c.name AS category_name
         FROM products p
         LEFT JOIN bar_categories c ON c.id = p.category_id
         ${whereClause}
         ORDER BY p.id`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching products:", err.message);
    res.status(500).json({ error: "Could not fetch products" });
  }
});

// GET /api/bar/activity?date=2026-08-14&bar_location=Bar%201
// A bar's day, for reviewing a shift and printing at handover.
//
// Same idea as the reception sheet: no new table, just the events that already
// exist — orders, stock requests, and faults — gathered into one ordered list.
app.get("/api/bar/activity", async (req, res) => {
  try {
    const date = req.query.date || todayString();
    const bar = req.query.bar_location || null;
    const next = "$1::date + 1";

    // --- Sales ---
    const orders = await db.query(
      `SELECT o.id, o.created_at AS at, o.total, o.payment_method, o.bar_location,
              (SELECT COALESCE(SUM(quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS items
         FROM orders o
        WHERE o.created_at >= $1::date AND o.created_at < ${next}
          AND ($2::text IS NULL OR o.bar_location = $2)
        ORDER BY o.created_at DESC`,
      [date, bar]
    );

    // --- Stock asked for, and stock that arrived ---
    const requests = await db.query(
      `SELECT r.id, r.created_at AS at, r.received_at, r.status, r.bar_location,
              (SELECT COUNT(*) FROM stock_request_items ri WHERE ri.request_id = r.id) AS lines
         FROM stock_requests r
        WHERE ($2::text IS NULL OR r.bar_location = $2)
          AND (
            (r.created_at  >= $1::date AND r.created_at  < ${next}) OR
            (r.received_at >= $1::date AND r.received_at < ${next})
          )`,
      [date, bar]
    );

    // --- Faults ---
    const issues = await db.query(
      `SELECT i.id, i.created_at AS at, i.issue, i.priority, i.location
         FROM issues i
        WHERE i.department = 'Bar'
          AND i.created_at >= $1::date AND i.created_at < ${next}
          AND ($2::text IS NULL OR i.location LIKE $2 || '%')`,
      [date, bar]
    );

    const inDay = (ts) =>
      ts && new Date(ts) >= new Date(`${date}T00:00:00`) &&
      new Date(ts) < new Date(`${date}T23:59:59.999`);

    const events = [
      ...orders.rows.map((o) => ({
        type: "Sale", at: o.at, place: o.bar_location,
        details: `${o.items} item${Number(o.items) === 1 ? "" : "s"} · ${o.payment_method || "—"}`,
        amount: Number(o.total), staff: "Bar",
      })),
      // A request can show twice in a day — asked in the morning, received in
      // the afternoon — and both are worth seeing.
      ...requests.rows
        .filter((r) => inDay(r.at))
        .map((r) => ({
          type: "Requested", at: r.at, place: r.bar_location,
          details: `${r.lines} item${Number(r.lines) === 1 ? "" : "s"} asked of the store`,
          amount: null, staff: "Bar",
        })),
      ...requests.rows
        .filter((r) => inDay(r.received_at))
        .map((r) => ({
          type: "Received", at: r.received_at, place: r.bar_location,
          details: `${r.lines} item${Number(r.lines) === 1 ? "" : "s"} arrived from the store`,
          amount: null, staff: "Bar",
        })),
      ...issues.rows.map((i) => ({
        type: "Issue", at: i.at, place: i.location,
        details: `${i.issue} · ${i.priority}`, amount: null, staff: "Bar",
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    const revenue = orders.rows.reduce((s, o) => s + Number(o.total), 0);
    const openReqs = requests.rows.filter((r) => r.status !== "Received").length;

    res.json({
      date,
      barLocation: bar,
      stats: {
        orders:    { value: orders.rows.length, note: "sales rung up" },
        revenue:   { value: revenue, note: "taken today", money: true },
        requested: { value: requests.rows.filter((r) => inDay(r.at)).length,
                     note: `${openReqs} still outstanding` },
        received:  { value: requests.rows.filter((r) => inDay(r.received_at)).length,
                     note: "deliveries confirmed" },
        issues:    { value: issues.rows.length, note: "faults reported" },
      },
      events,
    });
  } catch (err) {
    console.error("Bar activity failed:", err.message);
    res.status(500).json({ error: "Could not build the bar's activity" });
  }
});

// ===========================================================================
// BAR — CART (per bar; tapping a drink bumps its quantity)
// ===========================================================================

// GET /api/cart?bar_location=Bar 1 — that bar's current cart lines, each joined
// to its product so the panel can show name/price/unit and a line total.
app.get("/api/cart", async (req, res) => {
  try {
    const { bar_location } = req.query;
    if (!bar_location) {
      return res.status(400).json({ error: "bar_location is required" });
    }

    const result = await db.query(
      `SELECT ci.id, ci.quantity, ci.bar_location,
              p.id AS product_id, p.name, p.price, p.unit,
              (p.price * ci.quantity) AS line_total
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.bar_location = $1
        ORDER BY ci.id`,
      [bar_location]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching cart:", err.message);
    res.status(500).json({ error: "Could not fetch cart" });
  }
});

// POST /api/cart — add a drink to a bar's cart.
// If that drink is ALREADY in that bar's cart, we bump its quantity instead of
// adding a duplicate line (your chosen behaviour).
// Body: { "product_id": 3, "bar_location": "Bar 1" }
app.post("/api/cart", async (req, res) => {
  try {
    const { product_id, bar_location } = req.body;
    if (!product_id || !bar_location) {
      return res.status(400).json({ error: "product_id and bar_location are required" });
    }

    // Is this drink already in this bar's cart?
    const existing = await db.query(
      "SELECT id, quantity FROM cart_items WHERE product_id = $1 AND bar_location = $2",
      [product_id, bar_location]
    );

    let row;
    if (existing.rows.length > 0) {
      // Yes -> increase its quantity by 1.
      const updated = await db.query(
        "UPDATE cart_items SET quantity = quantity + 1 WHERE id = $1 RETURNING *",
        [existing.rows[0].id]
      );
      row = updated.rows[0];
    } else {
      // No -> insert a new line with quantity 1.
      const inserted = await db.query(
        `INSERT INTO cart_items (product_id, quantity, bar_location)
         VALUES ($1, 1, $2) RETURNING *`,
        [product_id, bar_location]
      );
      row = inserted.rows[0];
    }
    res.status(201).json(row);
  } catch (err) {
    console.error("Error adding to cart:", err.message);
    res.status(500).json({ error: "Could not add to cart" });
  }
});

// PATCH /api/cart/:id — set a cart line's quantity (the +/- steppers).
// If quantity drops to 0 or below, we remove the line entirely.
// Body: { "quantity": 3 }
app.patch("/api/cart/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { quantity } = req.body;

    if (quantity == null) {
      return res.status(400).json({ error: "quantity is required" });
    }

    if (quantity <= 0) {
      await db.query("DELETE FROM cart_items WHERE id = $1", [id]);
      return res.json({ message: "Item removed (quantity reached 0)" });
    }

    const result = await db.query(
      "UPDATE cart_items SET quantity = $1 WHERE id = $2 RETURNING *",
      [quantity, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cart item not found" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error updating cart item:", err.message);
    res.status(500).json({ error: "Could not update cart item" });
  }
});

// DELETE /api/cart/:id — remove a single line from the cart.
app.delete("/api/cart/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "DELETE FROM cart_items WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Cart item not found" });
    }
    res.json({ message: "Item removed" });
  } catch (err) {
    console.error("Error removing cart item:", err.message);
    res.status(500).json({ error: "Could not remove cart item" });
  }
});

// ===========================================================================
// BAR — CHECKOUT (Print Receipt): turn a bar's cart into an order, then clear
// ===========================================================================

// POST /api/checkout-order — save the bar's cart as a permanent order, then
// empty that bar's cart. Runs as ONE transaction: order + all its lines + the
// clearing either all succeed or all get undone.
// Body: { "bar_location": "Bar 1", "payment_method": "Cash" }
app.post("/api/checkout-order", async (req, res) => {
  const { bar_location, payment_method } = req.body;
  if (!bar_location) {
    return res.status(400).json({ error: "bar_location is required" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // 1. Grab the current cart (with each product's price) for this bar.
    const cart = await client.query(
      `SELECT ci.product_id, ci.quantity, p.price, p.name
         FROM cart_items ci
         JOIN products p ON p.id = ci.product_id
        WHERE ci.bar_location = $1`,
      [bar_location]
    );

    if (cart.rows.length === 0) {
      throw new Error("Cart is empty — nothing to check out");
    }

    // 2. Work out the total (sum of price × quantity for every line).
    const total = cart.rows.reduce(
      (sum, line) => sum + Number(line.price) * line.quantity,
      0
    );

// 2b. If paid on a company account, charge the tab (same rule as check-in).
    //     payment_method holds the account NAME when an account was chosen;
    //     Cash / Transfer / Card / POS match no account and skip this.
    if (payment_method) {
      const acct = await client.query(
        "SELECT id, balance, credit_limit, status FROM accounts WHERE name = $1 FOR UPDATE",
        [payment_method]
      );
      if (acct.rows.length > 0) {
        const account = acct.rows[0];
        if (account.status !== "Active") {
          throw new Error("This account is suspended and cannot be charged");
        }
        const newBalance = Number(account.balance) - total;
        if (newBalance < -Number(account.credit_limit)) {
          throw new Error("This account has insufficient credit for this order");
        }
        await client.query(
          "UPDATE accounts SET balance = balance - $1 WHERE id = $2",
          [total, account.id]
        );
      }
    }  

    // 3. Create the order (the "receipt" header).
    const orderResult = await client.query(
      `INSERT INTO orders (bar_location, total, payment_method)
       VALUES ($1, $2, $3) RETURNING id`,
      [bar_location, total, payment_method || null]
    );
    const orderId = orderResult.rows[0].id;

    // 4. Copy each cart line into order_items, capturing the price AT SALE TIME
    //    (so the receipt stays correct even if the drink's price changes later).
    for (const line of cart.rows) {
      await client.query(
        `INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, line.product_id, line.name, line.quantity, line.price]
      );
    }

    // 5. Empty this bar's cart.
    await client.query("DELETE FROM cart_items WHERE bar_location = $1", [
      bar_location,
    ]);

    // 6. Log the cash — but ONLY if real money changed hands. An order put on
    //    a company tab moved no cash; it becomes a debt, collected later (and
    //    logged then, by the deposit route).
    const barOnAccount = await client.query(
      "SELECT 1 FROM accounts WHERE name = $1", [payment_method]
    );
    if (barOnAccount.rows.length === 0) {
      await recordCashMovement(client, {
        moved_on: todayString(),
        direction: "in",
        kind: "sales_paid",
        amount: total,
        method: payment_method,
        description: `${bar_location} bar sale`,
        source_type: "order",
        source_id: orderId,
      });
    }

    await client.query("COMMIT");
    res.status(201).json({ message: "Order saved", order_id: orderId, total });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Checkout order failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===========================================================================
// ADMIN — ROOM MANAGEMENT (disable/activate, edit, guests-per-room)
// ===========================================================================

// PATCH /api/rooms/:id/disable — toggle a room's is_disabled flag.
// Body: { "is_disabled": true }   (send false to re-activate)
app.patch("/api/rooms/:id/disable", async (req, res) => {
  try {
    const { id } = req.params;
    const { is_disabled } = req.body;
    if (is_disabled == null) {
      return res.status(400).json({ error: "is_disabled (true/false) is required" });
    }
    const result = await db.query(
      "UPDATE rooms SET is_disabled = $1 WHERE id = $2 RETURNING *",
      [is_disabled, id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Room not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Disable room failed:", err.message);
    res.status(500).json({ error: "Could not update room" });
  }
});

// PATCH /api/rooms/:id — edit a room's details. Only the fields you send get
// updated (so you can change just the price, or just the category, etc.).
// Body (any subset): { "category": "VIP", "price": 70000, "status": "Available" }
app.patch("/api/rooms/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { number, category, price, status } = req.body;

    // Build the SET clause only from the fields that were actually provided.
    const updates = [];
    const params = [];
    if (number !== undefined)   { params.push(number);   updates.push(`number = $${params.length}`); }
    if (category !== undefined) { params.push(category); updates.push(`category = $${params.length}`); }
    if (price !== undefined)    { params.push(price);    updates.push(`price = $${params.length}`); }
    if (status !== undefined)   { params.push(status);   updates.push(`status = $${params.length}`); }

    if (updates.length === 0) {
      return res.status(400).json({ error: "No fields to update" });
    }

    // The id goes last, as the WHERE parameter.
    params.push(id);
    const result = await db.query(
      `UPDATE rooms SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Room not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Edit room failed:", err.message);
    res.status(500).json({ error: "Could not update room" });
  }
});

// GET /api/rooms/:id/guest-count — how many guests this room has had SO FAR
// (across all stays, active + past). COUNT + a JOIN: we count the stay_guests
// links belonging to every stay of this room.
app.get("/api/rooms/:id/guest-count", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      `SELECT COUNT(sg.id) AS guest_count
         FROM stays s
         JOIN stay_guests sg ON sg.stay_id = s.id
        WHERE s.room_id = $1`,
      [id]
    );
    // COUNT comes back as a string; make it a number for the frontend.
    res.json({ guest_count: Number(result.rows[0].guest_count) });
  } catch (err) {
    console.error("Guest count failed:", err.message);
    res.status(500).json({ error: "Could not fetch guest count" });
  }
});

// ===========================================================================
// ADMIN — BAR PRODUCT MANAGEMENT (add/edit product, add category)
// ===========================================================================

// POST /api/products — add a new drink.
// Body: { "name","price","category_id","bar_location","unit" }
app.post("/api/products", async (req, res) => {
  try {
    const { name, price, category_id, bar_location, unit } = req.body;
    if (!name || price == null || !bar_location) {
      return res.status(400).json({ error: "name, price and bar_location are required" });
    }
    const result = await db.query(
      `INSERT INTO products (name, price, category_id, bar_location, unit)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, price, category_id || null, bar_location, unit || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add product failed:", err.message);
    res.status(500).json({ error: "Could not add product" });
  }
});

// PATCH /api/products/:id — edit a drink (only the fields you send change).
app.patch("/api/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, category_id, bar_location, unit } = req.body;

    const updates = [];
    const params = [];
    if (name !== undefined)         { params.push(name);         updates.push(`name = $${params.length}`); }
    if (price !== undefined)        { params.push(price);        updates.push(`price = $${params.length}`); }
    if (category_id !== undefined)  { params.push(category_id);  updates.push(`category_id = $${params.length}`); }
    if (bar_location !== undefined) { params.push(bar_location); updates.push(`bar_location = $${params.length}`); }
    if (unit !== undefined)         { params.push(unit);         updates.push(`unit = $${params.length}`); }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const result = await db.query(
      `UPDATE products SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Product not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Edit product failed:", err.message);
    res.status(500).json({ error: "Could not update product" });
  }
});

// POST /api/bar-categories — add a new category. Blocks duplicate names.
// Body: { "name": "Whisky" }
app.post("/api/bar-categories", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim() === "") return res.status(400).json({ error: "name is required" });

    const existing = await db.query("SELECT * FROM bar_categories WHERE name ILIKE $1", [name]);
    if (existing.rows.length > 0) {
      return res.json({ ...existing.rows[0], already_existed: true });
    }
    const result = await db.query(
      "INSERT INTO bar_categories (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add category failed:", err.message);
    res.status(500).json({ error: "Could not add category" });
  }
});

// ===========================================================================
// ADMIN — REPORTS (reads the orders your bar checkout saves)
// ===========================================================================

// ===========================================================================
// STORE — CATEGORIES & STOCK
// ===========================================================================

// GET /api/stock-categories — the list of store categories (for the filter pills).
app.get("/api/stock-categories", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM stock_categories ORDER BY id");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching stock categories:", err.message);
    res.status(500).json({ error: "Could not fetch stock categories" });
  }
});

// POST /api/stock-categories — add a new category. Blocks duplicate names.
// Body: { "name": "Housekeeping" }
app.post("/api/stock-categories", async (req, res) => {
  try {
    const { name } = req.body;
    if (!name || name.trim() === "") return res.status(400).json({ error: "name is required" });

    const existing = await db.query("SELECT * FROM stock_categories WHERE name ILIKE $1", [name]);
    if (existing.rows.length > 0) {
      return res.json({ ...existing.rows[0], already_existed: true });
    }
    const result = await db.query(
      "INSERT INTO stock_categories (name) VALUES ($1) RETURNING *",
      [name]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add stock category failed:", err.message);
    res.status(500).json({ error: "Could not add stock category" });
  }
});

// GET /api/stock — stock items, optionally filtered by category_id.
// Same "build the WHERE clause piece by piece" pattern as /api/products.
//   /api/stock
//   /api/stock?category_id=2
app.get("/api/stock", async (req, res) => {
  try {
    const { category_id } = req.query;

    const conditions = [];
    const params = [];

    if (category_id) {
      params.push(category_id);
      conditions.push(`s.category_id = $${params.length}`);
    }
    const whereClause =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    // Join to categories so each item also carries its category NAME (the UI
    // shows "Beverage", not the raw id).
    const result = await db.query(
      `SELECT s.*, c.name AS category_name
         FROM stock_items s
         LEFT JOIN stock_categories c ON c.id = s.category_id
         ${whereClause}
         ORDER BY s.id`,
      params
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching stock:", err.message);
    res.status(500).json({ error: "Could not fetch stock" });
  }
});

// POST /api/stock — add a new stock item.
// Body: { "name","description","quantity","unit","category_id" }
app.post("/api/stock", async (req, res) => {
  try {
    const { name, description, quantity, unit, category_id } = req.body;
    if (!name || !unit) {
      return res.status(400).json({ error: "name and unit are required" });
    }
    const qty = Number(quantity ?? 0);
    if (!Number.isInteger(qty) || qty < 0) {
      return res.status(400).json({ error: "quantity must be a whole number, 0 or more" });
    }

    const result = await db.query(
      `INSERT INTO stock_items (name, description, quantity, unit, category_id)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [name, description || null, qty, unit, category_id || null]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add stock failed:", err.message);
    res.status(500).json({ error: "Could not add stock" });
  }
});

// PATCH /api/stock/:id — edit an item (only the fields you send change).
app.patch("/api/stock/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { description, unit, category_id } = req.body;

    if (quantity !== undefined) {
      const qty = Number(quantity);
      if (!Number.isInteger(qty) || qty < 0) {
        return res.status(400).json({ error: "quantity must be a whole number, 0 or more" });
      }
    }

    const updates = [];
    const params = [];
    
    if (description !== undefined) { params.push(description); updates.push(`description = $${params.length}`); }
    if (unit !== undefined)        { params.push(unit);        updates.push(`unit = $${params.length}`); }
    if (category_id !== undefined) { params.push(category_id); updates.push(`category_id = $${params.length}`); }
   
    params.push(id);
    const result = await db.query(
      `UPDATE stock_items SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Stock item not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Edit stock failed:", err.message);
    res.status(500).json({ error: "Could not update stock" });
  }
});

// GET /api/stock/activity?date=2026-08-14
// The store's day. Simpler than reception's or the bar's, because the store
// already records every movement in one place — this is stock_movements for
// the day, plus any faults reported.
app.get("/api/stock/activity", async (req, res) => {
  try {
    const date = req.query.date || todayString();
    const next = "$1::date + 1";

    // Every movement, with its lines rolled into one readable string.
    const movements = await db.query(
      `SELECT m.id, m.created_at AS at, m.direction, m.party, m.staff_name,
              (SELECT string_agg(s.name || ' — ' || mi.quantity || ' ' || mi.unit, ', ')
                 FROM stock_movement_items mi
                 JOIN stock_items s ON s.id = mi.stock_item_id
                WHERE mi.movement_id = m.id) AS items,
              (SELECT COALESCE(SUM(mi.quantity), 0)
                 FROM stock_movement_items mi WHERE mi.movement_id = m.id) AS units
         FROM stock_movements m
        WHERE m.created_at >= $1::date AND m.created_at < ${next}
        ORDER BY m.created_at DESC`,
      [date]
    );

    const issues = await db.query(
      `SELECT i.id, i.created_at AS at, i.issue, i.priority, i.location
         FROM issues i
        WHERE i.department = 'Store'
          AND i.created_at >= $1::date AND i.created_at < ${next}`,
      [date]
    );

    // The movement's own direction becomes the event name, so the sheet reads
    // the same language the storekeeper uses.
    const LABEL = { issue: "Issued", return: "Returned", topup: "Topped up" };

    const events = [
      ...movements.rows.map((m) => ({
        type: LABEL[m.direction] || m.direction,
        at: m.at,
        place: m.party || "—",
        details: m.items || "—",
        units: Number(m.units),
        staff: m.staff_name || "Store",
      })),
      ...issues.rows.map((i) => ({
        type: "Issue", at: i.at, place: i.location || "Store",
        details: `${i.issue} · ${i.priority}`, units: null, staff: "Store",
      })),
    ].sort((a, b) => new Date(b.at) - new Date(a.at));

    const count = (d) => movements.rows.filter((m) => m.direction === d).length;

    // What's running low, so the sheet ends with something actionable.
    const lowStock = await db.query(
      "SELECT COUNT(*) AS c FROM stock_items WHERE quantity < 10"
    );
    const openIssues = await db.query(
      `SELECT COUNT(*) AS c FROM issues
        WHERE department = 'Store' AND status <> 'Resolved'`
    );

    res.json({
      date,
      stats: {
        issued:   { value: count("issue"),  note: "sent out" },
        returned: { value: count("return"), note: "came back" },
        toppedUp: { value: count("topup"),  note: "restocked" },
        lowStock: { value: Number(lowStock.rows[0].c), note: "items under 10" },
        issues:   { value: issues.rows.length, note: `${openIssues.rows[0].c} still open` },
      },
      events,
    });
  } catch (err) {
    console.error("Store activity failed:", err.message);
    res.status(500).json({ error: "Could not build the store's activity" });
  }
});

// GET /api/reports/orders?limit=10 — the most recent orders (top of the list).
app.get("/api/reports/orders", async (req, res) => {
  try {
    const limit = Number(req.query.limit) || 10;
    const result = await db.query(
      `SELECT id, bar_location, total, payment_method, created_at
         FROM orders
        ORDER BY created_at DESC
        LIMIT $1`,
      [limit]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Reports orders failed:", err.message);
    res.status(500).json({ error: "Could not fetch orders" });
  }
});

// GET /api/orders/:id — one order plus its line items (for the "View" popup).
// Two queries: the order header, then its items joined to product names.
app.get("/api/orders/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const order = await db.query("SELECT * FROM orders WHERE id = $1", [id]);
    if (order.rows.length === 0) return res.status(404).json({ error: "Order not found" });

    const items = await db.query(
      `SELECT oi.quantity, oi.unit_price,
              COALESCE(oi.product_name, p.name) AS name
         FROM order_items oi
         LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = $1
        ORDER BY oi.id`,
      [id]
    );
    res.json({ ...order.rows[0], items: items.rows });
  } catch (err) {
    console.error("Order detail failed:", err.message);
    res.status(500).json({ error: "Could not fetch order" });
  }
});

// GET /api/reports/summary — headline numbers for the Reports tab.
// Several aggregates in one query:
//   COUNT(*)  -> how many orders
//   COALESCE(SUM(total),0) -> total revenue (COALESCE turns NULL into 0 when
//                             there are no orders yet)
//   COALESCE(MAX(total),0) -> the single highest-value order
app.get("/api/reports/summary", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         COUNT(*)                    AS order_count,
         COALESCE(SUM(total), 0)     AS total_revenue,
         COALESCE(MAX(total), 0)     AS highest_order
       FROM orders`
    );

    // Total drinks sold = sum of every order line's quantity. Lives in a
    // separate table (order_items), so it's its own small query.
    const drinks = await db.query(
      "SELECT COALESCE(SUM(quantity), 0) AS drinks_sold FROM order_items"
    );

    const row = result.rows[0];
    res.json({
      order_count: Number(row.order_count),
      total_revenue: Number(row.total_revenue),
      highest_order: Number(row.highest_order),
      drinks_sold: Number(drinks.rows[0].drinks_sold),
    });
  } catch (err) {
    console.error("Reports summary failed:", err.message);
    res.status(500).json({ error: "Could not fetch summary" });
  }
});

// GET /api/reports/revenue-by-bar — total order revenue per bar, for three
// time windows (daily = today, weekly = last 7 days, monthly = last 30 days).
//
// The clever bit: one query gets every bar's total for a window using
// GROUP BY bar_location. We run it three times (one per window) with a
// different date cutoff, then reshape into the { period, bar1, bar2, lounge,
// total } rows the table wants.
app.get("/api/reports/revenue-by-bar", async (req, res) => {
  try {
    // Helper: sum revenue per bar since a given interval (e.g. '1 day').
    // NOW() - INTERVAL '7 days' = the moment 7 days ago; we count orders after
    // that. Returns rows like { bar_location: 'Bar 1', revenue: 42000 }.
    async function revenueSince(interval) {
      const result = await db.query(
        `SELECT bar_location, COALESCE(SUM(total), 0) AS revenue
           FROM orders
          WHERE created_at >= NOW() - INTERVAL '${interval}'
          GROUP BY bar_location`
      );
      // Turn the rows into a quick lookup: { 'Bar 1': 42000, ... }
      const map = {};
      for (const r of result.rows) map[r.bar_location] = Number(r.revenue);
      return map;
    }

    const windows = [
      { period: "Daily", interval: "1 day" },
      { period: "Weekly", interval: "7 days" },
      { period: "Monthly", interval: "30 days" },
    ];

    const rows = [];
    for (const w of windows) {
      const map = await revenueSince(w.interval);
      const bar1 = map["Bar 1"] || 0;
      const bar2 = map["Bar 2"] || 0;
      const lounge = map["Lounge"] || 0;
      rows.push({
        period: w.period,
        bar1, bar2, lounge,
        total: bar1 + bar2 + lounge,
      });
    }

    res.json(rows);
  } catch (err) {
    console.error("Revenue by bar failed:", err.message);
    res.status(500).json({ error: "Could not fetch revenue by bar" });
  }
});

// ===========================================================================
// ADMIN — GUEST DATABASE (ranked by spend, paginated)
// ===========================================================================

app.get("/api/guests/ranked", async (req, res) => {
  try {
    const page = Math.max(1, Number(req.query.page) || 1);
    const pageSize = Number(req.query.pageSize) || 10;
    const offset = (page - 1) * pageSize;
    const search = (req.query.search ?? "").trim();

    // Optional name/phone filter, shared by the page query and the count.
    const whereClause = search ? `WHERE g.name ILIKE $3 OR g.phone ILIKE $3` : "";
    const pageParams = search
      ? [pageSize, offset, `%${search}%`]
      : [pageSize, offset];

    const result = await db.query(
      `SELECT g.id, g.name, g.email, g.phone,
              COALESCE(SUM(s.amount_paid), 0) AS total_spent,
              COUNT(DISTINCT s.id)            AS total_stays
         FROM guests g
         LEFT JOIN stay_guests sg ON sg.guest_id = g.id
         LEFT JOIN stays s        ON s.id = sg.stay_id
        ${whereClause}
        GROUP BY g.id
        ORDER BY total_spent DESC, g.name
        LIMIT $1 OFFSET $2`,
      pageParams
    );

    // Count must use the SAME filter so pagination is correct.
    const countResult = await db.query(
      `SELECT COUNT(*) AS total FROM guests g ${search ? "WHERE g.name ILIKE $1 OR g.phone ILIKE $1" : ""}`,
      search ? [`%${search}%`] : []
    );
    const totalGuests = Number(countResult.rows[0].total);

    res.json({
      page,
      pageSize,
      totalGuests,
      totalPages: Math.ceil(totalGuests / pageSize),
      guests: result.rows.map((r) => ({
        ...r,
        total_spent: Number(r.total_spent),
        total_stays: Number(r.total_stays),
      })),
    });
  } catch (err) {
    console.error("Ranked guests failed:", err.message);
    res.status(500).json({ error: "Could not fetch ranked guests" });
  }
});

// GET /api/guests/:id/profile — one guest's full profile: their details, every
// stay (with the room), and the co-guests on each stay. Powers "View Guest".
app.get("/api/guests/:id/profile", async (req, res) => {
  try {
    const { id } = req.params;

    const guest = await db.query("SELECT * FROM guests WHERE id = $1", [id]);
    if (guest.rows.length === 0) return res.status(404).json({ error: "Guest not found" });

    // Every stay this guest was part of, newest first, with the room number.
    const stays = await db.query(
      `SELECT s.id, s.check_in, s.check_out, s.amount_paid, s.payment_method,
              s.is_active, r.number AS room_number, r.category AS room_category
         FROM stays s
         JOIN stay_guests sg ON sg.stay_id = s.id
         JOIN rooms r        ON r.id = s.room_id
        WHERE sg.guest_id = $1
        ORDER BY s.check_in DESC NULLS LAST`,
      [id]
    );

    // For each of those stays, the OTHER guests on it (the co-guests).
    for (const stay of stays.rows) {
      const others = await db.query(
        `SELECT g.id, g.name, g.phone, sg.is_primary
           FROM stay_guests sg
           JOIN guests g ON g.id = sg.guest_id
          WHERE sg.stay_id = $1 AND g.id <> $2
          ORDER BY sg.is_primary DESC, g.name`,
        [stay.id, id]
      );
      stay.co_guests = others.rows;
    }

    res.json({ ...guest.rows[0], stays: stays.rows });
  } catch (err) {
    console.error("Guest profile failed:", err.message);
    res.status(500).json({ error: "Could not fetch guest profile" });
  }
});

// ===========================================================================
// ADMIN — DASHBOARD (the summary numbers + occupied rooms)
// ===========================================================================

// GET /api/dashboard/stats — headline figures for the admin dashboard.
// Three separate small queries, bundled into one response.

app.get("/api/dashboard/stats", async (req, res) => {
  try {
    // Occupied rooms = rooms with an ACTIVE stay (someone currently in them).
    const occupied = await db.query(
      "SELECT COUNT(*) AS c FROM stays WHERE is_active = TRUE"
    );

    // Guests currently checked in = people linked to an active stay.
    const currentGuests = await db.query(
      `SELECT COUNT(*) AS c
         FROM stay_guests sg
         JOIN stays s ON s.id = sg.stay_id
        WHERE s.is_active = TRUE`
    );

    // Current revenue = amount_paid on active stays (rooms only, no bar).
    const revenue = await db.query(
      "SELECT COALESCE(SUM(amount_paid), 0) AS total FROM stays WHERE is_active = TRUE"
    );

    res.json({
      occupied_rooms: Number(occupied.rows[0].c),
      current_guests: Number(currentGuests.rows[0].c),
      current_revenue: Number(revenue.rows[0].total),
    });
  } catch (err) {
    console.error("Dashboard stats failed:", err.message);
    res.status(500).json({ error: "Could not fetch dashboard stats" });
  }
});


// GET /api/dashboard/occupied-rooms — the rooms currently occupied, each with
// its primary guest and how many guests are in it.
app.get("/api/dashboard/occupied-rooms", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT r.id, r.number, r.category, r.status, s.amount_paid, s.check_in,
              (SELECT g.name
                 FROM stay_guests sg JOIN guests g ON g.id = sg.guest_id
                WHERE sg.stay_id = s.id AND sg.is_primary = TRUE
                LIMIT 1) AS primary_guest,
              (SELECT COUNT(*) FROM stay_guests sg WHERE sg.stay_id = s.id) AS guest_count
         FROM stays s
         JOIN rooms r ON r.id = s.room_id
        WHERE s.is_active = TRUE
        ORDER BY r.number`
    );
    res.json(result.rows.map((r) => ({ ...r, guest_count: Number(r.guest_count) })));
  } catch (err) {
    console.error("Occupied rooms failed:", err.message);
    res.status(500).json({ error: "Could not fetch occupied rooms" });
  }
});

// DELETE /api/products/:id — remove a drink.
// Safe thanks to the schema's delete rules: old order_items keep their data
// but lose the link (ON DELETE SET NULL), and any cart lines for it are
// removed (ON DELETE CASCADE). So past receipts stay intact.
app.delete("/api/products/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      "DELETE FROM products WHERE id = $1 RETURNING id",
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: "Product not found" });
    }
    res.json({ message: "Product deleted" });
  } catch (err) {
    console.error("Delete product failed:", err.message);
    res.status(500).json({ error: "Could not delete product" });
  }
});

// GET /api/dashboard/revenue-by-category — room booking revenue per room
// category, across Daily/Weekly/Monthly windows. Returns rows shaped for the
// dashboard's DataCard: { period, executive, premium, standard, total }.
// Note: the card's "premium" column = the "VIP" category in our database.
app.get("/api/dashboard/revenue-by-category", async (req, res) => {
  try {
    // Sum stay revenue per category for stays that CHECKED IN within a window.
    async function revenueSince(interval) {
      const result = await db.query(
        `SELECT r.category, COALESCE(SUM(s.amount_paid), 0) AS revenue
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
          WHERE s.check_in >= NOW() - INTERVAL '${interval}'
          GROUP BY r.category`
      );
      const map = {};
      for (const row of result.rows) map[row.category] = Number(row.revenue);
      return map;
    }

    const windows = [
      { period: "Daily", interval: "1 day" },
      { period: "Weekly", interval: "7 days" },
      { period: "Monthly", interval: "30 days" },
    ];

    const rows = [];
    for (const w of windows) {
      const m = await revenueSince(w.interval);
      const executive = m["Executive"] || 0;
      const premium = m["VIP"] || 0;        // card's "Premium" = our "VIP"
      const standard = m["Standard"] || 0;
      rows.push({
        period: w.period,
        executive: "₦" + executive.toLocaleString(),
        premium: "₦" + premium.toLocaleString(),
        standard: "₦" + standard.toLocaleString(),
        total: "₦" + (executive + premium + standard).toLocaleString(),
      });
    }
    res.json(rows);
  } catch (err) {
    console.error("Revenue by category failed:", err.message);
    res.status(500).json({ error: "Could not fetch revenue by category" });
  }
});

// GET /api/dashboard/occupancy-by-category — number of rooms in each category
// that were occupied (had a check-in) within Daily/Weekly/Monthly windows.
// Same row shape as above.
app.get("/api/dashboard/occupancy-by-category", async (req, res) => {
  try {
    // Count DISTINCT rooms per category that had a stay checked in within a
    // window (distinct so a room used twice in the period counts once).
    async function occupancySince(interval) {
      const result = await db.query(
        `SELECT r.category, COUNT(DISTINCT s.room_id) AS occupied
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
          WHERE s.check_in >= NOW() - INTERVAL '${interval}'
          GROUP BY r.category`
      );
      const map = {};
      for (const row of result.rows) map[row.category] = Number(row.occupied);
      return map;
    }

    const windows = [
      { period: "Daily", interval: "1 day" },
      { period: "Weekly", interval: "7 days" },
      { period: "Monthly", interval: "30 days" },
    ];

    const rows = [];
    for (const w of windows) {
      const m = await occupancySince(w.interval);
      const executive = m["Executive"] || 0;
      const premium = m["VIP"] || 0;
      const standard = m["Standard"] || 0;
      rows.push({
        period: w.period,
        executive: String(executive),
        premium: String(premium),
        standard: String(standard),
        total: String(executive + premium + standard),
      });
    }
    res.json(rows);
  } catch (err) {
    console.error("Occupancy by category failed:", err.message);
    res.status(500).json({ error: "Could not fetch occupancy by category" });
  }
});

// GET /api/rooms/status-counts?category=Executive&active_only=true
// Returns how many rooms are in each status, within a category. Reception
// passes active_only=true (to exclude disabled rooms, matching its list);
// admin omits it (counts every room). Uses the SAME flag as GET /api/rooms so
// the badges always agree with the list on that screen.
app.get("/api/rooms/status-counts", async (req, res) => {
  try {
    const { category, active_only } = req.query;

    const conditions = [];
    const params = [];

    if (category) {
      params.push(category);
      conditions.push(`r.category = $${params.length}`);
    }
    if (active_only === "true") {
      conditions.push(`r.is_disabled = FALSE`);
    }

    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    const result = await db.query(
      `SELECT r.status, s.expected_checkout
         FROM rooms r
         LEFT JOIN stays s ON s.room_id = r.id AND s.is_active = TRUE
        ${whereClause}`,
      params
    );

    // Tally by the COMPUTED status, so "1hr Left" and "Overdue" get their own
    // counts just like the panel expects.
    const counts = {};
    for (const row of result.rows) {
      const eff = effectiveRoomStatus(row.status, row.expected_checkout);
      counts[eff] = (counts[eff] || 0) + 1;
    }

    res.json(counts);
  } catch (err) {
    console.error("Status counts failed:", err.message);
    res.status(500).json({ error: "Could not fetch status counts" });
  }
});

// ===========================================================================
// STORE — MOVEMENTS (issue / return) + HISTORY
// ===========================================================================

// GET /api/stock-movements?date=2026-07-10 — one day's movements, newest first.
// Omit `date` to get the most recent 50 across all days.
app.get("/api/stock-movements", async (req, res) => {
  try {
    const { date } = req.query;

    if (date) {
      const result = await db.query(
        `SELECT * FROM stock_movements
          WHERE created_at::date = $1::date
          ORDER BY created_at DESC`,
        [date]
      );
      return res.json(result.rows);
    }

    const result = await db.query(
      "SELECT * FROM stock_movements ORDER BY created_at DESC LIMIT 50"
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching movements:", err.message);
    res.status(500).json({ error: "Could not fetch stock movements" });
  }
});

// GET /api/stock-movements/:id — one movement plus its lines (for the popup).
app.get("/api/stock-movements/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const head = await db.query("SELECT * FROM stock_movements WHERE id = $1", [id]);
    if (head.rows.length === 0) {
      return res.status(404).json({ error: "Movement not found" });
    }

    // Join to stock_items for the display name. A deleted item leaves the link
    // NULL (ON DELETE SET NULL), so the popup shows "Deleted item".
    const lines = await db.query(
      `SELECT mi.quantity, mi.unit, s.name
         FROM stock_movement_items mi
         LEFT JOIN stock_items s ON s.id = mi.stock_item_id
        WHERE mi.movement_id = $1
        ORDER BY mi.id`,
      [id]
    );

    res.json({ ...head.rows[0], items: lines.rows });
  } catch (err) {
    console.error("Error fetching movement:", err.message);
    res.status(500).json({ error: "Could not fetch movement" });
  }
});

// POST /api/stock-movements — record an issue or a return.
// Body: { direction, party, staff_name, items: [{ stock_item_id, quantity, unit }] }
//
// The insert and the quantity adjustment run in ONE transaction. If any line
// would take an item below zero we roll the whole thing back, so the store
// count can never drift away from the recorded history.
app.post("/api/stock-movements", async (req, res) => {
  const client = await db.connect();
  try {
    const { direction, party, staff_name, items } = req.body;

    if (direction !== "issue" && direction !== "return") {
      return res.status(400).json({ error: "direction must be 'issue' or 'return'" });
    }
    if (!party || party.trim() === "") {
      return res.status(400).json({ error: "party is required" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "at least one item is required" });
    }

    // Issuing takes stock out; returning puts it back.
    const sign = direction === "issue" ? -1 : 1;

    await client.query("BEGIN");

    const head = await client.query(
      `INSERT INTO stock_movements (direction, party, staff_name)
       VALUES ($1, $2, $3) RETURNING *`,
      [direction, party.trim(), staff_name || null]
    );
    const movement = head.rows[0];

    for (const line of items) {
      const qty = Number(line.quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error("Each line needs a whole quantity of 1 or more");
      }

      // Lock the row so two concurrent issues can't both pass the check below.
      const current = await client.query(
        "SELECT name, quantity FROM stock_items WHERE id = $1 FOR UPDATE",
        [line.stock_item_id]
      );
      if (current.rows.length === 0) {
        throw new Error(`Stock item ${line.stock_item_id} not found`);
      }

      const next = Number(current.rows[0].quantity) + sign * qty;
      if (next < 0) {
        throw new Error(
          `Only ${current.rows[0].quantity} of ${current.rows[0].name} in store`
        );
      }

      await client.query(
        "UPDATE stock_items SET quantity = $1 WHERE id = $2",
        [next, line.stock_item_id]
      );

      await client.query(
        `INSERT INTO stock_movement_items (movement_id, stock_item_id, quantity, unit)
         VALUES ($1, $2, $3, $4)`,
        [movement.id, line.stock_item_id, qty, line.unit]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(movement);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Stock movement failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/stock/:id/topup — add quantity to one item AND record it in history.
// Body: { "amount": 50, "staff_name": null }
// This is the stock equivalent of an account top-up: the quantity goes UP and a
// 'topup' movement row is written, in one transaction so they can't disagree.
app.post("/api/stock/:id/topup", async (req, res) => {
  const { id } = req.params;
  const amount = Number(req.body.amount);
  if (!Number.isInteger(amount) || amount <= 0) {
    return res.status(400).json({ error: "Top-up amount must be a whole number above zero" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock the item so two concurrent top-ups can't race on quantity.
    const item = await client.query(
      "SELECT id, name, unit, quantity FROM stock_items WHERE id = $1 FOR UPDATE",
      [id]
    );
    if (item.rows.length === 0) throw new Error("Stock item not found");
    const stock = item.rows[0];

    // 1. Write the movement header (direction 'topup'; party is the store).
    const head = await client.query(
      `INSERT INTO stock_movements (direction, party, staff_name)
       VALUES ('topup', 'Restock', $1) RETURNING id`,
      [req.body.staff_name || null]
    );

    // 2. Write the movement line.
    await client.query(
      `INSERT INTO stock_movement_items (movement_id, stock_item_id, quantity, unit)
       VALUES ($1, $2, $3, $4)`,
      [head.rows[0].id, stock.id, amount, stock.unit]
    );

    // 3. Bump the live quantity.
    const updated = await client.query(
      "UPDATE stock_items SET quantity = quantity + $1 WHERE id = $2 RETURNING *",
      [amount, id]
    );

    await client.query("COMMIT");
    res.status(201).json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Stock top-up failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===========================================================================
// ADMIN — CORPORATE ACCOUNTS
// ===========================================================================

// Helper: an account's Total Usage = everything charged to its tab. A charge is
// a stay or an order whose payment_method equals the account NAME (your design:
// the name is stored directly in payment_method). Returns a plain number.
// Helper: an account's Total Usage = everything charged to its tab — stays,
// bar orders, and reservations — matched on the account NAME stored in each
// table's payment_method column.
//
// Stays created FROM a reservation store "Reservation #<id>" instead of the
// account name, so the money is counted once here (at the reservation) and not
// again at check-in.
async function accountUsage(runner, accountName) {
  const stayUse = await runner.query(
    `SELECT COALESCE(SUM(amount_paid), 0) AS total
       FROM stays WHERE payment_method = $1`,
    [accountName]
  );
  const orderUse = await runner.query(
    `SELECT COALESCE(SUM(total), 0) AS total
       FROM orders WHERE payment_method = $1`,
    [accountName]
  );
  const resvUse = await runner.query(
    `SELECT COALESCE(SUM(amount_paid), 0) AS total
       FROM reservations WHERE payment_method = $1`,
    [accountName]
  );
  return (
    Number(stayUse.rows[0].total) +
    Number(orderUse.rows[0].total) +
    Number(resvUse.rows[0].total)
  );
}

// GET /api/accounts — all accounts, newest first. Feeds the card grid.
app.get("/api/accounts", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM accounts ORDER BY created_at DESC, id DESC");
    res.json(result.rows);
  } catch (err) {
    console.error("Error fetching accounts:", err.message);
    res.status(500).json({ error: "Could not fetch accounts" });
  }
});

// GET /api/accounts/stats — the two bento tiles.
//   total_capital  = sum of balance across ACTIVE accounts only
//   active_count / suspended_count = row counts by status
app.get("/api/accounts/stats", async (req, res) => {
  try {
    const cap = await db.query(
      `SELECT COALESCE(SUM(balance), 0) AS total_capital
         FROM accounts WHERE status = 'Active'`
    );
    const counts = await db.query(
      `SELECT
         COUNT(*) FILTER (WHERE status = 'Active')    AS active_count,
         COUNT(*) FILTER (WHERE status = 'Suspended') AS suspended_count
       FROM accounts`
    );
    res.json({
      total_capital: Number(cap.rows[0].total_capital),
      active_count: Number(counts.rows[0].active_count),
      suspended_count: Number(counts.rows[0].suspended_count),
    });
  } catch (err) {
    console.error("Error fetching account stats:", err.message);
    res.status(500).json({ error: "Could not fetch account stats" });
  }
});

// GET /api/accounts/:id — one account row (for Edit + Top-up to prefill).
app.get("/api/accounts/:id", async (req, res) => {
  try {
    const result = await db.query("SELECT * FROM accounts WHERE id = $1", [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Error fetching account:", err.message);
    res.status(500).json({ error: "Could not fetch account" });
  }
});

// GET /api/accounts/:id/summary — everything the View popup needs:
// the account, the three financial figures, and the merged transaction list.
app.get("/api/accounts/:id/summary", async (req, res) => {
  try {
    const { id } = req.params;
    const acc = await db.query("SELECT * FROM accounts WHERE id = $1", [id]);
    if (acc.rows.length === 0) return res.status(404).json({ error: "Account not found" });
    const account = acc.rows[0];

    // Total Deposited = sum of every deposit row.
    const dep = await db.query(
      "SELECT COALESCE(SUM(amount), 0) AS total FROM account_deposits WHERE account_id = $1",
      [id]
    );
    const totalDeposited = Number(dep.rows[0].total);

    // Total Usage = charges against this account's name.
    const totalUsage = await accountUsage(db, account.name);

    // Transaction history: deposits (money in) + charges (money out), newest
    // first. Deposits come from account_deposits; charges from stays + orders.
    const deposits = await db.query(
      `SELECT amount, note, created_at
         FROM account_deposits WHERE account_id = $1`,
      [id]
    );
    const stayCharges = await db.query(
      `SELECT s.id AS stay_id, s.amount_paid AS amount, s.created_at,
              r.number AS room_number
         FROM stays s
         JOIN rooms r ON r.id = s.room_id
        WHERE s.payment_method = $1`,
      [account.name]
    );
    const orderCharges = await db.query(
      `SELECT id AS order_id, total AS amount, created_at, bar_location
         FROM orders WHERE payment_method = $1`,
      [account.name]
    );

    // Reservations charged to this account (money taken up front).
    const resvCharges = await db.query(
      `SELECT r.id AS reservation_id, r.amount_paid AS amount, r.created_at,
              r.start_date, r.end_date,
              (SELECT COUNT(*) FROM reservation_rooms rr WHERE rr.reservation_id = r.id) AS room_count
         FROM reservations r
        WHERE r.payment_method = $1`,
      [account.name]
    );

    const transactions = [
      ...deposits.rows.map((d) => ({
        type: "deposit",
        label: d.note ? `Deposit - ${d.note}` : "Deposit",
        amount: Number(d.amount),
        created_at: d.created_at,
        // deposit popup reads these directly (no extra fetch needed):
        note: d.note,
      })),
      ...stayCharges.rows.map((s) => ({
        type: "room",
        label: `Room Booking - ${s.room_number}`,
        amount: Number(s.amount),
        created_at: s.created_at,
        ref_id: s.stay_id,        // <-- open View-Guest by STAY id
      })),
      ...orderCharges.rows.map((o) => ({
        type: "order",
        label: `Bar Order - ${o.bar_location}`,
        amount: Number(o.amount),
        created_at: o.created_at,
        ref_id: o.order_id,       // <-- open Bar Order Details by ORDER id
      })),
      ...resvCharges.rows.map((r) => ({
        type: "reservation",
        label: `Reservation - ${r.room_count} room${Number(r.room_count) === 1 ? "" : "s"}`,
        amount: Number(r.amount),
        created_at: r.created_at,
        ref_id: r.reservation_id,
      })),
    ].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

    res.json({
      ...account,
      total_deposited: totalDeposited,
      total_usage: totalUsage,
      // Outstanding = how far below zero the balance is (0 if in credit).
      outstanding: Number(account.balance) < 0 ? Math.abs(Number(account.balance)) : 0,
      transactions,
    });
  } catch (err) {
    console.error("Account summary failed:", err.message);
    res.status(500).json({ error: "Could not fetch account summary" });
  }
});

// POST /api/accounts — create an account. The opening balance seeds BOTH the
// stored balance AND the first deposit row, in one transaction so they agree.
app.post("/api/accounts", async (req, res) => {
  const {
    name, credit_limit, opening_balance, status,
    contact_personnel, phone, email,
  } = req.body;

  if (!name || name.trim() === "") {
    return res.status(400).json({ error: "Organization name is required" });
  }
  const limit = Number(credit_limit ?? 0);
  const opening = Number(opening_balance ?? 0);
  if (Number.isNaN(limit) || limit < 0) return res.status(400).json({ error: "Invalid credit limit" });
  if (Number.isNaN(opening) || opening < 0) return res.status(400).json({ error: "Invalid opening balance" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const created = await client.query(
      `INSERT INTO accounts (name, credit_limit, balance, status, contact_personnel, phone, email)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [name.trim(), limit, opening, status || "Active",
       contact_personnel || null, phone || null, email || null]
    );
    const account = created.rows[0];

    if (opening > 0) {
      await client.query(
        `INSERT INTO account_deposits (account_id, amount, note)
         VALUES ($1, $2, 'Opening balance')`,
        [account.id, opening]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(account);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create account failed:", err.message);
    // Unique-violation on name gives a friendlier message.
    if (err.code === "23505") {
      return res.status(400).json({ error: "An account with that name already exists" });
    }
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/accounts/:id — edit credit limit, status, contact info.
// NOTE: name and balance are intentionally NOT editable here (name links to
// charges; balance only moves via deposits or charges).
app.patch("/api/accounts/:id", async (req, res) => {
  try {
    const { id } = req.params;
    const { credit_limit, status, contact_personnel, phone, email } = req.body;

    if (credit_limit !== undefined) {
      const limit = Number(credit_limit);
      if (Number.isNaN(limit) || limit < 0) return res.status(400).json({ error: "Invalid credit limit" });
    }

    const updates = [];
    const params = [];
    if (credit_limit !== undefined)      { params.push(credit_limit);      updates.push(`credit_limit = $${params.length}`); }
    if (status !== undefined)            { params.push(status);            updates.push(`status = $${params.length}`); }
    if (contact_personnel !== undefined) { params.push(contact_personnel); updates.push(`contact_personnel = $${params.length}`); }
    if (phone !== undefined)             { params.push(phone);             updates.push(`phone = $${params.length}`); }
    if (email !== undefined)             { params.push(email);             updates.push(`email = $${params.length}`); }

    if (updates.length === 0) return res.status(400).json({ error: "No fields to update" });

    params.push(id);
    const result = await db.query(
      `UPDATE accounts SET ${updates.join(", ")} WHERE id = $${params.length} RETURNING *`,
      params
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Update account failed:", err.message);
    res.status(500).json({ error: "Could not update account" });
  }
});

// PATCH /api/accounts/:id/status — flip Active <-> Suspended (the summary
// popup's Disable/Enable button). Body: { "status": "Suspended" }
app.patch("/api/accounts/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (status !== "Active" && status !== "Suspended") {
      return res.status(400).json({ error: "status must be 'Active' or 'Suspended'" });
    }
    const result = await db.query(
      "UPDATE accounts SET status = $1 WHERE id = $2 RETURNING *",
      [status, req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: "Account not found" });
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Set account status failed:", err.message);
    res.status(500).json({ error: "Could not update status" });
  }
});

// POST /api/accounts/:id/deposit — a top-up. Adds a deposit row AND bumps the
// stored balance, in one transaction. Body: { "amount": 500000 }
app.post("/api/accounts/:id/deposit", async (req, res) => {
  const { id } = req.params;
  const amount = Number(req.body.amount);
  if (Number.isNaN(amount) || amount <= 0) {
    return res.status(400).json({ error: "Deposit amount must be greater than zero" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock the account row so two concurrent deposits can't race on balance.
    const acc = await client.query("SELECT * FROM accounts WHERE id = $1 FOR UPDATE", [id]);
    if (acc.rows.length === 0) throw new Error("Account not found");

    await client.query(
      `INSERT INTO account_deposits (account_id, amount, note)
       VALUES ($1, $2, 'Top-up')`,
      [id, amount]
    );
    const updated = await client.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2 RETURNING *",
      [amount, id]
    );

    // The deposit is cash arriving — log it.
    await recordCashMovement(client, {
      moved_on: todayString(),
      direction: "in",
      kind: "debt_collected",
      amount,
      method: req.body.method || "Transfer",
      description: `Account top-up — ${acc.rows[0].name}`,
      source_type: "deposit",
      source_id: id,
    });

    await client.query("COMMIT");
    res.status(201).json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Deposit failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ===========================================================================
// ACCOUNTING — shared helpers
// ===========================================================================

const MONTH_NAMES = ["Jan","Feb","Mar","Apr","May","Jun",
                     "Jul","Aug","Sep","Oct","Nov","Dec"];

// The fixed payment methods. Anything else in a payment_method column is the
// NAME of a corporate account — which is how we tell an unpaid sale from a
// paid one, the same rule the frontend uses.
const FIXED_METHODS = ["Cash", "Direct Bank Transfer", "Bank Transfer", "Card", "POS", "Transfer"];

// Every account name, so we can spot sales that went on a tab.
async function accountNames(runner) {
  const r = await runner.query("SELECT name FROM accounts");
  return r.rows.map((x) => x.name);
}

// Sum rows into a 12-slot array indexed by month (0 = Jan).
// `rows` must carry a `m` column (1-12) and a `total`.
function byMonth(rows) {
  const out = Array(12).fill(0);
  for (const r of rows) out[Number(r.m) - 1] = Number(r.total);
  return out;
}

// ===========================================================================
// ACCOUNTING — OVERVIEW
// ===========================================================================

// GET /api/accounting/overview?year=2026
// The 22-column table. Assembled from several simple queries rather than one
// giant one — easier to read and to change when a column is added.
app.get("/api/accounting/overview", async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const names = await accountNames(db);
    // Postgres can't take an empty array in = ANY(), so guard it.
    const acctList = names.length ? names : ["\u0000none\u0000"];

    // --- Sales: rooms, by month of check-in ---
    const rooms = await db.query(
      `SELECT EXTRACT(MONTH FROM check_in) AS m, COALESCE(SUM(amount_paid),0) AS total
         FROM stays
        WHERE EXTRACT(YEAR FROM check_in) = $1
        GROUP BY 1`, [year]);

        // --- Sales: bar, by month (the kitchen is counted separately) ---
    const bar = await db.query(
      `SELECT EXTRACT(MONTH FROM created_at) AS m, COALESCE(SUM(total),0) AS total
         FROM orders
        WHERE EXTRACT(YEAR FROM created_at) = $1 AND bar_location <> 'Kitchen'
        GROUP BY 1`, [year]);

    // --- Sales: kitchen ---
    const kitchen = await db.query(
      `SELECT EXTRACT(MONTH FROM created_at) AS m, COALESCE(SUM(total),0) AS total
         FROM orders
        WHERE EXTRACT(YEAR FROM created_at) = $1 AND bar_location = 'Kitchen'
        GROUP BY 1`, [year]);

    // --- Sales owed: anything that went on a corporate tab ---
    const owedStays = await db.query(
      `SELECT EXTRACT(MONTH FROM check_in) AS m, COALESCE(SUM(amount_paid),0) AS total
         FROM stays
        WHERE EXTRACT(YEAR FROM check_in) = $1 AND payment_method = ANY($2)
        GROUP BY 1`, [year, acctList]);
    const owedOrders = await db.query(
      `SELECT EXTRACT(MONTH FROM created_at) AS m, COALESCE(SUM(total),0) AS total
         FROM orders
        WHERE EXTRACT(YEAR FROM created_at) = $1 AND payment_method = ANY($2)
        GROUP BY 1`, [year, acctList]);

    // --- Expenses incurred (voided excluded) ---
    const expenses = await db.query(
      `SELECT EXTRACT(MONTH FROM spend_date) AS m, COALESCE(SUM(amount),0) AS total
         FROM expenses
        WHERE EXTRACT(YEAR FROM spend_date) = $1 AND voided = FALSE
        GROUP BY 1`, [year]);

    // --- The nine cash columns, in one pass over the money log ---
    const cash = await db.query(
      `SELECT EXTRACT(MONTH FROM moved_on) AS m, kind, COALESCE(SUM(amount),0) AS total
         FROM cash_movements
        WHERE EXTRACT(YEAR FROM moved_on) = $1
        GROUP BY 1, 2`, [year]);

    const cashByKind = {};
    for (const row of cash.rows) {
      cashByKind[row.kind] = cashByKind[row.kind] || Array(12).fill(0);
      cashByKind[row.kind][Number(row.m) - 1] = Number(row.total);
    }
    const kind = (k) => cashByKind[k] || Array(12).fill(0);

    // --- Cash balance: a running sum of the whole log, month by month.
    //     Everything BEFORE this year is the opening position.
    const opening = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS total
         FROM cash_movements
        WHERE moved_on < $1::date`, [`${year}-01-01`]);

    const netByMonth = await db.query(
      `SELECT EXTRACT(MONTH FROM moved_on) AS m,
              COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS total
         FROM cash_movements
        WHERE EXTRACT(YEAR FROM moved_on) = $1
        GROUP BY 1`, [year]);

    const monthlyNet = byMonth(netByMonth.rows);
    const cashBalances = [];
    let running = Number(opening.rows[0].total);
    for (let i = 0; i < 12; i++) {
      running += monthlyNet[i];
      cashBalances.push(running);
    }

    // --- Debt balance: what's owed on tabs at each month end. An account's
    //     balance going negative IS the debt, so we read it from accounts.
    const debt = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),0) AS total
         FROM accounts`);
    const debtNow = Number(debt.rows[0].total);

    const roomsArr = byMonth(rooms.rows);
    const barArr = byMonth(bar.rows);
    const kitchenArr = byMonth(kitchen.rows);
    const owedArr = byMonth(owedStays.rows).map(
      (v, i) => v + byMonth(owedOrders.rows)[i]);
    const expArr = byMonth(expenses.rows);

    const months = MONTH_NAMES.map((name, i) => ({
      month: name,
      rooms: roomsArr[i],
      bar: barArr[i],
      kitchen: kitchenArr[i],
      salesOwed: owedArr[i],
      expenses: expArr[i],
      salesPaid: kind("sales_paid")[i],
      oldDebt: kind("debt_collected")[i],
      futDep: kind("deposit")[i],
      addOnsIn: kind("addon")[i],
      expPaid: kind("expense_paid")[i],
      pastExpSet: kind("expense_settled")[i],
      expPre: kind("expense_prepaid")[i],
      addOnsOut: kind("outgoing")[i],
      refunds: kind("refund")[i],
      cashBal: cashBalances[i],
      debtBal: debtNow,   // a point-in-time figure; same for every row for now
    }));

    res.json({ year, months });
  } catch (err) {
    console.error("Accounting overview failed:", err.message);
    res.status(500).json({ error: "Could not build the overview" });
  }
});

// GET /api/accounting/overview/daily?year=2026&month=8
//
// The same 22 columns as the yearly overview, but one row per DAY of one month.
// This is what the View link on a month row expands into.
//
// Deliberately mirrors the yearly route's shape so the frontend can run both
// through the same derive() function — the daily rows and the monthly row they
// sit under are computed identically and can't disagree.
app.get("/api/accounting/overview/daily", async (req, res) => {
  try {
    const year = Number(req.query.year) || new Date().getFullYear();
    const month = Number(req.query.month);
    if (!month || month < 1 || month > 12) {
      return res.status(400).json({ error: "month must be 1-12" });
    }

    const names = await accountNames(db);
    const acctList = names.length ? names : ["\u0000none\u0000"];

    const first = `${year}-${String(month).padStart(2, "0")}-01`;
    // Day 0 of the NEXT month is the last day of this one.
    const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const afterLast = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);

    // Same idea as byMonth(), but across the days of one month.
    const byDay = (rows) => {
      const out = Array(daysInMonth).fill(0);
      for (const r of rows) out[Number(r.d) - 1] = Number(r.total);
      return out;
    };

    const rooms = await db.query(
      `SELECT EXTRACT(DAY FROM check_in) AS d, COALESCE(SUM(amount_paid),0) AS total
         FROM stays WHERE check_in >= $1::date AND check_in < $2::date GROUP BY 1`,
      [first, afterLast]);

    // Drinks only — the kitchen is counted separately below.
    const bar = await db.query(
      `SELECT EXTRACT(DAY FROM created_at) AS d, COALESCE(SUM(total),0) AS total
         FROM orders
        WHERE created_at >= $1::date AND created_at < $2::date
          AND bar_location <> 'Kitchen'
        GROUP BY 1`,
      [first, afterLast]);

    const kitchen = await db.query(
      `SELECT EXTRACT(DAY FROM created_at) AS d, COALESCE(SUM(total),0) AS total
         FROM orders
        WHERE created_at >= $1::date AND created_at < $2::date
          AND bar_location = 'Kitchen'
        GROUP BY 1`,
      [first, afterLast]);

    const owedStays = await db.query(
      `SELECT EXTRACT(DAY FROM check_in) AS d, COALESCE(SUM(amount_paid),0) AS total
         FROM stays
        WHERE check_in >= $1::date AND check_in < $2::date AND payment_method = ANY($3)
        GROUP BY 1`, [first, afterLast, acctList]);

    const owedOrders = await db.query(
      `SELECT EXTRACT(DAY FROM created_at) AS d, COALESCE(SUM(total),0) AS total
         FROM orders
        WHERE created_at >= $1::date AND created_at < $2::date AND payment_method = ANY($3)
        GROUP BY 1`, [first, afterLast, acctList]);

    const expenses = await db.query(
      `SELECT EXTRACT(DAY FROM spend_date) AS d, COALESCE(SUM(amount),0) AS total
         FROM expenses
        WHERE spend_date >= $1::date AND spend_date < $2::date AND voided = FALSE
        GROUP BY 1`, [first, afterLast]);

    const cash = await db.query(
      `SELECT EXTRACT(DAY FROM moved_on) AS d, kind, COALESCE(SUM(amount),0) AS total
         FROM cash_movements
        WHERE moved_on >= $1::date AND moved_on < $2::date
        GROUP BY 1, 2`, [first, afterLast]);

    const cashByKind = {};
    for (const row of cash.rows) {
      cashByKind[row.kind] = cashByKind[row.kind] || Array(daysInMonth).fill(0);
      cashByKind[row.kind][Number(row.d) - 1] = Number(row.total);
    }
    const kind = (k) => cashByKind[k] || Array(daysInMonth).fill(0);

    // Cash balance runs on from everything before this month.
    const opening = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS total
         FROM cash_movements WHERE moved_on < $1::date`, [first]);

    const dailyNet = await db.query(
      `SELECT EXTRACT(DAY FROM moved_on) AS d,
              COALESCE(SUM(CASE WHEN direction='in' THEN amount ELSE -amount END),0) AS total
         FROM cash_movements
        WHERE moved_on >= $1::date AND moved_on < $2::date
        GROUP BY 1`, [first, afterLast]);

    const nets = byDay(dailyNet.rows);
    const balances = [];
    let running = Number(opening.rows[0].total);
    for (let i = 0; i < daysInMonth; i++) {
      running += nets[i];
      balances.push(running);
    }

    const debt = await db.query(
      `SELECT COALESCE(SUM(CASE WHEN balance < 0 THEN -balance ELSE 0 END),0) AS total
         FROM accounts`);
    const debtNow = Number(debt.rows[0].total);

    const roomsArr = byDay(rooms.rows);
    const barArr = byDay(bar.rows);
    const kitchenArr = byDay(kitchen.rows);
    const owedA = byDay(owedStays.rows);
    const owedB = byDay(owedOrders.rows);
    const expArr = byDay(expenses.rows);

    const days = Array.from({ length: daysInMonth }, (_, i) => ({
      // The frontend prints this as the row label, so send it ready to show.
      month: String(i + 1),
      date: `${year}-${String(month).padStart(2, "0")}-${String(i + 1).padStart(2, "0")}`,
      rooms: roomsArr[i],
      bar: barArr[i],
      kitchen: kitchenArr[i],
      salesOwed: owedA[i] + owedB[i],
      expenses: expArr[i],
      salesPaid: kind("sales_paid")[i],
      oldDebt: kind("debt_collected")[i],
      futDep: kind("deposit")[i],
      addOnsIn: kind("addon")[i],
      expPaid: kind("expense_paid")[i],
      pastExpSet: kind("expense_settled")[i],
      expPre: kind("expense_prepaid")[i],
      addOnsOut: kind("outgoing")[i],
      refunds: kind("refund")[i],
      cashBal: balances[i],
      debtBal: debtNow,
    }));

    res.json({ year, month, days });
  } catch (err) {
    console.error("Daily overview failed:", err.message);
    res.status(500).json({ error: "Could not build the daily breakdown" });
  }
});


// ===========================================================================
// ACCOUNTING — SALES
// ===========================================================================

// GET /api/accounting/sales?department=&from=&to=&status=
// Merges stays and orders in Node (same approach as the account summary).
app.get("/api/accounting/sales", async (req, res) => {
  try {
    const { department, from, to, status } = req.query;
    const names = await accountNames(db);
    const isUnpaid = (method) => names.includes(method);

    const rows = [];

    // --- Room sales, with their guests ---
    if (!department || department === "All" || department === "Rooms") {
      const stays = await db.query(
        `SELECT s.id, s.check_in, s.check_out, s.expected_checkout,
                s.amount_paid, s.payment_method, r.number AS room_number
           FROM stays s
           JOIN rooms r ON r.id = s.room_id
          WHERE ($1::date IS NULL OR s.check_in >= $1::date)
            AND ($2::date IS NULL OR s.check_in < ($2::date + 1))
          ORDER BY s.check_in DESC`,
        [from || null, to || null]
      );

      for (const s of stays.rows) {
        const guests = await db.query(
          `SELECT g.name, g.phone, g.email, g.address, sg.is_primary
             FROM stay_guests sg JOIN guests g ON g.id = sg.guest_id
            WHERE sg.stay_id = $1
            ORDER BY sg.is_primary DESC, g.id`,
          [s.id]
        );
        const nights = s.expected_checkout && s.check_in
          ? Math.max(1, Math.round(
              (new Date(s.expected_checkout) - new Date(s.check_in)) / 86400000))
          : null;

        rows.push({
          id: `stay-${s.id}`, refId: s.id, source: "Rooms",
          date: toDateString(s.check_in),
          time: s.check_in
            ? new Date(s.check_in).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })
            : "",
          description: `${s.room_number}${nights ? ` · ${nights} night${nights === 1 ? "" : "s"}` : ""}`,
          payment: s.payment_method || "—",
          amount: Number(s.amount_paid),
          unpaid: isUnpaid(s.payment_method),
          room: s.room_number, nights,
          checkIn: s.check_in, checkOut: s.expected_checkout,
          guests: guests.rows,
        });
      }
    }

    // --- Bar sales ---
    // One query for both — same table, the filter just decides which
    // locations count.
    if (!department || department === "All" || department === "Bar" || department === "Kitchen") {
      const orders = await db.query(
        `SELECT o.id, o.bar_location, o.total, o.payment_method, o.created_at,
                (SELECT COALESCE(SUM(quantity),0) FROM order_items oi WHERE oi.order_id = o.id) AS items
           FROM orders o
          WHERE ($1::date IS NULL OR o.created_at >= $1::date)
            AND ($2::date IS NULL OR o.created_at < ($2::date + 1))
            -- $3 is null for "All", so both bar and kitchen orders come back.
            AND ($3::text IS NULL
                 OR ($3 = 'Kitchen' AND o.bar_location =  'Kitchen')
                 OR ($3 = 'Bar'     AND o.bar_location <> 'Kitchen'))
          ORDER BY o.created_at DESC`,
        [from || null, to || null,
         department === "Bar" || department === "Kitchen" ? department : null]
      );

      for (const o of orders.rows) {
        rows.push({
          id: `order-${o.id}`, refId: o.id,
          // The row must say which counter it came from, or a kitchen sale
          // would show as a bar sale on the Sales page.
          source: o.bar_location === "Kitchen" ? "Kitchen" : "Bar",
          date: toDateString(o.created_at),
          time: new Date(o.created_at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }),
          description: `${o.bar_location} · ${o.items} item${Number(o.items) === 1 ? "" : "s"}`,
          payment: o.payment_method || "—",
          amount: Number(o.total),
          unpaid: isUnpaid(o.payment_method),
        });
      }
    }

    // Status filter last, since `unpaid` is derived above.
    let out = rows;
    if (status === "Paid") out = out.filter((r) => !r.unpaid);
    if (status === "Unpaid") out = out.filter((r) => r.unpaid);

    out.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    res.json(out);
  } catch (err) {
    console.error("Accounting sales failed:", err.message);
    res.status(500).json({ error: "Could not fetch sales" });
  }
});

// ===========================================================================
// ACCOUNTING — CASH
// ===========================================================================

// GET /api/accounting/cash?direction=&kind=&from=&to=
//
// The running balance is computed over EVERY movement up to `to`, and only then
// are the filters applied. A balance summed over filtered rows would be
// meaningless.
app.get("/api/accounting/cash", async (req, res) => {
  try {
    const { direction, kind, from, to } = req.query;

    const all = await db.query(
      `SELECT cm.*, c.name AS category_name
         FROM cash_movements cm
         LEFT JOIN acct_categories c ON c.id = cm.category_id
        WHERE ($1::date IS NULL OR cm.moved_on <= $1::date)
        ORDER BY cm.moved_on ASC, cm.id ASC`,
      [to || null]
    );

    // Oldest first, so the running balance builds correctly.
    let running = 0;
    const withBalance = all.rows.map((m) => {
      running += m.direction === "in" ? Number(m.amount) : -Number(m.amount);
      return { ...m, balance: running };
    });

    // Human labels for the kinds, matching the UI.
    const KIND_LABEL = {
      sales_paid: "Sales Paid", debt_collected: "Debt Collected",
      deposit: "Deposits", addon: "Add-on",
      expense_paid: "Expenses Paid", expense_settled: "Expenses Settled",
      expense_prepaid: "Prepaid Expenses", outgoing: "Out-going", refund: "Refund",
    };

    let out = withBalance
      .filter((m) => {
        if (direction && direction !== "All" && m.direction !== direction) return false;
        if (kind && kind !== "All" && KIND_LABEL[m.kind] !== kind) return false;
        if (from && new Date(m.moved_on) < new Date(from)) return false;
        return true;
      })
      .map((m) => ({
        id: m.id,
        date: toDateString(m.moved_on),
        time: new Date(m.created_at).toLocaleTimeString("en-GB", {
          hour: "numeric", minute: "2-digit", hour12: true,
        }),
        direction: m.direction,
        type: KIND_LABEL[m.kind] || m.kind,
        description: m.description || m.category_name || "—",
        method: m.method || "—",
        amount: Number(m.amount),
        balance: m.balance,
        staff: m.recorded_by || "—",
        link: m.source_type
          ? { label: `${m.source_type} #${String(m.source_id).padStart(6, "0")}`,
              kind: m.source_type, refId: m.source_id }
          : null,
      }));

    out.reverse();          // newest first for display
    res.json(out);
  } catch (err) {
    console.error("Accounting cash failed:", err.message);
    res.status(500).json({ error: "Could not fetch cash movements" });
  }
});

// ===========================================================================
// ACCOUNTING — EXPENSES
// ===========================================================================

// GET /api/accounting/expenses?from=&to=&category=&q=
// The main table: expenses paid at the time they were incurred, plus voided
// ones (shown greyed). Unpaid ones live behind the Expenses Card — see below.
app.get("/api/accounting/expenses", async (req, res) => {
  try {
    const { from, to, category, q } = req.query;

    const result = await db.query(
      `SELECT e.*, c.name AS category_name,
              (SELECT method FROM cash_movements cm
                WHERE cm.source_type = 'expense' AND cm.source_id = e.id
                ORDER BY cm.id LIMIT 1) AS method
         FROM expenses e
         LEFT JOIN acct_categories c ON c.id = e.category_id
        WHERE e.is_unpaid = FALSE
          AND ($1::date IS NULL OR e.spend_date >= $1::date)
          AND ($2::date IS NULL OR e.spend_date <= $2::date)
          AND ($3::text IS NULL OR c.name = $3)
          AND ($4::text IS NULL OR e.description ILIKE '%'||$4||'%' OR e.vendor ILIKE '%'||$4||'%')
        ORDER BY e.spend_date DESC, e.id DESC`,
      [from || null, to || null,
       category && category !== "All Categories" ? category : null,
       q || null]
    );

    res.json(result.rows.map((e) => ({
      id: e.id,
      spendDate: toDateString(e.spend_date),
      category: e.category_name || "—",
      description: e.description,
      vendor: e.vendor || "—",
      amount: Number(e.amount),
      method: e.method || "—",
      recordedBy: e.recorded_by || "—",
      recordedOn: new Date(e.created_at).toLocaleDateString("en-GB", {
        day: "numeric", month: "short",
      }),
      voided: e.voided,
      voidReason: e.void_reason,
    })));
  } catch (err) {
    console.error("Expenses fetch failed:", err.message);
    res.status(500).json({ error: "Could not fetch expenses" });
  }
});

// GET /api/accounting/expenses/unpaid — what's on the Expenses Card.
// `paid` is summed from the money log, so it can't drift from real payments.
app.get("/api/accounting/expenses/unpaid", async (req, res) => {
  try {
    const result = await db.query(
      `SELECT e.*, c.name AS category_name,
              COALESCE((SELECT SUM(cm.amount) FROM cash_movements cm
                         WHERE cm.source_type = 'expense' AND cm.source_id = e.id), 0) AS paid
         FROM expenses e
         LEFT JOIN acct_categories c ON c.id = e.category_id
          WHERE e.is_unpaid = TRUE AND e.voided = FALSE
        ORDER BY e.spend_date DESC, e.id DESC`
    );

    const items = result.rows.map((e) => ({
      id: e.id,
      spendDate: toDateString(e.spend_date),
      category: e.category_name || "—",
      description: e.description,
      vendor: e.vendor || "—",
      amount: Number(e.amount),
      paid: Number(e.paid),
      outstanding: Number(e.amount) - Number(e.paid),
    }));

        res.json({
      totalOutstanding: items.reduce((s, i) => s + i.outstanding, 0),
      count: items.length,
      // The list is newest-first now, so the oldest is the last one — don't
      // assume position, take the minimum.
      oldest: items.length
        ? items.reduce((a, b) => (a.spendDate < b.spendDate ? a : b)).spendDate
        : null,
      items,
    });
  } catch (err) {
    console.error("Unpaid expenses fetch failed:", err.message);
    res.status(500).json({ error: "Could not fetch unpaid expenses" });
  }
});

// GET /api/accounting/categories?type=expense|addon|outgoing
app.get("/api/accounting/categories", async (req, res) => {
  try {
    const { type } = req.query;
    const result = await db.query(
      `SELECT * FROM acct_categories
        WHERE ($1::text IS NULL OR type = $1)
        ORDER BY type, name`,
      [type || null]
    );
    res.json(result.rows);
  } catch (err) {
    console.error("Categories fetch failed:", err.message);
    res.status(500).json({ error: "Could not fetch categories" });
  }
});

// ===========================================================================
// ACCOUNTING — the one writer for the money log
// ===========================================================================

// Every movement of cash goes through here. Nothing inserts into
// cash_movements directly — that's what keeps the log complete and consistent,
// and it's the single place to change if the log ever gains a column.
//
// `client` is a transaction client (from db.connect()), so the movement lands
// or rolls back together with whatever caused it.
async function recordCashMovement(client, {
  moved_on, direction, kind, amount, method,
  description, category_id, source_type, source_id, recorded_by,
}) {
  if (direction !== "in" && direction !== "out") {
    throw new Error("direction must be 'in' or 'out'");
  }
  const value = Number(amount);
  if (Number.isNaN(value) || value <= 0) {
    throw new Error("A cash movement needs an amount above zero");
  }

  const result = await client.query(
    `INSERT INTO cash_movements
       (moved_on, direction, kind, amount, method, description,
        category_id, source_type, source_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING *`,
    [moved_on, direction, kind, value, method || null, description || null,
     category_id || null, source_type || null, source_id || null,
     recorded_by || "Admin"]
  );
  return result.rows[0];
}

// ===========================================================================
// ACCOUNTING — WRITES
// ===========================================================================

// POST /api/accounting/categories — add a category to one of the three lists.
// Body: { "name": "Diesel", "type": "expense" }
app.post("/api/accounting/categories", async (req, res) => {
  try {
    const { name, type } = req.body;
    if (!name || name.trim() === "") {
      return res.status(400).json({ error: "name is required" });
    }
    if (!["expense", "addon", "outgoing"].includes(type)) {
      return res.status(400).json({ error: "type must be expense, addon or outgoing" });
    }

    // The same name can exist under a different type, so check the pair.
    const existing = await db.query(
      "SELECT * FROM acct_categories WHERE name ILIKE $1 AND type = $2",
      [name.trim(), type]
    );
    if (existing.rows.length > 0) {
      return res.json({ ...existing.rows[0], already_existed: true });
    }

    const result = await db.query(
      "INSERT INTO acct_categories (name, type) VALUES ($1, $2) RETURNING *",
      [name.trim(), type]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error("Add category failed:", err.message);
    res.status(500).json({ error: "Could not add category" });
  }
});

// POST /api/accounting/expenses — record an expense.
//
// Body: { spend_date, category_id, description, vendor, amount, method }
//
// TWO SHAPES, decided by `method`:
//   "Expenses Card"        -> the cost is recorded, is_unpaid = TRUE, and NO
//                             cash movement is written. The money hasn't moved.
//   Cash / Transfer / POS  -> the cost AND an expense_paid movement, together.
//
// That split is the whole reason `expenses` and `cash_movements` are separate
// tables, and why the Overview can show "Expenses" and "Expenses Paid" as
// different numbers.
app.post("/api/accounting/expenses", async (req, res) => {
  const { spend_date, category_id, description, vendor, amount, method } = req.body;

  if (!spend_date) return res.status(400).json({ error: "spend_date is required" });
  if (!description || description.trim() === "") {
    return res.status(400).json({ error: "description is required" });
  }
  const value = Number(amount);
  if (Number.isNaN(value) || value <= 0) {
    return res.status(400).json({ error: "amount must be above zero" });
  }

  const unpaid = method === "Expenses Card";

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const exp = await client.query(
      `INSERT INTO expenses
         (spend_date, category_id, description, vendor, amount, is_unpaid, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [spend_date, category_id || null, description.trim(), vendor || null,
       value, unpaid, req.body.recorded_by || "Admin"]
    );
    const expense = exp.rows[0];

        if (!unpaid) {
      // The COST belongs to spend_date, but the CASH left today. When those
      // differ — you're paying ahead of when the cost is due — it's a prepaid
      // expense, and the movement is dated today rather than in the future.
      //
      // Without this, paying now for a cost dated next week would log cash
      // leaving on a day that hasn't happened, and the running cash balance
      // would be wrong until that day arrived.
      const today = todayString();
      const prepaid = spend_date > today;

      await recordCashMovement(client, {
        moved_on: prepaid ? today : spend_date,
        direction: "out",
        kind: prepaid ? "expense_prepaid" : "expense_paid",
        amount: value,
        method,
        description: description.trim(),
        category_id: category_id || null,
        source_type: "expense",
        source_id: expense.id,
        recorded_by: req.body.recorded_by || "Admin",
      });
    }

    await client.query("COMMIT");
    res.status(201).json(expense);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Add expense failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/accounting/expenses/:id/pay — settle an unpaid expense, fully or
// partly. Body: { "amount": 200000, "method": "Transfer" }
//
// Writes an expense_settled movement. When the final payment lands, is_unpaid
// flips to FALSE and the expense moves off the card into the paid table.
app.post("/api/accounting/expenses/:id/pay", async (req, res) => {
  const { id } = req.params;
  const { method } = req.body;
  const value = Number(req.body.amount);

  if (Number.isNaN(value) || value <= 0) {
    return res.status(400).json({ error: "amount must be above zero" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    // Lock it so two people can't overpay the same expense at once.
    const found = await client.query(
      `SELECT e.*, COALESCE((SELECT SUM(cm.amount) FROM cash_movements cm
                              WHERE cm.source_type='expense' AND cm.source_id = e.id), 0) AS paid
         FROM expenses e WHERE e.id = $1 FOR UPDATE`,
      [id]
    );
    if (found.rows.length === 0) throw new Error("Expense not found");
    const e = found.rows[0];
    if (!e.is_unpaid) throw new Error("That expense is already settled");

    const outstanding = Number(e.amount) - Number(e.paid);
    if (value > outstanding) {
      throw new Error(`Only ${outstanding} is still owed on that expense`);
    }

    await recordCashMovement(client, {
      moved_on: todayString(),
      direction: "out",
      kind: "expense_settled",
      amount: value,
      method,
      description: `${e.description} (settlement)`,
      category_id: e.category_id,
      source_type: "expense",
      source_id: e.id,
      recorded_by: req.body.recorded_by || "Admin",
    });

    // Fully settled? It leaves the card.
    if (value === outstanding) {
      await client.query("UPDATE expenses SET is_unpaid = FALSE WHERE id = $1", [id]);
    }

    await client.query("COMMIT");
    res.json({
      message: "Payment recorded",
      paid: Number(e.paid) + value,
      outstanding: outstanding - value,
    });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Expense payment failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// POST /api/accounting/movements — a manual add-on or out-going.
//
// These are the only movements with no source elsewhere in the system: someone
// typed them in. That's why the Cash popup's "Linked Record" section is absent
// on these and present on everything else.
//
// Body: { direction, date, amount, method, category_id, description }
app.post("/api/accounting/movements", async (req, res) => {
  const { direction, date, amount, method, category_id, description } = req.body;

  if (direction !== "in" && direction !== "out") {
    return res.status(400).json({ error: "direction must be 'in' or 'out'" });
  }
  const value = Number(amount);
  if (Number.isNaN(value) || value <= 0) {
    return res.status(400).json({ error: "amount must be above zero" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const movement = await recordCashMovement(client, {
      moved_on: date || todayString(),
      direction,
      kind: direction === "in" ? "addon" : "outgoing",
      amount: value,
      method,
      description,
      category_id,
      recorded_by: req.body.recorded_by || "Admin",
    });

    await client.query("COMMIT");
    res.status(201).json(movement);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Movement failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/accounting/expenses/:id/void — void a same-day expense.
// Body: { "reason": "Amount entered incorrectly" }
//
// The expense row STAYS (greyed in the UI, with its reason) so the history
// shows what was corrected. Its cash movement is DELETED, because the money
// never actually left — a reversing entry would show two puzzling rows in the
// cashbook for what was really a typo.
app.patch("/api/accounting/expenses/:id/void", async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  if (!reason || reason.trim() === "") {
    return res.status(400).json({ error: "A reason is required to void an expense" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query("SELECT * FROM expenses WHERE id = $1 FOR UPDATE", [id]);
    if (found.rows.length === 0) throw new Error("Expense not found");
    const e = found.rows[0];
    if (e.voided) throw new Error("That expense is already voided");

    // Same-day only.
    const enteredOn = toDateString(e.created_at);
    const today = todayString();
    if (enteredOn !== today) {
      throw new Error("An expense can only be voided on the day it was recorded");
    }

    await client.query(
      `UPDATE expenses
          SET voided = TRUE, void_reason = $1, voided_at = NOW(), is_unpaid = FALSE
        WHERE id = $2`,
      [reason.trim(), id]
    );

    // The cash never moved, so the log shouldn't say it did.
    await client.query(
      "DELETE FROM cash_movements WHERE source_type = 'expense' AND source_id = $1",
      [id]
    );

    await client.query("COMMIT");
    res.json({ message: "Expense voided" });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Void failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------------
// START THE SERVER
// ---------------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`\n✅ Server running at http://localhost:${PORT}`);
  console.log(`   Rooms endpoint: http://localhost:${PORT}/api/rooms\n`);
});

// ===========================================================================
// STOCK REQUESTS — bar asks the store for supplies
// ===========================================================================

// GET /api/stock-requests?bar_location=Bar%201
// Every request, newest first, with its lines and a status tally.
app.get("/api/stock-requests", async (req, res) => {
  try {
    const { bar_location } = req.query;

    const reqs = await db.query(
      `SELECT * FROM stock_requests
        WHERE ($1::text IS NULL OR bar_location = $1)
        ORDER BY created_at DESC`,
      [bar_location || null]
    );

    // All the lines in one query, then grouped — one query per request would
    // be a round trip per row.
    const ids = reqs.rows.map((r) => r.id);
    const lines = ids.length
      ? await db.query(
          `SELECT ri.*, s.name
             FROM stock_request_items ri
             JOIN stock_items s ON s.id = ri.stock_item_id
            WHERE ri.request_id = ANY($1)
            ORDER BY ri.id`,
          [ids]
        )
      : { rows: [] };

    const byRequest = {};
    for (const l of lines.rows) {
      (byRequest[l.request_id] = byRequest[l.request_id] || []).push({
        id: l.id, name: l.name, quantity: l.quantity, unit: l.unit,
      });
    }

    const counts = { Pending: 0, Delivered: 0, Received: 0 };
    for (const r of reqs.rows) counts[r.status] = (counts[r.status] || 0) + 1;

    res.json({
      // The badge counts what still needs doing — received requests are closed.
      openCount: counts.Pending + counts.Delivered,
      counts,
      requests: reqs.rows.map((r) => ({
        id: r.id,
        barLocation: r.bar_location,
        status: r.status,
        note: r.note,
        createdAt: r.created_at,
        deliveredAt: r.delivered_at,
        receivedAt: r.received_at,
        items: byRequest[r.id] || [],
      })),
    });
  } catch (err) {
    console.error("Fetch stock requests failed:", err.message);
    res.status(500).json({ error: "Could not fetch requests" });
  }
});

// POST /api/stock-requests — the bar asks for supplies.
// Body: { bar_location, note, items: [{ stock_item_id, quantity, unit }] }
//
// Asking takes nothing out of the store — that happens on delivery.
app.post("/api/stock-requests", async (req, res) => {
  const { bar_location, note, items } = req.body;

  if (!bar_location) return res.status(400).json({ error: "bar_location is required" });
  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "Add at least one item to the request" });
  }

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const head = await client.query(
      `INSERT INTO stock_requests (bar_location, note, requested_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [bar_location, note || null, req.body.requested_by || "Bar"]
    );

    for (const line of items) {
      const qty = Number(line.quantity);
      if (!Number.isInteger(qty) || qty <= 0) {
        throw new Error("Every line needs a whole quantity of 1 or more");
      }
      await client.query(
        `INSERT INTO stock_request_items (request_id, stock_item_id, quantity, unit)
         VALUES ($1, $2, $3, $4)`,
        [head.rows[0].id, line.stock_item_id, qty, line.unit]
      );
    }

    await client.query("COMMIT");
    res.status(201).json(head.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Create stock request failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/stock-requests/:id/deliver — the store sends it.
//
// THIS is where store stock actually drops. It writes a normal stock movement
// (direction 'issue', party = the bar) so the store's own history shows the
// goods leaving, exactly as if the storekeeper had issued them by hand. One
// transaction: the movement, the quantities and the status all land together.
app.patch("/api/stock-requests/:id/deliver", async (req, res) => {
  const { id } = req.params;

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const head = await client.query(
      "SELECT * FROM stock_requests WHERE id = $1 FOR UPDATE", [id]
    );
    if (head.rows.length === 0) throw new Error("Request not found");
    if (head.rows[0].status !== "Pending") {
      throw new Error("That request has already been delivered");
    }

    const lines = await client.query(
      "SELECT * FROM stock_request_items WHERE request_id = $1", [id]
    );

    // One movement header for the whole delivery.
    const movement = await client.query(
      `INSERT INTO stock_movements (direction, party, staff_name)
       VALUES ('issue', $1, $2) RETURNING id`,
      [head.rows[0].bar_location, req.body.staff_name || "Store"]
    );

    for (const line of lines.rows) {
      // Lock the item so two deliveries can't both pass the check below.
      const item = await client.query(
        "SELECT name, quantity FROM stock_items WHERE id = $1 FOR UPDATE",
        [line.stock_item_id]
      );
      if (item.rows.length === 0) throw new Error("A requested item no longer exists");

      const remaining = Number(item.rows[0].quantity) - Number(line.quantity);
      if (remaining < 0) {
        throw new Error(
          `Only ${item.rows[0].quantity} of ${item.rows[0].name} in store`
        );
      }

      await client.query(
        "UPDATE stock_items SET quantity = $1 WHERE id = $2",
        [remaining, line.stock_item_id]
      );
      await client.query(
        `INSERT INTO stock_movement_items (movement_id, stock_item_id, quantity, unit)
         VALUES ($1, $2, $3, $4)`,
        [movement.rows[0].id, line.stock_item_id, line.quantity, line.unit]
      );
    }

    const updated = await client.query(
      `UPDATE stock_requests SET status = 'Delivered', delivered_at = NOW()
        WHERE id = $1 RETURNING *`,
      [id]
    );

    await client.query("COMMIT");
    res.json(updated.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Deliver request failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/stock-requests/:id/receive — the bar confirms it arrived.
//
// Nothing moves here: the stock already left the store on delivery. This is an
// acknowledgement, and the gap between the two timestamps is what tells you
// whether something went astray on the way.
app.patch("/api/stock-requests/:id/receive", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE stock_requests SET status = 'Received', received_at = NOW()
        WHERE id = $1 AND status = 'Delivered' RETURNING *`,
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Only a delivered request can be received" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Receive request failed:", err.message);
    res.status(500).json({ error: "Could not confirm receipt" });
  }
});

// ===========================================================================
// MAINTENANCE — money requests against reported faults
// ===========================================================================

// GET /api/maintenance/requests?status=Pending
// Every request, newest first, with its fault and what was spent.
app.get("/api/maintenance/requests", async (req, res) => {
  try {
    const { status } = req.query;
    const result = await db.query(
      `SELECT mr.*,
              i.issue, i.priority, i.department, i.status AS issue_status,
              COALESCE(r.number, i.location) AS place,
              e.amount AS expense_amount, e.is_unpaid
         FROM maintenance_requests mr
         JOIN issues i ON i.id = mr.issue_id
         LEFT JOIN rooms r ON r.id = i.room_id
         LEFT JOIN expenses e ON e.id = mr.expense_id
        WHERE ($1::text IS NULL OR mr.status = $1)
        ORDER BY mr.created_at DESC`,
      [status || null]
    );

    const counts = { Pending: 0, Approved: 0, Declined: 0 };
    for (const r of result.rows) counts[r.status] = (counts[r.status] || 0) + 1;

    res.json({
      pendingCount: counts.Pending,
      counts,
      requests: result.rows.map((r) => ({
        id: r.id,
        issueId: r.issue_id,
        issue: r.issue,
        priority: r.priority,
        department: r.department,
        place: r.place || "—",
        issueStatus: r.issue_status,
        amount: Number(r.amount),
        reason: r.reason,
        status: r.status,
        requestedBy: r.requested_by,
        decidedBy: r.decided_by,
        createdAt: r.created_at,
        // Whether the approved expense was settled or put on the card.
        onCard: r.is_unpaid === true,
      })),
    });
  } catch (err) {
    console.error("Fetch maintenance requests failed:", err.message);
    res.status(500).json({ error: "Could not fetch requests" });
  }
});

// POST /api/issues/:id/requests — maintenance asks for money to fix a fault.
// Body: { amount, reason }
app.post("/api/issues/:id/requests", async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    const { reason } = req.body;

    if (Number.isNaN(amount) || amount <= 0) {
      return res.status(400).json({ error: "Enter an amount above zero" });
    }
    if (!reason || reason.trim() === "") {
      return res.status(400).json({ error: "Say what the money is for" });
    }

    const issue = await db.query("SELECT id FROM issues WHERE id = $1", [req.params.id]);
    if (issue.rows.length === 0) return res.status(404).json({ error: "Fault not found" });

        const result = await db.query(
      `INSERT INTO maintenance_requests (issue_id, amount, reason, requested_by)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.params.id, amount, reason.trim(), req.body.requested_by || "Maintenance"]
    );

    // Asking for money IS starting work, so the fault moves itself along.
    // Deriving it this way means nobody has to remember a "Start Work" button,
    // and the state can't drift from what's actually happening.
    await db.query(
      `UPDATE issues SET status = 'In Progress'
        WHERE id = $1 AND status = 'Received'`,
      [req.params.id]
    );

    res.status(201).json(result.rows[0]);

  } catch (err) {
    console.error("Create maintenance request failed:", err.message);
    res.status(400).json({ error: err.message });
  }
});

// PATCH /api/maintenance/requests/:id/approve — the admin releases the money.
//
// Body: { category_id, method }
//   method "Cash" | "Transfer" | "POS"  -> the expense is PAID, and a cash
//                                          movement is written
//   method "Expenses Card"              -> the expense is recorded UNPAID and
//                                          lands on the card
//
// Approving is what creates the expense — so the money and the fault can never
// drift apart, and nobody retypes what the report already says.
app.patch("/api/maintenance/requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { category_id, method } = req.body;

  if (!method) return res.status(400).json({ error: "Choose how it's being paid" });

  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const found = await client.query(
        `SELECT mr.*, i.issue, i.status AS issue_status,
          COALESCE(r.number, i.location) AS place
         FROM maintenance_requests mr
         JOIN issues i ON i.id = mr.issue_id
         LEFT JOIN rooms r ON r.id = i.room_id
          WHERE mr.id = $1
          FOR UPDATE OF mr`,
      [id]
    );
    if (found.rows.length === 0) throw new Error("Request not found");
    const rq = found.rows[0];
    
    if (rq.status !== "Pending") throw new Error("That request has already been decided");
    // The fault may have been resolved since this screen was opened.
    if (rq.issue_status === "Resolved") {
      throw new Error("That fault has already been resolved — no money is needed");
    }

    const unpaid = method === "Expenses Card";
    const today = todayString();

    // The description writes itself from the fault and the reason, so the
    // expense reads back as what it actually was.
    const description = `${rq.place} — ${rq.issue} (${rq.reason})`;

    const exp = await client.query(
      `INSERT INTO expenses
         (spend_date, category_id, description, vendor, amount, is_unpaid, recorded_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [today, category_id || null, description, req.body.vendor || null,
       rq.amount, unpaid, req.body.decided_by || "Admin"]
    );

    if (!unpaid) {
      await recordCashMovement(client, {
        moved_on: today,
        direction: "out",
        kind: "expense_paid",
        amount: rq.amount,
        method,
        description,
        category_id: category_id || null,
        source_type: "expense",
        source_id: exp.rows[0].id,
        recorded_by: req.body.decided_by || "Admin",
      });
    }

    const updated = await client.query(
      `UPDATE maintenance_requests
          SET status = 'Approved', decided_at = NOW(), decided_by = $1, expense_id = $2
        WHERE id = $3 RETURNING *`,
      [req.body.decided_by || "Admin", exp.rows[0].id, id]
    );

    await client.query("COMMIT");
    res.json({ request: updated.rows[0], expense: exp.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Approve request failed:", err.message);
    res.status(400).json({ error: err.message });
  } finally {
    client.release();
  }
});

// PATCH /api/maintenance/requests/:id/decline — no money. Nothing is created.
app.patch("/api/maintenance/requests/:id/decline", async (req, res) => {
  try {
    const result = await db.query(
      `UPDATE maintenance_requests
          SET status = 'Declined', decided_at = NOW(), decided_by = $1
        WHERE id = $2 AND status = 'Pending' RETURNING *`,
      [req.body.decided_by || "Admin", req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(400).json({ error: "Only a pending request can be declined" });
    }
    res.json(result.rows[0]);
  } catch (err) {
    console.error("Decline request failed:", err.message);
    res.status(500).json({ error: "Could not decline the request" });
  }
});