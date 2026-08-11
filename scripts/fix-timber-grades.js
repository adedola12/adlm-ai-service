// Restore the softwood / hardwood split in the master material library.
//
//   node scripts/fix-timber-grades.js            dry run
//   node scripts/fix-timber-grades.js --apply    writes
//
// THE PROBLEM
// The master keys materials on NAME + ZONE, and /rategen/master's selectForZone
// serves one row per name. The shipped catalog carries several timber sections
// in BOTH grades under the same name, so when the master was built one grade won
// and the other vanished. Softwood ended up with a single row while Hardwood
// held nine, including four sections that are softwood in the shipped catalog.
//
// Roof carpentry is priced off these rows, so a QS pricing a roof was reaching
// for a grade the library no longer distinguished.
//
// THE FIX
// Two rows are simply mis-filed and only need their category corrected. Their
// names are unique to softwood in the baseline, so nothing else claims them.
//
// Three sections genuinely exist in both grades. Because a bare name can only
// hold one row, the added grade takes an explicit suffix, following the
// convention the shipped catalog already uses for
// '2x2"x12' (50x50x3600mm) - Hardwood'.
//
// Prices for the added rows come from the baseline's own grade ratio, not from
// nowhere. In the v1 catalog softwood costs MORE than hardwood for the same
// section, which is correct for Nigeria: local rough-sawn hardwood is the cheap
// roof timber and imported softwood is the dearer joinery grade.
//
//   2x3  softwood 400 / hardwood 230 = 1.739
//   2x4  softwood 450 / hardwood 280 = 1.607
//   2x6  softwood 750 / hardwood 300 = 2.500
//
// No engine looks these three up by name, so adding suffixed rows breaks
// nothing. GetMaterialPrice matches on name alone, so the two recategorised
// rows keep working untouched.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");

const ZONE_FACTORS = {
  south_west: 1.0,
  north_central: 1.0204,
  north_east: 1.0612,
  south_east: 1.0714,
  north_west: 1.0918,
  south_south: 1.125,
};

// name -> correct category. Price untouched.
const RECATEGORISE = {
  '1x12"x12\' (25x300x3600mm)': "Timber - Softwood",
  '2x2"x12\' (50x50x3600mm)': "Timber - Softwood",
};

// new rows: [name, category, sourceName, ratio applied to the source's sw price]
const ADD = [
  ['2x3"x12\' (50x75x3600mm) - Hardwood', "Timber - Hardwood", '2x3"x12\' (50x75x3600mm)', 1 / 1.739],
  ['2x4"x12\' (50x100x3600mm) - Softwood', "Timber - Softwood", '2x4"x12\' (50x100x3600mm)', 1.607],
  ['2x6"x12\' (50x150x3600mm) - Softwood', "Timber - Softwood", '2x6"x12\' (50x150x3600mm)', 2.5],
];

const round = (v) => (v < 1000 ? Math.round(v / 5) * 5 : Math.round(v / 50) * 50);

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const coll = client.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const ops = [];

console.log(APPLY ? "APPLYING\n" : "DRY RUN (no writes)\n");
console.log("RECATEGORISE:");
for (const [name, cat] of Object.entries(RECATEGORISE)) {
  const n = await coll.countDocuments({ MaterialName: name });
  console.log(`  ${name.padEnd(34)} -> ${cat}   (${n} rows across zones)`);
  ops.push({ updateMany: { filter: { MaterialName: name }, update: { $set: { MaterialCategory: cat } } } });
}

console.log("\nADD:");
for (const [name, cat, srcName, ratio] of ADD) {
  const src = await coll.findOne({ MaterialName: srcName, zone: "south_west" });
  if (!src) {
    console.log(`  SKIP ${name} - source "${srcName}" not found`);
    continue;
  }
  const base = round(Number(src.MaterialPrice) * ratio);
  console.log(`  ${name.padEnd(40)} ${String(base).padStart(7)}  (from ${srcName} ${src.MaterialPrice} x ${ratio.toFixed(3)})`);
  for (const [zone, f] of Object.entries(ZONE_FACTORS)) {
    ops.push({
      updateOne: {
        filter: { MaterialName: name, zone },
        update: {
          $set: {
            MaterialName: name,
            MaterialUnit: src.MaterialUnit || "Length",
            MaterialPrice: round(base * f),
            MaterialCategory: cat,
            zone,
            updatedAt: new Date().toISOString(),
            updatedBy: "timber-grade-restore",
          },
        },
        upsert: true,
      },
    });
  }
}

if (APPLY) {
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(`\nupserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
  const sw = await coll.countDocuments({ zone: "south_west", MaterialCategory: "Timber - Softwood" });
  const hw = await coll.countDocuments({ zone: "south_west", MaterialCategory: "Timber - Hardwood" });
  console.log(`south_west now: Softwood ${sw}, Hardwood ${hw}`);
} else {
  console.log("\nRe-run with --apply to write.");
}

await client.close();
