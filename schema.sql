-- schema.sql — the full database structure for the Ception hotel management app.
--
-- Every statement uses "IF NOT EXISTS", so running this file again won't error
-- and won't duplicate anything.
--
-- ⚠️  IMPORTANT — "IF NOT EXISTS" only protects against a table ALREADY BEING
--     THERE. If you CHANGE an existing table (add, rename or drop a column),
--     re-running this file does NOTHING: Postgres sees the table exists and
--     skips it, leaving the old shape in place. To apply a column change you
--     must either:
--       a) DROP the table and let this file recreate it (loses that data), or
--       b) run an ALTER TABLE by hand.
--     `npm run seed` drops and rebuilds the seeded tables, so it picks up
--     changes to those.
--
-- ⚠️  Order matters: a table that REFERENCES another (a foreign key) must be
--     created AFTER the table it points to. That's why `stays` comes after
--     `rooms`, and `order_items` comes after `orders`.
--
-- Quick vocabulary:
--   SERIAL PRIMARY KEY  -> an auto-numbering unique id (1, 2, 3, ...)
--   REFERENCES x(id)    -> a foreign key: this column holds an id from table x
--   NOT NULL            -> the column must always have a value
--   DEFAULT ...         -> the value used when none is provided
--   DATE                -> a calendar day, no time
--   TIMESTAMPTZ         -> a date + time (with timezone)
--   NUMERIC(12, 2)      -> a money-safe number, up to 2 decimal places
--   ON DELETE CASCADE   -> if the referenced row is deleted, delete this one too
--   ON DELETE RESTRICT  -> block deleting the referenced row while this one exists
--   ON DELETE SET NULL  -> if the referenced row is deleted, blank this link


-- ===========================================================================
-- SECTION 1 — ROOMS & GUESTS (the two "base" tables nothing depends on first)
-- ===========================================================================

-- rooms: the hotel rooms. Reception & Admin filter these by category + status.
--
-- `category` is free text so each hotel can name its own room types (Standard,
-- Deluxe King, Superior Double, ...). The frontend's category tabs come from
-- src/data/roomsData.js — keep the two in step.
--
-- `status` is only ever Available or Booked. A room being RESERVED is not a
-- status: reservations are held for a date range in `reservation_rooms`, and
-- availability is worked out from those dates. "1hour Left" and "Overdue" are
-- likewise not stored — they're computed at read time from the active stay's
-- expected_checkout.
CREATE TABLE IF NOT EXISTS rooms (
  id            SERIAL PRIMARY KEY,
  number        TEXT NOT NULL UNIQUE,          -- e.g. "RM 301"
  category      TEXT NOT NULL,                 -- e.g. Standard | Deluxe King
  price         NUMERIC(12, 2) NOT NULL,       -- nightly price
  status        TEXT NOT NULL DEFAULT 'Available',
  is_disabled   BOOLEAN NOT NULL DEFAULT FALSE, -- the admin "Disable" toggle
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- guests: people. Kept as permanent records so we can rank them by spend and
-- show their stay history, even after they've checked out. Reservers live here
-- too — someone booking rooms for other people still gets a guest record.
CREATE TABLE IF NOT EXISTS guests (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  phone         TEXT,
  email         TEXT,
  address       TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ===========================================================================
-- SECTION 2 — STAYS (a guest checked into a room) + CO-GUESTS
-- ===========================================================================

-- stays: one visit of a room. `is_active` = true means someone is currently in
-- the room; false means it's a past stay (kept for history + spend totals).
--
-- `expected_checkout` is when the guest is DUE out — noon (WAT) on the Nth day
-- after check-in, worked out from the number of nights at check-in time. The
-- room dashboard compares it against now to show "1hour Left" and "Overdue",
-- and the reservation availability query uses it to tell whether a room is
-- genuinely free across a future date range.
CREATE TABLE IF NOT EXISTS stays (
  id                 SERIAL PRIMARY KEY,
  room_id            INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  check_in           TIMESTAMPTZ,
  check_out          TIMESTAMPTZ,
  expected_checkout  TIMESTAMPTZ,
  amount_paid        NUMERIC(12, 2) NOT NULL DEFAULT 0,
  payment_method     TEXT,                      -- Cash | POS | ... | an account NAME
  is_active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- stay_guests: links a stay to one or more guests (enables co-guests).
-- `is_primary` = true for the main guest on the booking, false for co-guests.
-- If a stay is deleted, its links go too (CASCADE); we never auto-delete the
-- guest themselves (RESTRICT), since they may have other stays.
CREATE TABLE IF NOT EXISTS stay_guests (
  id            SERIAL PRIMARY KEY,
  stay_id       INTEGER NOT NULL REFERENCES stays(id) ON DELETE CASCADE,
  guest_id      INTEGER NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  is_primary    BOOLEAN NOT NULL DEFAULT FALSE
);


-- ===========================================================================
-- SECTION 3 — RESERVATIONS (a future hold on one or more rooms)
-- ===========================================================================

-- reservations: the header. One row per booking, however many rooms it covers.
-- The reserver is stored in `guests` like anyone else (they may never stay —
-- a company secretary booking for staff still gets a guest record).
--
-- Money is taken UP FRONT: total_amount is what was charged when the booking
-- was made, and payment_method holds Cash / POS / an account NAME, exactly as
-- stays and orders do.
CREATE TABLE IF NOT EXISTS reservations (
  id              SERIAL PRIMARY KEY,
  guest_id        INTEGER NOT NULL REFERENCES guests(id) ON DELETE RESTRICT,
  start_date      DATE NOT NULL,
  end_date        DATE NOT NULL,
  payment_method  TEXT,
  total_amount    NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- reservation_rooms: one row per reserved ROOM. Reserving 5 Deluxe Kings makes
-- one header plus five of these, each already pointing at a specific room
-- (the first N free rooms in that category). Reception can swap any row's room
-- later from the Reservations table.
--
-- `category` is captured AT BOOKING TIME so the record stays correct even if
-- the room is later re-categorised — same reasoning as order_items.unit_price.
--
-- `amount` is this single room's share of the total. It exists so cancelling
-- ONE room can refund exactly that room's money without recomputing anything.
--
-- Rows are DELETED, not flagged: cancelling removes the row, and checking in
-- removes it too (the booking becomes a stay). So this table only ever holds
-- reservations still awaiting arrival — which is exactly what the Reservations
-- page lists.
CREATE TABLE IF NOT EXISTS reservation_rooms (
  id              SERIAL PRIMARY KEY,
  reservation_id  INTEGER NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
  room_id         INTEGER NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
  category        TEXT NOT NULL,
  amount          NUMERIC(12, 2) NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Look-ups are almost always "what's reserved between these dates" and
-- "is this room reserved", so index both.
CREATE INDEX IF NOT EXISTS idx_reservations_dates
  ON reservations (start_date, end_date);
CREATE INDEX IF NOT EXISTS idx_reservation_rooms_room
  ON reservation_rooms (room_id);


-- ===========================================================================
-- SECTION 4 — BAR: CATEGORIES & PRODUCTS
-- ===========================================================================

-- bar_categories: drink categories (Spirits, Smoothie, ...). Admin adds these.
CREATE TABLE IF NOT EXISTS bar_categories (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE
);

-- products: the drinks. `price` + `unit` together are the "price per unit"
-- shown in the UI (e.g. 8500 + "Shot"). Kept as separate columns so `price`
-- stays a clean number we can do math with.
CREATE TABLE IF NOT EXISTS products (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  price         NUMERIC(12, 2) NOT NULL,
  category_id   INTEGER REFERENCES bar_categories(id) ON DELETE SET NULL,
  bar_location  TEXT NOT NULL,                 -- Bar 1 | Bar 2 | Lounge
  unit          TEXT,                          -- Shot | Pint | Bottle | Glass
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ===========================================================================
-- SECTION 5 — BAR CART (the live side panel, one order per bar at a time)
-- ===========================================================================

-- cart_items: drinks the bartender has tapped for the current customer.
-- `bar_location` keeps each bar's cart separate. If a product is deleted, any
-- cart lines for it are removed too (CASCADE).
CREATE TABLE IF NOT EXISTS cart_items (
  id            SERIAL PRIMARY KEY,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL DEFAULT 1,
  bar_location  TEXT NOT NULL,                 -- Bar 1 | Bar 2 | Lounge
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ===========================================================================
-- SECTION 6 — COMPLETED SALES (orders) → feeds the Admin Reports tab
-- ===========================================================================

-- orders: a finished sale, created when the bartender hits "Print Receipt".
-- We store only `total`; subtotal and VAT are recalculated from order_items
-- when a report needs them.
CREATE TABLE IF NOT EXISTS orders (
  id              SERIAL PRIMARY KEY,
  bar_location    TEXT NOT NULL,               -- Bar 1 | Bar 2 | Lounge
  total           NUMERIC(12, 2) NOT NULL,
  payment_method  TEXT,                        -- Cash | POS | ... | an account NAME
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- order_items: the individual drink lines that make up an order.
--
-- Both `product_name` and `unit_price` are captured AT THE TIME OF SALE, so an
-- old receipt still reads correctly even if the drink is later renamed,
-- repriced, or deleted outright. Deleting a product blanks `product_id`
-- (SET NULL) but leaves these two intact.
CREATE TABLE IF NOT EXISTS order_items (
  id            SERIAL PRIMARY KEY,
  order_id      INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id    INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name  TEXT,
  quantity      INTEGER NOT NULL,
  unit_price    NUMERIC(12, 2) NOT NULL
);


-- ===========================================================================
-- SECTION 7 — STORE: CATEGORIES & STOCK
-- ===========================================================================

-- stock_categories: store categories (Food, Housekeeping, ...). Admin adds these.
-- Separate from bar_categories on purpose: "Spirits" is a drink category, not
-- something the storekeeper issues out of the store.
CREATE TABLE IF NOT EXISTS stock_categories (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL UNIQUE
);

-- stock_items: what the store holds. `quantity` + `unit` together are the
-- "35 Bags" shown on the card. `description` is the small uppercase line under
-- the name (e.g. "16 bottles per carton").
--
-- `quantity` is the LIVE figure, and only stock movements change it: issuing
-- decrements, returning and topping up increment. The admin edit form cannot
-- touch it, which is why every change has a matching row in stock_movements.
CREATE TABLE IF NOT EXISTS stock_items (
  id            SERIAL PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT,
  quantity      INTEGER NOT NULL DEFAULT 0,
  unit          TEXT NOT NULL,                 -- Bags | Cartons | Crates | Packs
  category_id   INTEGER REFERENCES stock_categories(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);


-- ===========================================================================
-- SECTION 8 — STORE MOVEMENTS (issue / return / top-up) → feeds Stock History
-- ===========================================================================

-- stock_movements: one stock event, recorded whenever quantity changes.
--   issue  -> stock going OUT to a department (quantity down)
--   return -> stock coming BACK from a department (quantity up)
--   topup  -> a restock by the admin (quantity up)
-- `party` is who it went to or came from ('Restock' for a top-up).
CREATE TABLE IF NOT EXISTS stock_movements (
  id            SERIAL PRIMARY KEY,
  direction     TEXT NOT NULL CHECK (direction IN ('issue', 'return', 'topup')),
  party         TEXT NOT NULL,
  staff_name    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- stock_movement_items: the lines that make up a movement. `unit` is captured
-- AT THE TIME OF THE MOVEMENT, so old records stay correct if the item's unit
-- is later changed — same reasoning as order_items.unit_price.
CREATE TABLE IF NOT EXISTS stock_movement_items (
  id            SERIAL PRIMARY KEY,
  movement_id   INTEGER NOT NULL REFERENCES stock_movements(id) ON DELETE CASCADE,
  stock_item_id INTEGER REFERENCES stock_items(id) ON DELETE SET NULL,
  quantity      INTEGER NOT NULL,
  unit          TEXT NOT NULL
);


-- ===========================================================================
-- SECTION 9 — CORPORATE ACCOUNTS (company tabs)
-- ===========================================================================

-- accounts: a company with a running prepaid balance. Charges (reservations,
-- stays and bar orders paid with this account) draw the balance DOWN; deposits
-- (top-ups) push it UP.
--
-- `balance` is the LIVE figure: we store it and keep it in sync, rather than
-- recomputing it from history on every read. It starts at the opening deposit
-- and is the number the credit-floor check reads before any charge.
--
-- `credit_limit` is how far into the red the balance may go: the balance may
-- fall to -credit_limit, and a charge that would push it past that is refused.
--
-- `name` is UNIQUE because it doubles as the value stored in the
-- payment_method column of reservations, stays and orders — that text IS the
-- link between a charge and its account. It's also why the UI makes the name
-- read-only after creation: renaming would orphan every past charge.
CREATE TABLE IF NOT EXISTS accounts (
  id                 SERIAL PRIMARY KEY,
  name               TEXT NOT NULL UNIQUE,
  credit_limit       NUMERIC(12, 2) NOT NULL DEFAULT 0,
  balance            NUMERIC(12, 2) NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'Active',   -- Active | Suspended
  contact_personnel  TEXT,
  phone              TEXT,
  email              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- account_deposits: one row per money-in event — the opening balance at
-- creation, then every top-up. This is the deposit half of the account's
-- Transaction History (the charge half is queried live from stays and orders).
--
-- Storing deposits as their own rows (even though `balance` is also stored)
-- gives an audit trail and powers "Total Deposited" without trusting a single
-- number. Each insert here is paired, in one transaction, with a balance bump
-- on the parent account.
CREATE TABLE IF NOT EXISTS account_deposits (
  id            SERIAL PRIMARY KEY,
  account_id    INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  amount        NUMERIC(12, 2) NOT NULL,
  note          TEXT,                          -- e.g. "Opening balance", "Top-up"
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===========================================================================
-- SECTION 10 — ACCOUNTING (money log, expenses, categories)
-- ===========================================================================

-- acct_categories: one list for all three kinds, split by `type`. This is what
-- the "Add Category" popup writes to — it collects a name and a type.
--   expense   -> Diesel, Utilities, Bar Restock, ...
--   addon     -> Owner Capital, Loan Received, ...
--   outgoing  -> Owner Drawings, Loan Repayment, ...
CREATE TABLE IF NOT EXISTS acct_categories (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN ('expense', 'addon', 'outgoing')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (name, type)          -- "Diesel" can exist once per type
);

-- expenses: what the hotel spent. An expense is a COST — it exists whether or
-- not it's been paid.
--
-- `spend_date` is when the money was spent; `created_at` is when it was typed
-- in. They differ, deliberately: the Add Expense form says so out loud.
--
-- `is_unpaid` means it went on the Expenses Card — recorded but not settled.
-- Paying it later writes cash_movements rows against it; it is never edited.
--
-- Voiding is same-day only and keeps the row (greyed in the UI), so the
-- history shows what was corrected and why.
CREATE TABLE IF NOT EXISTS expenses (
  id             SERIAL PRIMARY KEY,
  spend_date     DATE NOT NULL,
  category_id    INTEGER REFERENCES acct_categories(id) ON DELETE SET NULL,
  description    TEXT NOT NULL,
  vendor         TEXT,
  amount         NUMERIC(12, 2) NOT NULL,
  is_unpaid      BOOLEAN NOT NULL DEFAULT FALSE,   -- TRUE = on the Expenses Card
  recorded_by    TEXT,
  voided         BOOLEAN NOT NULL DEFAULT FALSE,
  void_reason    TEXT,
  voided_at      TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- cash_movements: THE MONEY LOG. One row for every movement of actual cash,
-- in or out, whatever caused it. This is the single ordered sequence the Cash
-- page reads and the Overview sums.
--
-- Written from ONE place in the code (a helper, not scattered across routes),
-- so every money-touching flow records itself the same way.
--
-- `source_type` + `source_id` point back at whatever caused the movement —
-- a stay, an order, a reservation, an expense, an account deposit. Manual
-- add-ons and out-goings have no source, so both are NULL.
--
-- The running balance is NOT stored: it's computed on read as a running sum
-- ordered by date. That's what makes backdating safe — an expense entered
-- today for last week slots into the right place and every later balance
-- stays correct on its own.
CREATE TABLE IF NOT EXISTS cash_movements (
  id            SERIAL PRIMARY KEY,
  moved_on      DATE NOT NULL,                     -- the date the cash moved
  direction     TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  kind          TEXT NOT NULL,                     -- see the list below
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  method        TEXT,                              -- Cash | Transfer | POS
  description   TEXT,
  category_id   INTEGER REFERENCES acct_categories(id) ON DELETE SET NULL,
  source_type   TEXT,                              -- stay | order | reservation | expense | deposit
  source_id     INTEGER,
  recorded_by   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The kinds, matching the Overview's cash columns exactly:
--   IN  : sales_paid | debt_collected | deposit | addon
--   OUT : expense_paid | expense_settled | expense_prepaid | outgoing | refund

-- Reading the cashbook means ordering by date, so index it.
CREATE INDEX IF NOT EXISTS idx_cash_movements_date ON cash_movements (moved_on, id);
CREATE INDEX IF NOT EXISTS idx_expenses_spend_date ON expenses (spend_date);

-- ===========================================================================
-- SECTION 11 — ROOM DETAILS (location, capacity, amenities)
-- ===========================================================================

-- Location and capacity are plain facts about a room, so they live on it.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS floor       TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS wing        TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS directions  TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS sleeps      TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS bed_type    TEXT;
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS size_sqm    NUMERIC(6, 1);

-- amenities: the hotel's MASTER list — everything a room could possibly have.
-- This is what makes "No WiFi" possible: anything on this list that a room
-- doesn't have is shown struck through, rather than just being absent and
-- leaving reception to guess.
--
-- One global list for the hotel, not per category.
CREATE TABLE IF NOT EXISTS amenities (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,
  sort_order  INTEGER NOT NULL DEFAULT 0,   -- controls the order of the chips
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- room_amenities: what each room actually has, and how many.
-- A room with no row for an amenity simply doesn't have it.
CREATE TABLE IF NOT EXISTS room_amenities (
  id          SERIAL PRIMARY KEY,
  room_id     INTEGER NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  amenity_id  INTEGER NOT NULL REFERENCES amenities(id) ON DELETE CASCADE,
  count       INTEGER NOT NULL DEFAULT 1 CHECK (count > 0),
  UNIQUE (room_id, amenity_id)
);

-- When the room was last serviced. Clean/Dirty is DERIVED from this rather
-- than stored, so it's always right even if the server was off overnight —
-- the same reasoning as the overdue-room logic.
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS last_cleaned_at TIMESTAMPTZ;

-- ===========================================================================
-- SECTION 12 — ISSUES (faults reported by any department)
-- ===========================================================================

-- issues: something broken, reported by staff. Any department can report —
-- reception about a room, the bar about a fridge, the kitchen about an oven.
--
-- One table rather than one per department, because "what's broken?" should be
-- a single query. A second table for the bar would have meant a third for the
-- kitchen and a fourth for laundry, and an admin screen reading all of them.
--
-- WHERE the fault is, is recorded two ways because departments differ:
--   room_id   reception points at a real room, so it can join for the category
--   location  everyone else just names the spot ("Bar 1 · under-counter fridge")
-- Exactly one of the two is filled. The API returns whichever exists as a
-- single `place` field, so one popup renders both.
--
-- `status` moves Received -> In Progress -> Resolved. Whoever ends up owning
-- maintenance updates it; the reporting department only creates and reads.
CREATE TABLE IF NOT EXISTS issues (
  id           SERIAL PRIMARY KEY,
  department   TEXT NOT NULL DEFAULT 'Reception',   -- Reception | Bar | Kitchen | ...
  room_id      INTEGER REFERENCES rooms(id) ON DELETE CASCADE,  -- reception only
  location     TEXT,                                            -- everyone else
  issue        TEXT NOT NULL,
  priority     TEXT NOT NULL DEFAULT 'Medium'
                 CHECK (priority IN ('Low', 'Medium', 'High')),
  status       TEXT NOT NULL DEFAULT 'Received'
                 CHECK (status IN ('Received', 'In Progress', 'Resolved')),
  reported_by  TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_issues_created ON issues (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_issues_department ON issues (department, status);

-- ===========================================================================
-- SECTION 13 — STOCK REQUESTS (bar asks the store for supplies)
-- ===========================================================================

-- A request moves through three states:
--   Pending    the bar has asked
--   Delivered  the store has sent it — this is when store stock actually drops
--   Received   the bar confirms it arrived
--
-- Between Delivered and Received the goods are in transit: gone from the store,
-- not yet acknowledged by the bar. That gap is deliberate — it's where things
-- go missing, and a system that hides it can't show you that.
CREATE TABLE IF NOT EXISTS stock_requests (
  id            SERIAL PRIMARY KEY,
  bar_location  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending'
                  CHECK (status IN ('Pending', 'Delivered', 'Received')),
  note          TEXT,
  requested_by  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivered_at  TIMESTAMPTZ,
  received_at   TIMESTAMPTZ
);

-- The lines of one request. `unit` is copied from the stock item at the time
-- of asking, so an old request still reads correctly if the item's unit is
-- later changed — same reasoning as order_items.unit_price.
CREATE TABLE IF NOT EXISTS stock_request_items (
  id             SERIAL PRIMARY KEY,
  request_id     INTEGER NOT NULL REFERENCES stock_requests(id) ON DELETE CASCADE,
  stock_item_id  INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE RESTRICT,
  quantity       INTEGER NOT NULL CHECK (quantity > 0),
  unit           TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_stock_requests_created
  ON stock_requests (created_at DESC);

-- ===========================================================================
-- SECTION 14 — MAINTENANCE PAYMENT REQUESTS
-- ===========================================================================

-- maintenance_requests: the officer asking the admin for money to fix a fault.
--
-- Optional — a loose door handle costs nothing, so a fault can be resolved
-- with no request at all. And repeatable: parts today, a technician next week,
-- so one fault can carry several.
--
-- Approving is what creates the expense, and `expense_id` records which one.
-- That link is what makes "how much has this fridge cost us?" answerable —
-- follow the fault to its requests, and the requests to their expenses.
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id            SERIAL PRIMARY KEY,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending'
                  CHECK (status IN ('Pending', 'Approved', 'Declined')),
  requested_by  TEXT,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  expense_id    INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maint_requests_status
  ON maintenance_requests (status, created_at DESC);

-- ===========================================================================
-- SECTION 14 — MAINTENANCE PAYMENT REQUESTS
-- ===========================================================================

-- maintenance_requests: the officer asking the admin for money to fix a fault.
--
-- Optional — a loose door handle costs nothing, so a fault can be resolved
-- with no request at all. And repeatable: parts today, a technician next week,
-- so one fault can carry several.
--
-- Approving is what creates the expense, and `expense_id` records which one.
-- That link is what makes "how much has this fridge cost us?" answerable —
-- follow the fault to its requests, and the requests to their expenses.
CREATE TABLE IF NOT EXISTS maintenance_requests (
  id            SERIAL PRIMARY KEY,
  issue_id      INTEGER NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  amount        NUMERIC(12, 2) NOT NULL CHECK (amount > 0),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'Pending'
                  CHECK (status IN ('Pending', 'Approved', 'Declined')),
  requested_by  TEXT,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  expense_id    INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_maint_requests_status
  ON maintenance_requests (status, created_at DESC);
  