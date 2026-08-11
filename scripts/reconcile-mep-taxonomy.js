// Reconcile the two MEP builds into one taxonomy with an explicit pricing basis.
//
//   node scripts/reconcile-mep-taxonomy.js            dry run
//   node scripts/reconcile-mep-taxonomy.js --apply    writes
//
// DRY RUN IS THE DEFAULT.
//
// THE PROBLEM
// Two MEP datasets landed on the same day from different bills:
//
//   catalog-2026.08    67 rows, GGT Feb 2026 + Book3 Jul 2026, INSTALLED rates
//                      ("supply, fix, connect & commission")
//   mep-bill-2025-12   31 rows, a late-2025 MEP bill, SUPPLY prices
//
// Both ended up under a flat "MEP - X (supply & install)" naming, which is wrong
// for the second set: PPR pipe at N1,900/m is a supply price, not supply and fix.
// A QS reading the category could not tell which basis a row was on, and the two
// disagree by a lot where they overlap:
//
//   12W LED fitting     supply N3,000    installed N168,750   x56
//   Distribution board  supply N15,000   installed N475,000   x32
//   10A 1-way switch    supply N742      installed N11,875    x16
//   WC suite            supply N85,000   installed N112,000   x1.3   (reconciles)
//
// The small-value electrical gaps are not credible as fixing margins. The sanitary
// ones are. Both sets are kept by explicit decision, so the ONLY safe thing is to
// make the basis impossible to miss.
//
// THE SCHEME
//   MEP - <Trade> - <Group> (<basis>)
//   trade   Electrical | Plumbing | Mechanical | Fire
//   basis   supply     - material only, add labour yourself
//           installed  - supply and fix, do NOT add a fixing line
//
// Basis is taken from the provenance tag, not guessed from the category name.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");

// old category -> new category, for rows tagged catalog-2026.08 (INSTALLED)
const INSTALLED = {
  "MEP - Cables & Wiring (supply & install)": "MEP - Electrical - Cables & Wiring (installed)",
  "MEP - Cable Containment & Ducts (supply & install)": "MEP - Electrical - Containment & Ducts (installed)",
  "MEP - Distribution & Switchgear (supply & install)": "MEP - Electrical - Distribution (installed)",
  "MEP - Earthing & Lightning Protection (supply & install)": "MEP - Electrical - Earthing & Lightning Protection (installed)",
  "MEP - Luminaires (supply & install)": "MEP - Electrical - Luminaires (installed)",
  "MEP - Point Wiring (supply & install)": "MEP - Electrical - Point Wiring (installed)",
  "MEP - Switches & Socket Outlets (supply & install)": "MEP - Electrical - Accessories (installed)",
  "MEP - Security & Detection (supply & install)": "MEP - Electrical - Security & Detection (installed)",
  "MEP - Sanitary Fittings (supply & install)": "MEP - Plumbing - Sanitary Ware (installed)",
  "MEP - Air Conditioning & Ventilation (supply & install)": "MEP - Mechanical - Air Conditioning & Ventilation (installed)",
  "MEP - Fire Protection (supply & install)": "MEP - Fire - Protection & Alarm (installed)",
};

// old category -> new category, for rows tagged mep-bill-2025-12 (SUPPLY)
const SUPPLY = {
  "MEP - Water Pipework (supply & install)": "MEP - Plumbing - Water Pipework (supply)",
  "MEP - Water Pipework Fittings (supply & install)": "MEP - Plumbing - Water Pipework Fittings (supply)",
  "MEP - Soil, Waste & Vent (supply & install)": "MEP - Plumbing - Soil, Waste & Vent (supply)",
  "MEP - Rainwater (supply & install)": "MEP - Plumbing - Rainwater (supply)",
  "MEP - Valves (supply & install)": "MEP - Plumbing - Valves (supply)",
  "MEP - Toilet Accessories (supply & install)": "MEP - Plumbing - Toilet Accessories (supply)",
  "MEP - Water Storage & Pumps (supply & install)": "MEP - Plumbing - Water Storage & Pumps (supply)",
  "MEP - Sanitary Fittings (supply & install)": "MEP - Plumbing - Sanitary Ware (supply)",
};

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const coll = client.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const rows = await coll.find({ MaterialCategory: /^MEP - / }).toArray();
const ops = [];
const unmapped = new Set();
const tally = {};

for (const r of rows) {
  const supplySrc = r.updatedBy === "mep-bill-2025-12";
  const map = supplySrc ? SUPPLY : INSTALLED;
  const next = map[r.MaterialCategory];
  if (!next) {
    unmapped.add(`${r.updatedBy} :: ${r.MaterialCategory}`);
    continue;
  }
  if (next === r.MaterialCategory) continue;
  tally[next] = (tally[next] || 0) + 1;
  ops.push({
    updateOne: {
      filter: { _id: r._id },
      update: { $set: { MaterialCategory: next } },
    },
  });
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}  ${rows.length} MEP rows across all zones\n`);
console.log("new category".padEnd(62) + "rows");
for (const k of Object.keys(tally).sort()) console.log("  " + k.padEnd(60) + tally[k]);

if (unmapped.size) {
  console.log("\nUNMAPPED, left untouched:");
  [...unmapped].forEach((u) => console.log("  " + u));
}

if (APPLY && ops.length) {
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(`\nmodified ${res.modifiedCount} rows`);
} else {
  console.log(`\n${ops.length} rows would change. Re-run with --apply.`);
}

await client.close();
