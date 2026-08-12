// Fills the dead zones in the RateGen master LABOUR library.
//
//   node scripts/fill-rategen-labour-zones.js            dry run, prints every change
//   node scripts/fill-rategen-labour-zones.js --apply    writes
//
// DRY RUN IS THE DEFAULT.
//
// WHAT IS ACTUALLY WRONG
// inspect-rategen-labour.js shows 438 rows: 73 names across 6 zones, and no
// name is duplicated inside any zone. south_west is fully priced. The other
// five are almost entirely empty:
//
//   south_west      73 rows,  0 zero-priced
//   south_south     73 rows, 64 zero-priced
//   north_central   73 rows, 68 zero-priced
//   north_east      73 rows, 68 zero-priced
//   north_west      73 rows, 68 zero-priced
//   south_east      73 rows, 68 zero-priced
//
// So a user pricing in Abuja, Kano, Enugu or Maiduguri gets ZERO LABOUR in
// every build-up that touches a gang. Not a wrong number, no number, and
// nothing in the app says so. This is the labour twin of the materials
// dead-zone problem load-rategen-catalog.js fixed in Aug 2026; that script
// says "labour: untouched" in its own output, and this is why that matters.
//
// WHAT THIS DOES
// Exactly what the materials fix did: fill a zero-priced row from south_west's
// CURATED price multiplied by the zone factor. Never touch a row that already
// has a non-zero price, in any zone.
//
// WHAT THIS DELIBERATELY DOES NOT DO
// Five trades (Carpenter, Glazier, Mason, Steelfixer, Tiler) are already priced
// at a flat 14,000 in all six zones, with no zone variation at all. That is
// inconsistent with everything else in the library, and in south_west it puts a
// Mason at 14,000 above a Skilled/Artisan at 10,000. It is not zero, so it is
// not this script's business. Flagged, not touched.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const ZONE_FACTORS = {
  north_central: 1.0204,
  north_east: 1.0612,
  south_east: 1.0714,
  north_west: 1.0918,
  south_south: 1.125,
};

const round = (v) => {
  if (!v) return 0;
  if (v < 1_000) return Math.round(v / 5) * 5;
  if (v < 100_000) return Math.round(v / 50) * 50;
  return Math.round(v / 500) * 500;
};

const APPLY = process.argv.includes("--apply");
const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);
const coll = db.collection(config.rategenLabCollection || "labours");

const all = await coll.find({}, { projection: { _id: 0 } }).toArray();
const swPrice = new Map(
  all.filter((r) => r.zone === "south_west").map((r) => [`${r.LabourName}|${r.LabourCategory || ""}`, Number(r.LabourPrice) || 0])
);

const ops = [];
const perZone = {};
const noBasis = new Set();
const samples = [];

for (const r of all) {
  if (r.zone === "south_west") continue;
  if (Number(r.LabourPrice) > 0) continue;                 // already priced, leave alone
  const key = `${r.LabourName}|${r.LabourCategory || ""}`;
  const base = swPrice.get(key);
  if (!base || base <= 0) { noBasis.add(r.LabourName); continue; }
  const f = ZONE_FACTORS[r.zone];
  if (!f) { noBasis.add(`${r.LabourName} (unknown zone ${r.zone})`); continue; }
  const price = round(base * f);
  perZone[r.zone] = (perZone[r.zone] || 0) + 1;
  if (samples.length < 12) {
    samples.push(
      `    ${String(r.zone).padEnd(14)} ${r.LabourName.slice(0, 30).padEnd(30)} 0 -> ${String(price).padStart(8)}`
    );
  }
  ops.push({
    updateOne: {
      filter: { LabourName: r.LabourName, LabourCategory: r.LabourCategory, zone: r.zone },
      update: { $set: { LabourPrice: price, updatedAt: new Date().toISOString(), updatedBy: "labour-zonefill-2026.08" } },
      upsert: false,
    },
  });
}

console.log(
  `${APPLY ? "APPLYING" : "DRY RUN (no writes - pass --apply)"} to ${config.rategenMasterDb}.${coll.collectionName}\n`
);
console.log(`  rows in collection      : ${all.length}`);
console.log(`  zero-priced rows to fill: ${ops.length}`);
for (const [z, n] of Object.entries(perZone).sort()) {
  console.log(`    ${z.padEnd(15)} ${String(n).padStart(4)}`);
}
console.log(`  south_west              : untouched, it is the source of truth`);
console.log(`  non-zero rows anywhere  : untouched`);
if (noBasis.size) {
  console.log(`\n  no south_west basis, left at zero: ${[...noBasis].join(", ")}`);
}
if (samples.length) {
  console.log(`\n  sample of the change:`);
  samples.forEach((s) => console.log(s));
}

if (APPLY && ops.length) {
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(`\nmodified=${res.modifiedCount} matched=${res.matchedCount}`);
} else {
  console.log(`\n${ops.length} operations prepared. Dry run only - re-run with --apply to write.`);
}

await client.close();
