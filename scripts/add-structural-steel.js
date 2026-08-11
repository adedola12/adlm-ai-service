// Add structural steel section prices, per tonne AND per kg.
//
//   node scripts/add-structural-steel.js            dry run
//   node scripts/add-structural-steel.js --apply    writes
//
// WHY
// The library had ONE structural steel row, "Structural Steel" at N150,000/tonne.
// That cannot be right: reinforcement in the same library is N1,700,000/tonne and
// section steel trades ABOVE bar, not at a ninth of it. The steel section of the
// app has three items and all three are surface preparation, so there was no
// structural steel rate to be wrong in the first place.
//
// SOURCE
// None of the three 2026 bills carries a structural steel rate. The only steel
// line in any of them is a drainage channel cover. So these come from a named
// Nigerian supplier, GZ Industrial Supplies, priced Aug 2026:
//
//   H-beam 300x300, 80 kg/m, 12m   N1,802,775  ->  960 kg  ->  N1,878/kg
//   Plate 6000x1500x16mm           N  860,000  -> 1130 kg  ->  N  761/kg
//   Plate 6000x1500x10mm           N  537,500  ->  707 kg  ->  N  761/kg
//   Channel UPN 80x40x6, 6m        N   31,444  ->   52 kg  ->  N  607/kg
//   Angle 40x40x6, 6m              N    9,675  ->   21 kg  ->  N  463/kg
//
// The two plates agree to the naira on an independently derived weight, which is
// what makes the method trustworthy. Sections at N1,878/kg sit just above rebar
// at N1,700/kg, which is the correct relationship.
//
// CONFIDENCE IS LOWER THAN THE REST OF THE CATALOG. These are web listings from
// one supplier, not a bill and not the user's own observation, and the angle and
// channel figures are far enough below plate to look stale. Every row is tagged
// so it can be found and replaced when a real quotation arrives.
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

const CATEGORY = "Structural Steel Sections";

// name, unit, south_west price
// Every section is offered per tonne AND per kg, because a QS measures steelwork
// either way: tonnage off a schedule, or kg off a takeoff.
const PER_KG = {
  section: 1_880,   // I and H sections, universal beam and column
  angle: 465,
  channel: 605,
  plate: 760,
};

const ROWS = [
  ["Universal beam (I section), supply", "Tonne", PER_KG.section * 1000],
  ["Universal beam (I section), supply", "kg", PER_KG.section],
  ["Universal column (H section), supply", "Tonne", PER_KG.section * 1000],
  ["Universal column (H section), supply", "kg", PER_KG.section],
  ["Rolled steel angle, supply", "Tonne", PER_KG.angle * 1000],
  ["Rolled steel angle, supply", "kg", PER_KG.angle],
  ["Rolled steel channel, supply", "Tonne", PER_KG.channel * 1000],
  ["Rolled steel channel, supply", "kg", PER_KG.channel],
  ["Steel plate, supply", "Tonne", PER_KG.plate * 1000],
  ["Steel plate, supply", "kg", PER_KG.plate],
];

// The master keys on NAME, so a name cannot carry two units. Suffix the per-kg
// rows, the same convention the timber grades use.
const named = ROWS.map(([n, u, p]) => [u === "kg" ? `${n} (per kg)` : n, u, p]);

// The existing row is wrong by more than an order of magnitude, not stale by a
// margin, so it is corrected rather than left beside the new ones.
const FIX_EXISTING = { "Structural Steel": PER_KG.section * 1000 };

// Per-kg rows must stay consistent with their per-tonne twin, so they round to
// the naira rather than to the nearest 50, which would have made N1,880/kg
// display as N1,900 beside a N1,880,000/tonne row saying something different.
const round = (v, fine) =>
  fine ? Math.round(v) : v < 1000 ? Math.round(v / 5) * 5 : v < 100000 ? Math.round(v / 50) * 50 : Math.round(v / 500) * 500;

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const coll = client.db(config.rategenMasterDb).collection(config.rategenMatCollection);

console.log(APPLY ? "APPLYING\n" : "DRY RUN (no writes)\n");
console.log(`category: ${CATEGORY}   (south_west shown; other zones take the zone factor)`);
for (const [n, u, p] of named) console.log(`  ${n.padEnd(46)} ${String(round(p, u === 'kg')).padStart(10)} /${u}`);

console.log("\ncorrecting the existing row:");
for (const [n, p] of Object.entries(FIX_EXISTING)) {
  const cur = await coll.findOne({ MaterialName: n, zone: "south_west" });
  console.log(`  ${n.padEnd(46)} ${String(cur?.MaterialPrice ?? "?").padStart(10)} -> ${round(p)} /Tonne`);
}

const ops = [];
for (const [zone, f] of Object.entries(ZONE_FACTORS)) {
  for (const [name, unit, price] of named) {
    ops.push({
      updateOne: {
        filter: { MaterialName: name, zone },
        update: {
          $set: {
            MaterialName: name, MaterialUnit: unit, MaterialPrice: round(price * f, unit === 'kg'),
            MaterialCategory: CATEGORY, zone,
            updatedAt: new Date().toISOString(), updatedBy: "steel-supplier-2026-08",
          },
        },
        upsert: true,
      },
    });
  }
  for (const [name, price] of Object.entries(FIX_EXISTING)) {
    ops.push({
      updateOne: {
        filter: { MaterialName: name, zone },
        update: { $set: { MaterialPrice: round(price * f), updatedAt: new Date().toISOString(), updatedBy: "steel-supplier-2026-08" } },
        upsert: false,
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
