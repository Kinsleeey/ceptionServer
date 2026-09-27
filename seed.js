// seed.js — a one-time setup script (run by hand, not part of the server).
//
// It does two things:
//   1. Runs schema.sql to create the tables.
//   2. Inserts starter data so the app isn't empty.
//
// Run it with:  npm run seed
//
// Re-running is safe in the sense that it always produces the same known
// starting state — but it WIPES first, so don't run it against data you want
// to keep.
//
// This script makes its OWN database connection so it can run on its own,
// separate from server.js. It uses the same DB_* settings from your .env.

import fs from "fs";
import pg from "pg";
import dotenv from "dotenv";

dotenv.config();

const { Pool } = pg;
const db = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
});

// Room stock per category. Numbering runs by floor: 1xx standard tier,
// 2xx deluxe, 3xx superior. Prices are the per-night rates from the design.
//
// `count` rooms are generated for each category starting at `startNumber`, so
// adding rooms later is a one-number change rather than typing them all out.
const roomPlan = [
  { category: "Standard",            count: 6, price: 90000,  startNumber: 101 },
  { category: "Standard King",       count: 4, price: 105000, startNumber: 107 },
  { category: "Standard Queen",      count: 3, price: 112000, startNumber: 111 },
  { category: "Deluxe King",         count: 6, price: 127000, startNumber: 201 },
  { category: "Deluxe Queen",        count: 4, price: 137000, startNumber: 207 },
  { category: "King/Queen",          count: 3, price: 165000, startNumber: 211 },
  { category: "Superior Double",     count: 2, price: 225000, startNumber: 301 },
  { category: "Superior King/Queen", count: 2, price: 420000, startNumber: 303 },
];

// Expand the plan into individual rooms: RM 101, RM 102, ...
const starterRooms = roomPlan.flatMap((plan) =>
  Array.from({ length: plan.count }, (_, i) => ({
    number: `RM ${plan.startNumber + i}`,
    category: plan.category,
    price: plan.price,
    status: "Available",
  }))
);

// Bar categories to seed. Products reference these by id.
const starterCategories = ["Spirits", "Beer", "Wine", "Cocktails", "Smoothie", "Water"];

// Starter drinks. `category` is the NAME (we look up its id during seeding).
// `price` is a plain number; `unit` is what one unit is (Shot, Bottle, etc.).
const starterProducts = [
  { name: "Hennessy VS", category: "Spirits", price: 8500, bar_location: "Bar 1", unit: "Shot" },
  { name: "Jack Daniel's", category: "Spirits", price: 7000, bar_location: "Bar 1", unit: "Shot" },
  { name: "Star Lager", category: "Beer", price: 2000, bar_location: "Bar 1", unit: "Bottle" },
  { name: "Heineken", category: "Beer", price: 2500, bar_location: "Bar 1", unit: "Bottle" },
  { name: "Chapman", category: "Cocktails", price: 3500, bar_location: "Bar 1", unit: "Glass" },
  { name: "Mojito", category: "Cocktails", price: 4000, bar_location: "Bar 2", unit: "Glass" },
  { name: "Red Wine (Glass)", category: "Wine", price: 5000, bar_location: "Bar 2", unit: "Glass" },
  { name: "Moet & Chandon", category: "Wine", price: 85000, bar_location: "Bar 2", unit: "Bottle" },
  { name: "Mango Smoothie", category: "Smoothie", price: 3000, bar_location: "Lounge", unit: "Cup" },
  { name: "Berry Smoothie", category: "Smoothie", price: 3200, bar_location: "Lounge", unit: "Cup" },
  { name: "Eva Water", category: "Water", price: 500, bar_location: "Lounge", unit: "Bottle" },
  { name: "Sparkling Water", category: "Water", price: 1500, bar_location: "Bar 1", unit: "Bottle" },
];

// Store categories to seed. Stock items reference these by id.
// The store's categories. The drink ones match the bar's tabs, because the bar
// requests physical stock from these shelves — a bartender asking for Hennessy
// shouldn't have to know the store files it under "Beverage".
//
// "Beverage" is gone: it was doing the work of four separate shelves.
const starterStockCategories = [
  // drinks — the same names the bar uses
  "Spirits", "Beer", "Wine", "Water",
  // everything else the store keeps
  "Food", "Frozen Food", "Housekeeping", "Kitchen", "Maintenance",
];

// Starter stock. `category` is the NAME (we look up its id during seeding).
const starterStock = [
  { name: "Rice",           category: "Food",         quantity: 35,  unit: "Bags",    description: "Local" },
  { name: "Beef",           category: "Frozen Food",  quantity: 80,  unit: "Kg",      description: "3kg per carton" },
  
  { name: "Beans",          category: "Food",         quantity: 18,  unit: "Bags",    description: "Brown beans" },
  { name: "Egg",            category: "Food",         quantity: 45,  unit: "Crates",  description: "36 eggs per crate" },
  { name: "Tissue Paper",   category: "Housekeeping", quantity: 150, unit: "Packs",   description: "12 rolls per pack" },
  { name: "Vegetable Oil",  category: "Kitchen",      quantity: 12,  unit: "Cartons", description: "12 bottles per carton" },
    // --- Drinks the bar draws on ---
  { name: "Bottled Water",     category: "Water",   quantity: 100, unit: "Cartons", description: "16 bottles per carton" },
  { name: "Sparkling Water",   category: "Water",   quantity: 40,  unit: "Cartons", description: "12 bottles per carton" },
  { name: "Fanta",             category: "Water",   quantity: 28,  unit: "Crates",  description: "16 bottles per crate" },
  { name: "Coca-cola",         category: "Water",   quantity: 50,  unit: "Crates",  description: "16 bottles per crate" },
  { name: "Star Lager",        category: "Beer",    quantity: 36,  unit: "Crates",  description: "12 bottles per crate" },
  { name: "Heineken",          category: "Beer",    quantity: 24,  unit: "Crates",  description: "12 bottles per crate" },
  { name: "Hennessy VS",       category: "Spirits", quantity: 18,  unit: "Bottles", description: "70cl" },
  { name: "Jack Daniel's",     category: "Spirits", quantity: 12,  unit: "Bottles", description: "70cl" },
  { name: "Glenfiddich 12yr",  category: "Spirits", quantity: 6,   unit: "Bottles", description: "70cl" },
  { name: "Red Wine",          category: "Wine",    quantity: 30,  unit: "Bottles", description: "Cabernet Sauvignon" },
  { name: "Moet & Chandon",    category: "Wine",    quantity: 8,   unit: "Bottles", description: "75cl" },
  { name: "Bath Soap",      category: "Housekeeping", quantity: 20,  unit: "Cartons", description: "6 per carton" },
  { name: "Chicken",        category: "Frozen Food",  quantity: 25,  unit: "Cartons", description: "10 pieces per carton" },
  { name: "Light Bulbs",    category: "Maintenance",  quantity: 60,  unit: "Pieces",  description: "LED" },
  
  { name: "Air Fresheners", category: "Housekeeping", quantity: 40,  unit: "Cans",    description: "Orange" },
  { name: "Towels",         category: "Housekeeping", quantity: 200, unit: "Pieces",  description: "White" },
  { name: "Batteries",      category: "Maintenance",  quantity: 25,  unit: "Packs",   description: "4 per pack" },
];

const starterAccounts = [
  { name: "Global Dynamics Inc.", credit_limit: 5000000,  opening: 2450000, status: "Active",    personnel: "Sarah Jenkins", phone: "+234 801 234 5678", email: "s.jenkins@globaldynamics.com" },
  { name: "Silverline Logistics", credit_limit: 3000000,  opening: 1120500, status: "Active",    personnel: "",              phone: "",                  email: "" },
  { name: "Apex Media Group",     credit_limit: 5000000,  opening:  450000, status: "Suspended", personnel: "",              phone: "",                  email: "" },
  { name: "Nomad Ventures Ltd.",  credit_limit: 10000000, opening: 8900000, status: "Active",    personnel: "",              phone: "",                  email: "" },
  { name: "Legacy Real Estate",   credit_limit: 2000000,  opening:       0, status: "Suspended", personnel: "",              phone: "",                  email: "" },
  { name: "TechNova Solutions",   credit_limit: 5000000,  opening:       0, status: "Active",    personnel: "",              phone: "",                  email: "" },
];

// ---------------------------------------------------------------------------
// ACCOUNTING (demo data)
// ---------------------------------------------------------------------------

// One list, three types — matching the Add Category popup.
const starterAcctCategories = [
  // expenses
  { name: "Diesel",        type: "expense" },
  { name: "Utilities",     type: "expense" },
  { name: "Bar Restock",   type: "expense" },
  { name: "Maintenance",   type: "expense" },
  { name: "Housekeeping",  type: "expense" },
  { name: "Staff",         type: "expense" },
  // money in that isn't a sale
  { name: "Owner Capital",          type: "addon" },
  { name: "Loan Received",          type: "addon" },
  { name: "Other Non-Sales Income", type: "addon" },
  // money out that isn't an expense
  { name: "Owner Drawings",             type: "outgoing" },
  { name: "Loan Repayment",             type: "outgoing" },
  { name: "Other Non-Expense Payment",  type: "outgoing" },
];

// Recurring monthly costs. The seeder generates one of each per month, with the
// amount varied a little so the Overview's columns aren't identical every row.
const monthlyExpenseTemplate = [
  { category: "Diesel",       description: "Generator diesel",     vendor: "Halima Fuel",     base: 290000, day: 3,  method: "Cash" },
  { category: "Utilities",    description: "Electricity bill",     vendor: "PHCN",            base: 305000, day: 7,  method: "Transfer" },
  { category: "Bar Restock",  description: "Drinks supply",        vendor: "Fola Drinks",     base: 480000, day: 9,  method: "Transfer" },
  { category: "Housekeeping", description: "Linen and toiletries", vendor: "Bright Supplies", base: 190000, day: 14, method: "POS" },
  { category: "Staff",        description: "Casual staff wages",   vendor: "—",               base: 620000, day: 26, method: "Cash" },
  // The last one each month goes ON THE CARD — recorded but not paid — so the
  // Expenses Card and the "Expenses Paid" column have something to show.
  { category: "Maintenance",  description: "Repairs and servicing", vendor: "Emeka Cooling",  base: 260000, day: 18, method: "Expenses Card" },
];

// A few one-off movements with no source — entered by hand.
const starterManualMovements = [
  { month: 3,  direction: "in",  kind: "addon",    category: "Owner Capital",  description: "Owner capital injection", amount: 1000000, method: "Transfer", day: 5 },
  { month: 7,  direction: "in",  kind: "addon",    category: "Loan Received",  description: "Working capital loan",    amount: 1500000, method: "Transfer", day: 11 },
  { month: 6,  direction: "out", kind: "outgoing", category: "Owner Drawings", description: "Owner drawings",          amount:  230000, method: "Cash",     day: 22 },
  { month: 11, direction: "out", kind: "outgoing", category: "Loan Repayment", description: "Loan instalment",         amount:  260000, method: "Transfer", day: 20 },
];

// The hotel's master amenity list. Every room is measured against this, so a
// room missing one shows it struck through rather than silently absent.
const starterAmenities = [
  "Air Conditioner", "Television", "Mini Fridge", "Wardrobe",
  "WiFi", "Balcony", "Safe", "Kettle",
];

// What each CATEGORY typically has, so the seeder can fill every room without
// listing 30 rooms by hand. `null` means the room doesn't have it at all.
const amenitiesByCategory = {
  "Standard":            { "Air Conditioner": 1, "Television": 1, "Wardrobe": 1 },
  "Standard King":       { "Air Conditioner": 1, "Television": 1, "Wardrobe": 1, "Kettle": 1 },
  "Standard Queen":      { "Air Conditioner": 1, "Television": 1, "Wardrobe": 1, "Kettle": 1 },
  "Deluxe King":         { "Air Conditioner": 2, "Television": 1, "Mini Fridge": 1, "Wardrobe": 1, "Kettle": 1 },
  "Deluxe Queen":        { "Air Conditioner": 2, "Television": 1, "Mini Fridge": 1, "Wardrobe": 1, "Kettle": 1 },
  "King/Queen":          { "Air Conditioner": 2, "Television": 2, "Mini Fridge": 1, "Wardrobe": 2, "WiFi": 1 },
  "Superior Double":     { "Air Conditioner": 2, "Television": 2, "Mini Fridge": 1, "Wardrobe": 2, "WiFi": 1, "Safe": 1 },
  "Superior King/Queen": { "Air Conditioner": 3, "Television": 2, "Mini Fridge": 1, "Wardrobe": 2, "WiFi": 1, "Safe": 1, "Balcony": 1, "Kettle": 1 },
};

// Location and capacity per category.
const detailsByCategory = {
  "Standard":            { sleeps: "2 adults", bed: "1 Double",      size: 18 },
  "Standard King":       { sleeps: "2 adults", bed: "1 King",        size: 22 },
  "Standard Queen":      { sleeps: "2 adults", bed: "1 Queen",       size: 22 },
  "Deluxe King":         { sleeps: "2 adults", bed: "1 King",        size: 28 },
  "Deluxe Queen":        { sleeps: "2 adults", bed: "1 Queen",       size: 28 },
  "King/Queen":          { sleeps: "4 adults", bed: "1 King, 1 Queen", size: 36 },
  "Superior Double":     { sleeps: "4 adults", bed: "2 Doubles",     size: 42 },
  "Superior King/Queen": { sleeps: "4 adults", bed: "1 King, 1 Queen", size: 55 },
};



const ACCT_YEAR = 2026;

async function seed() {
  try {
    console.log("→ Creating tables from schema.sql...");
    const schema = fs.readFileSync("schema.sql", "utf-8");
    await db.query(schema);

    console.log("→ Clearing existing rooms & reservations...");
    // Truncating rooms with CASCADE also clears everything that references
    // rooms — stays, reservation_rooms — so the reset stays consistent.
    //
    // The `reservations` HEADERS are not caught by that, though: they reference
    // guests, not rooms. Clear them explicitly or you'd be left with empty
    // reservations whose rooms have been wiped.
    await db.query("TRUNCATE reservations RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE rooms RESTART IDENTITY CASCADE");

    console.log("→ Inserting starter rooms...");
    for (const r of starterRooms) {
      // $1, $2, ... are placeholders filled by the array below them. This is
      // the safe way to insert values.
      await db.query(
        `INSERT INTO rooms (number, category, price, status)
         VALUES ($1, $2, $3, $4)`,
        [r.number, r.category, r.price, r.status]
      );
      console.log(`   ✓ ${r.number} (${r.category})`);
    }

        // Most rooms start serviced; a few are left dirty so both states are
    // visible straight away.
    await db.query(
      `UPDATE rooms SET last_cleaned_at = NOW() WHERE id % 5 <> 0`
    );

        // ---- Room details: location & capacity ----
    console.log("→ Filling room details...");
    const allRooms = await db.query("SELECT id, number, category FROM rooms ORDER BY id");

    for (const room of allRooms.rows) {
      // The floor comes from the room number: RM 204 -> 2nd floor.
      const digits = room.number.replace(/\D/g, "");
      const floorNum = digits.length >= 3 ? Number(digits[0]) : 1;
      const suffix = floorNum === 1 ? "st" : floorNum === 2 ? "nd" : floorNum === 3 ? "rd" : "th";
      // Even-numbered rooms face one way, odd the other — a simple stand-in
      // for a real floor plan.
      const wing = Number(digits) % 2 === 0 ? "East Wing" : "West Wing";
      const d = detailsByCategory[room.category] || {};

      await db.query(
        `UPDATE rooms
            SET floor = $1, wing = $2, directions = $3,
                sleeps = $4, bed_type = $5, size_sqm = $6
          WHERE id = $7`,
        [`${floorNum}${suffix} Floor`, wing,
         wing === "East Wing" ? "Left of the lift, past the linen room"
                              : "Right of the lift, end of the corridor",
         d.sleeps || "2 adults", d.bed || "1 Double", d.size || 20, room.id]
      );
    }

    // ---- Amenities ----
    console.log("→ Clearing & inserting amenities...");
    await db.query("TRUNCATE amenities RESTART IDENTITY CASCADE");

    const amenityId = {};
    let order = 0;
    for (const name of starterAmenities) {
      const r = await db.query(
        "INSERT INTO amenities (name, sort_order) VALUES ($1, $2) RETURNING id",
        [name, order++]
      );
      amenityId[name] = r.rows[0].id;
    }

    // Give each room the amenities its category typically has.
    let amenityRows = 0;
    for (const room of allRooms.rows) {
      const has = amenitiesByCategory[room.category] || {};
      for (const [name, count] of Object.entries(has)) {
        await db.query(
          `INSERT INTO room_amenities (room_id, amenity_id, count)
           VALUES ($1, $2, $3)`,
          [room.id, amenityId[name], count]
        );
        amenityRows++;
      }
    }
    console.log(`   ✓ ${starterAmenities.length} amenities, ${amenityRows} room links`);

    console.log("→ Clearing & inserting accounts...");
    await db.query("TRUNCATE accounts RESTART IDENTITY CASCADE");
    for (const a of starterAccounts) {
      const res = await db.query(
        `INSERT INTO accounts (name, credit_limit, balance, status, contact_personnel, phone, email)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [a.name, a.credit_limit, a.opening, a.status, a.personnel, a.phone, a.email]
      );
      // Record the opening balance as the first deposit (only if positive).
      if (a.opening > 0) {
        await db.query(
          `INSERT INTO account_deposits (account_id, amount, note) VALUES ($1, $2, 'Opening balance')`,
          [res.rows[0].id, a.opening]
        );
      }
      console.log(`   ✓ ${a.name}`);
    }

    // ---- Bar categories ----
    console.log("→ Clearing & inserting bar categories...");
    // CASCADE clears products + cart_items that reference categories too.
    await db.query("TRUNCATE bar_categories RESTART IDENTITY CASCADE");

    // Insert each category and remember its new id, keyed by name, so products
    // can look up the right category_id below.
    const categoryIdByName = {};
    for (const cname of starterCategories) {
      const result = await db.query(
        "INSERT INTO bar_categories (name) VALUES ($1) RETURNING id",
        [cname]
      );
      categoryIdByName[cname] = result.rows[0].id;
      console.log(`   ✓ category ${cname}`);
    }

    // ---- Products ----
    console.log("→ Inserting products...");
    for (const p of starterProducts) {
      await db.query(
        `INSERT INTO products (name, price, category_id, bar_location, unit)
         VALUES ($1, $2, $3, $4, $5)`,
        [p.name, p.price, categoryIdByName[p.category], p.bar_location, p.unit]
      );
      console.log(`   ✓ ${p.name} (${p.bar_location})`);
    }

    // ---- Store categories ----
    console.log("→ Clearing & inserting stock categories...");
    // CASCADE clears stock_items that reference these categories too.
    await db.query("TRUNCATE stock_categories RESTART IDENTITY CASCADE");

    const stockCategoryIdByName = {};
    for (const cname of starterStockCategories) {
      const result = await db.query(
        "INSERT INTO stock_categories (name) VALUES ($1) RETURNING id",
        [cname]
      );
      stockCategoryIdByName[cname] = result.rows[0].id;
      console.log(`   ✓ stock category ${cname}`);
    }

    // ---- Stock items ----
    console.log("→ Inserting stock...");
    await db.query("TRUNCATE stock_items RESTART IDENTITY CASCADE");

    for (const s of starterStock) {
      await db.query(
        `INSERT INTO stock_items (name, description, quantity, unit, category_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [s.name, s.description, s.quantity, s.unit, stockCategoryIdByName[s.category]]
      );
      console.log(`   ✓ ${s.name} (${s.quantity} ${s.unit})`);
    }

    // ---- Accounting: categories ----
    console.log("→ Clearing & inserting accounting categories...");
    // cash_movements and expenses both reference categories, so CASCADE clears
    // the whole accounting side in one go.
    await db.query("TRUNCATE acct_categories RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE expenses RESTART IDENTITY CASCADE");
    await db.query("TRUNCATE cash_movements RESTART IDENTITY CASCADE");

    const acctCatId = {};
    for (const c of starterAcctCategories) {
      const r = await db.query(
        "INSERT INTO acct_categories (name, type) VALUES ($1, $2) RETURNING id",
        [c.name, c.type]
      );
      acctCatId[`${c.type}:${c.name}`] = r.rows[0].id;
    }
    console.log(`   ✓ ${starterAcctCategories.length} categories`);

    // ---- Accounting: expenses + the cash that paid them ----
    console.log("→ Inserting expenses and cash movements...");
    const pad = (n) => String(n).padStart(2, "0");
    let expenseCount = 0;
    let movementCount = 0;

    for (let month = 1; month <= 12; month++) {
      for (const t of monthlyExpenseTemplate) {
        // Vary the amount by month so the Overview doesn't show 12 identical rows.
        const amount = Math.round(t.base * (0.9 + ((month * 7) % 20) / 100));
        const spendDate = `${ACCT_YEAR}-${pad(month)}-${pad(t.day)}`;
        const unpaid = t.method === "Expenses Card";

        const exp = await db.query(
          `INSERT INTO expenses (spend_date, category_id, description, vendor, amount, is_unpaid, recorded_by)
           VALUES ($1, $2, $3, $4, $5, $6, 'Admin') RETURNING id`,
          [spendDate, acctCatId[`expense:${t.category}`], t.description, t.vendor, amount, unpaid]
        );
        expenseCount++;

        // Paid at the till -> the cash left the same day.
        // On the card -> no cash movement yet; it's settled later.
        if (!unpaid) {
          await db.query(
            `INSERT INTO cash_movements
               (moved_on, direction, kind, amount, method, description, category_id,
                source_type, source_id, recorded_by)
             VALUES ($1, 'out', 'expense_paid', $2, $3, $4, $5, 'expense', $6, 'Admin')`,
            [spendDate, amount, t.method, t.description,
             acctCatId[`expense:${t.category}`], exp.rows[0].id]
          );
          movementCount++;
        }
      }

      // Some of last month's card expenses get settled this month, so the
      // "Past Expenses Settled" column isn't always empty.
      if (month > 1 && month % 2 === 0) {
        const prior = await db.query(
          `SELECT id, amount, description, category_id FROM expenses
            WHERE is_unpaid = TRUE
              AND spend_date >= $1::date AND spend_date < $2::date
            LIMIT 1`,
          [`${ACCT_YEAR}-${pad(month - 1)}-01`, `${ACCT_YEAR}-${pad(month)}-01`]
        );
        for (const e of prior.rows) {
          const part = Math.round(Number(e.amount) * 0.6);   // a part payment
          await db.query(
            `INSERT INTO cash_movements
               (moved_on, direction, kind, amount, method, description, category_id,
                source_type, source_id, recorded_by)
             VALUES ($1, 'out', 'expense_settled', $2, 'Transfer', $3, $4, 'expense', $5, 'Admin')`,
            [`${ACCT_YEAR}-${pad(month)}-05`, part, `${e.description} (part settlement)`,
             e.category_id, e.id]
          );
          movementCount++;
        }
      }
    }

    // ---- Accounting: manual add-ons and out-goings ----
    for (const m of starterManualMovements) {
      await db.query(
        `INSERT INTO cash_movements
           (moved_on, direction, kind, amount, method, description, category_id, recorded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'Admin')`,
        [`${ACCT_YEAR}-${pad(m.month)}-${pad(m.day)}`, m.direction, m.kind,
         m.amount, m.method, m.description,
         acctCatId[`${m.direction === "in" ? "addon" : "outgoing"}:${m.category}`]]
      );
      movementCount++;
    }

    console.log(`   ✓ ${expenseCount} expenses, ${movementCount} cash movements`);

    console.log(
      `\n✅ Done! ${starterRooms.length} rooms across ${roomPlan.length} categories, ` +
      `${starterAccounts.length} accounts, ${starterProducts.length} drinks, ` +
      `${starterStock.length} stock items, ${expenseCount} expenses.\n`
    );
  } catch (err) {
    console.error("\n❌ Seeding failed:", err.message);
    console.error(
      "\nCommon causes: wrong password in .env, the 'HMS' " +
      "database doesn't exist yet, or Postgres isn't running.\n"
    );
    process.exitCode = 1;
  } finally {
    // Close the connection so the script exits cleanly.
    await db.end();
  }
}

seed();