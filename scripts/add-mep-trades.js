// Add the MEP trades and small plant to the labour library, all six zones.
//
//   node scripts/add-mep-trades.js            dry run
//   node scripts/add-mep-trades.js --apply    writes
//
// WHY THIS EXISTS
// The Dec-2025 MEP bill produced 31 material rows AND 11 labour rows. Only the
// materials were imported. The labour library has 15 trades and not one of them
// is a plumber, pipefitter or electrician, so the PPR and uPVC supply prices that
// did land cannot be built into a rate: there is no trade to fix them with.
//
// PROVENANCE, STATED PLAINLY
// The source CSV (X/Scripts/rategen-mep-labours.csv) was deleted from the vault
// before these rows were imported. The values below were read directly from that
// file earlier in the same session and are transcribed from that read, not from
// the bill itself. They are south_west day rates. Verify them against the bill
// before relying on them for a priced job.
//
// LabourUnit is "day", matching the live library. The vault note that produced
// the CSV specified blank, on the basis of a December export where every unit was
// blank; the live rows were given "day" and a "per 8-hour work day" note in July.
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

// south_west day rates, Dec-2025 MEP bill
const ROWS = [
  ["Plumber (skilled)", 10_000, "Labour"],
  ["Plumber mate", 7_000, "Labour"],
  ["Pipefitter (PPR fusion and uPVC solvent welding)", 10_000, "Labour"],
  ["Electrician (skilled)", 10_000, "Labour"],
  ["Electrician mate", 7_000, "Labour"],
  ["Wireman / cable puller", 7_000, "Labour"],
  ["MEP foreman", 15_000, "Labour"],
  ["PPR fusion welding machine; 20 to 63mm", 18_000, "Small Plant"],
  ["Pipe threading machine; up to 50mm", 20_000, "Small Plant"],
  ["Cable rod set and draw tape", 6_000, "Small Plant"],
  ["Earth resistance tester (megger)", 25_000, "Small Plant"],
];

const round = (v) => (v < 1_000 ? Math.round(v / 5) * 5 : Math.round(v / 50) * 50);

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const coll = client.db(config.rategenMasterDb).collection(config.rategenLabCollection);

const existing = new Set(
  (await coll.find({}, { projection: { _id: 0, LabourName: 1 } }).toArray()).map((r) => r.LabourName)
);
const clash = ROWS.filter(([n]) => existing.has(n));
if (clash.length) {
  console.log("Already present, will be updated rather than inserted:");
  clash.forEach(([n]) => console.log("  " + n));
}

const ops = [];
for (const [zone, f] of Object.entries(ZONE_FACTORS)) {
  for (const [name, price, cat] of ROWS) {
    ops.push({
      updateOne: {
        filter: { LabourName: name, zone },
        update: {
          $set: {
            LabourName: name,
            LabourUnit: "day",
            LabourPrice: round(price * f),
            LabourCategory: cat,
            zone,
            updatedAt: new Date().toISOString(),
            updatedBy: "mep-bill-2025-12",
            unitNote: "per 8-hour work day",
          },
        },
        upsert: true,
      },
    });
  }
}

console.log(`\n${APPLY ? "APPLYING" : "DRY RUN (no writes)"}  ${ROWS.length} trades x 6 zones = ${ops.length} rows\n`);
console.log("south_west rates:");
ROWS.forEach(([n, p, c]) => console.log(`  ${String(p).padStart(7)}  ${c.padEnd(12)}${n}`));

if (APPLY) {
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(`\nupserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
  console.log("labour rows now:", await coll.countDocuments());
} else {
  console.log("\nRe-run with --apply to write.");
}

await client.close();
