// Price the door ironmongery set, which WindowAndDoor ComputeItem12 has been
// looking up against an empty catalog since it was written.
//
//   node scripts/add-door-ironmongery.js            dry run
//   node scripts/add-door-ironmongery.js --apply    writes
//
// The item's own comment admits it: "Simple placeholder for Ironmongery set per
// door (edit names to match your material library)". GetMaterialPrice returns 0
// on a miss, so that rate has been billing labour and no ironmongery at all.
//
// SOURCE
// Book3, July 2026, which measures ironmongery explicitly in both buildings and
// agrees with itself on quantities:
//
//   ADMIN    96 Prs hinges / 48 locks / 48 stops  for 48 doors
//   HOSTEL  118 Prs hinges / 59 locks / 59 stops  for 59 doors
//
// Both give 2 pairs of hinges, one lock and one stop per door.
//
//   2 Prs x N12,500  =  N25,000
//   1 mortice lock   =  N15,000
//   1 door stop      =  N25,000
//                       -------
//   set                 N65,000
//
// The lock is independently corroborated: the shipped catalog already carries
// "Mortise Lock" at exactly N15,000, from a different source.
//
// THE DOOR STOP IS ALMOST CERTAINLY WRONG, AND IS SHIPPED AS BILLED ANYWAY.
// N25,000 for a door stop is not a Nigerian price; N2,000 to N6,000 is. And it
// is exactly twice the hinge rate, which is what a line copied from the row
// above looks like. It is 38% of the set.
//
// It is left as billed rather than replaced with a guess, the same treatment
// Book3's 12W LED got. The three components are added as their own rows
// precisely so a QS can see the N25,000 and override it, instead of it hiding
// inside one opaque figure.
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

const CATEGORY = "Door Ironmongery";

// name, unit, south_west price
const ROWS = [
  ["Door ironmongery set", "Set", 65_000],
  ["Pair, 100mm brass butt hinges", "Pair", 12_500],
  ["Approved door stop", "No.", 25_000],
];

const round = (v) => (v < 1000 ? Math.round(v / 5) * 5 : Math.round(v / 50) * 50);

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const coll = client.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const existing = new Set(
  (await coll.find({ zone: "south_west" }, { projection: { _id: 0, MaterialName: 1 } }).toArray())
    .map((r) => r.MaterialName)
);

console.log(APPLY ? "APPLYING\n" : "DRY RUN (no writes)\n");
console.log(`category: ${CATEGORY}`);
for (const [n, u, p] of ROWS) {
  console.log(`  ${existing.has(n) ? "update" : "insert"}  ${n.padEnd(32)} ${String(p).padStart(7)} /${u}`);
}
console.log('\n  (the lock is the existing "Mortise Lock" row at N15,000, left alone)');

const ops = [];
for (const [zone, f] of Object.entries(ZONE_FACTORS)) {
  for (const [name, unit, price] of ROWS) {
    ops.push({
      updateOne: {
        filter: { MaterialName: name, zone },
        update: {
          $set: {
            MaterialName: name,
            MaterialUnit: unit,
            MaterialPrice: round(price * f),
            MaterialCategory: CATEGORY,
            zone,
            updatedAt: new Date().toISOString(),
            updatedBy: "book3-2026-07-ironmongery",
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
} else {
  console.log(`\n${ops.length} rows would be written. Re-run with --apply.`);
}

await client.close();
