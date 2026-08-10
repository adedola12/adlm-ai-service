// Targeted, zone-aware update of the RateGen master price library.
//
//   node scripts/load-rategen-catalog.js            dry run, prints every change
//   node scripts/load-rategen-catalog.js --apply    writes
//
// DRY RUN IS THE DEFAULT. Nothing is written without --apply.
//
// WHY THIS IS NOT A BULK LOAD
// The obvious move — push RateGen's bundled catalog over the master library —
// is wrong, and the first dry run proved it: it would have LOWERED 149 of 477
// master prices by an average of 61% and wiped LabourUnit on every labour row.
// The master library is actively curated (Jan 2026 prices, labour units added
// Jul 2026); the bundled catalog was built by indexing a 2020-era file. For
// most rows the master is the better number, so the master wins by default and
// only three specific things are changed.
//
//   1. ADD   the 67 MEP rows, which the master has never had, to all six zones
//   2. SET   the handful of primaries with direct market observation newer than
//            the master's January figures
//   3. FILL  south_east / north_east / north_west, where 419 of 482 materials
//            are unpriced and users are being served N0 today. Filled from
//            south_west's CURATED price x the zone factor, never from the
//            bundled catalog.
//
// Everything else in the master, and all labour, is left alone.
//
// Zone factors are derived from the library's own data: the 63 materials
// currently priced in all six zones give a consistent median ratio against
// south_west.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const ZONE_FACTORS = {
  south_west: 1.0,
  north_central: 1.0204,
  north_east: 1.0612,
  south_east: 1.0714,
  north_west: 1.0918,
  south_south: 1.125,
};
const BROKEN_ZONES = ["south_east", "north_east", "north_west"];

// Direct market observation, Aug 2026, newer than the master's January prices.
// south_west (Lagos) basis; other zones get the factor applied.
const OBSERVED = {
  "Cement (50kg bag)": 11500,
  "Diesel": 1215,
  // Rebar: every diameter in each grade shares one tonne rate, as the master does.
  __highTensile: 1700000,
  __mildSteel: 1800000,
  // 9" block from the Book3 blockwall anchor, kept over the master's N686 by
  // explicit decision. The 6" and 4" follow the MASTER's relativity, not the
  // bundled file's — the bundled baseline has 6" priced above 9", which is
  // backwards, while the master orders them 9" > 6" > 4" as they actually sell.
  '225 x 225 x 450mm (9 x 9 x 18") Hollow blocks': 1300,
  '150 x 225 x 450mm (6 x 9 x 18") Hollow blocks': 1207,
  '100 x 225 x 450mm (4 x 9 x 18") Hollow blocks': 1114,
};

const APPLY = process.argv.includes("--apply");
const rategenDir = process.argv.slice(2).find((a) => !a.startsWith("--"))
  || "C:/Users/ADLM/source/repos/ADLMRateGen";

const bundled = JSON.parse(
  readFileSync(join(rategenDir, "Data", "defaultMaterials.json"), "utf-8").replace(/^\uFEFF/, "")
);
const MEP_ROWS = bundled.filter((m) => String(m.MaterialCategory || "").startsWith("MEP - "));

const round = (v) => {
  if (!v) return 0;
  if (v < 1_000) return Math.round(v / 5) * 5;
  if (v < 100_000) return Math.round(v / 50) * 50;
  return Math.round(v / 500) * 500;
};

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);
const coll = db.collection(config.rategenMatCollection);

const ops = [];
const log = { mepAdded: 0, observed: 0, zoneFilled: 0 };
const samples = [];

// ── 1. MEP rows into every zone ─────────────────────────────────────────────
const existingMep = new Set(
  (await coll.find({ MaterialCategory: /^MEP - / }, { projection: { _id: 0, MaterialName: 1 } }).toArray())
    .map((r) => r.MaterialName)
);
for (const zone of Object.keys(ZONE_FACTORS)) {
  for (const m of MEP_ROWS) {
    const price = round((Number(m.MaterialPrice) || 0) * ZONE_FACTORS[zone]);
    if (!existingMep.has(m.MaterialName)) log.mepAdded++;
    ops.push({
      updateOne: {
        filter: { MaterialName: m.MaterialName, zone },
        update: { $set: {
          MaterialName: m.MaterialName, MaterialUnit: m.MaterialUnit,
          MaterialPrice: price, MaterialCategory: m.MaterialCategory, zone,
          updatedAt: new Date().toISOString(), updatedBy: "catalog-2026.08",
        } },
        upsert: true,
      },
    });
  }
}

// ── 2. Observed primaries ───────────────────────────────────────────────────
const swRows = await coll.find({ zone: "south_west" },
  { projection: { _id: 0, MaterialName: 1, MaterialPrice: 1, MaterialCategory: 1, MaterialUnit: 1 } }).toArray();

// Rebar grade is taken from the PIECE COUNT in the name, not from the master's
// MaterialCategory, because that category is wrong. The master has 12 rows
// labelled "High Tensile" including 112/180/45/36-piece rows that are mild
// steel in the bundled catalog, and one "Mild" row carrying the high tensile
// price. Piece count per tonne is unambiguous: mild steel bars are heavier per
// metre, so fewer pieces make a tonne at the same diameter.
//   mild steel      : 180, 112, 70, 45, 36, 27
//   high tensile    : 133, 93, 52, 33, 28, 21
//   350 (6mm)       : appears in both — fall back to the stated category
const MILD_PIECES = new Set([180, 112, 70, 45, 36, 27]);
const HT_PIECES = new Set([133, 93, 52, 33, 28, 21]);

function observedFor(row) {
  if (OBSERVED[row.MaterialName] !== undefined) return OBSERVED[row.MaterialName];

  const isRebar = /Steel Bar Reinforcement/.test(row.MaterialCategory || "");
  if (!isRebar) return null;

  const m = /\((\d+)\s*pieces?\)/i.exec(row.MaterialName || "");
  const pieces = m ? Number(m[1]) : null;
  if (pieces !== null && MILD_PIECES.has(pieces)) return OBSERVED.__mildSteel;
  if (pieces !== null && HT_PIECES.has(pieces)) return OBSERVED.__highTensile;

  // Ambiguous (6mm, 350 pieces) or unparsable ("Steel reinforcement") — use the
  // category as stated rather than guessing.
  return row.MaterialCategory === "Mild Steel Bar Reinforcement"
    ? OBSERVED.__mildSteel
    : OBSERVED.__highTensile;
}

for (const row of swRows) {
  const base = observedFor(row);
  if (base === null) continue;
  for (const [zone, f] of Object.entries(ZONE_FACTORS)) {
    const price = round(base * f);
    if (zone === "south_west" && Math.abs(price - (Number(row.MaterialPrice) || 0)) > 0.5 && samples.length < 14)
      samples.push(`    ${row.MaterialName.slice(0, 44).padEnd(44)} ${String(row.MaterialPrice).padStart(11)} -> ${String(price).padStart(11)}`);
    log.observed++;
    ops.push({
      updateOne: {
        filter: { MaterialName: row.MaterialName, zone },
        update: { $set: { MaterialPrice: price, updatedAt: new Date().toISOString(), updatedBy: "catalog-2026.08" } },
        upsert: false,
      },
    });
  }
}

// ── 3. Fill the three dead zones from south_west's curated prices ───────────
const swPrice = new Map(swRows.map((r) => [r.MaterialName, Number(r.MaterialPrice) || 0]));
for (const zone of BROKEN_ZONES) {
  const rows = await coll.find({ zone }, { projection: { _id: 0, MaterialName: 1, MaterialPrice: 1 } }).toArray();
  for (const r of rows) {
    if ((Number(r.MaterialPrice) || 0) > 0) continue;      // already priced, leave it
    const base = swPrice.get(r.MaterialName);
    if (!base || base <= 0) continue;                       // nothing to derive from
    if (observedFor({ MaterialName: r.MaterialName, MaterialCategory: "" }) !== null) continue; // handled above
    log.zoneFilled++;
    ops.push({
      updateOne: {
        filter: { MaterialName: r.MaterialName, zone },
        update: { $set: {
          MaterialPrice: round(base * ZONE_FACTORS[zone]),
          updatedAt: new Date().toISOString(), updatedBy: "catalog-2026.08-zonefill",
        } },
        upsert: false,
      },
    });
  }
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes — pass --apply)"} to ${config.rategenMasterDb}.${config.rategenMatCollection}\n`);
console.log(`  MEP rows                : ${MEP_ROWS.length} names x 6 zones = ${MEP_ROWS.length * 6} upserts (${existingMep.size} already present)`);
console.log(`  observed primaries     : ${log.observed} row-writes`);
console.log(`  dead-zone fills        : ${log.zoneFilled} rows that currently read N0`);
console.log(`  labour                 : untouched`);
console.log(`  other master materials : untouched`);
if (samples.length) {
  console.log("\n  south_west price changes:");
  samples.forEach((s) => console.log(s));
}

if (APPLY && ops.length) {
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(`\nupserted=${res.upsertedCount} modified=${res.modifiedCount} matched=${res.matchedCount}`);
} else {
  console.log(`\n${ops.length} operations prepared. Dry run only — re-run with --apply to write.`);
}

await client.close();
