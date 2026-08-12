// Adds the PLUMBING half of MEP to the RateGen master price library.
//
//   node scripts/load-mep-plumbing.js            dry run, prints every change
//   node scripts/load-mep-plumbing.js --apply    writes
//
// DRY RUN IS THE DEFAULT, same contract as load-rategen-catalog.js.
//
// WHY A SEPARATE SCRIPT AND NOT MORE ROWS IN defaultMaterials.json
// load-rategen-catalog.js tags everything it writes `updatedBy: catalog-2026.08`.
// These rows have a different and much weaker provenance: a single priced MEP
// bill from late 2025. Folding them into the bundled catalog would launder that
// distinction away, and the next person to look would assume they were part of
// the Aug 2026 market-observed set. They are not.
//
// WHAT GAP THIS ACTUALLY FILLS
// The master already has 67 MEP rows across 11 categories, added by
// load-rategen-catalog.js. That set is almost entirely ELECTRICAL: cables,
// containment, switchgear, luminaires, switches and sockets, earthing, fire
// detection, security, point wiring, plus 5 sanitary fittings and 5 AC rows.
//
// Searching all 567 bundled rows for pipe/PPR/uPVC/conduit returns four hits,
// and every one is incidental: two point-wiring rows that mention concealed
// conduit, and two split-AC rows sold "complete with pipework". There is no
// water pipe, no soil or waste pipe, no rainwater pipe, no fitting and no
// valve anywhere in the library.
//
// So the v2.7.0 release note is exactly right when it says "there are no
// pipes". This script is the fix: 31 plumbing rows, none of which duplicate an
// existing name.
//
// PRICE BASIS, AND ITS WEAKNESS
// Rates come from Adedolapo's late-2025 priced MEP bill, loaded UNFACTORED.
// No time uplift is applied, deliberately, because the bill and the library
// cannot be put on one basis from the evidence available:
//
//   35mm2 4c PVC/PVC cable   bill 39,150/m   library 49,275/m   x1.26
//   Water closet suite       bill 85,000     library 112,000    x1.32
//   Wash hand basin          bill 29,000     library 65,000     x2.24
//   Kitchen sink             bill 35,000     library 85,000     x2.43
//
// The two sanitary ratios are inflated by specification, not time: the library
// rows are fuller ("complete with cistern, seat and connections"). One clean
// comparable gives x1.26. Applying that across pipework on a single observation
// would be a guess dressed as a factor, so nothing is applied.
//
// CONSEQUENCE, STATED PLAINLY: these rows are probably 20 to 30 per cent light
// against Aug 2026 money. Under-pricing loses a QS money, so treat this as
// coverage-now, correct-before-release. The supplier check is a blocking task
// before these ship in a public build.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

// Same factors and rounding as load-rategen-catalog.js, derived there from the
// 63 materials priced in all six zones.
const ZONE_FACTORS = {
  south_west: 1.0,
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

// Units and category naming follow the existing 67 MEP rows exactly:
// "No." not "Nr", and "MEP - X (supply & install)".
const ROWS = [
  // ── Cold water pipework ───────────────────────────────────────────────────
  ["PPR pressure pipe, PN10 to BS EN ISO 15874, 32mm", "m", 2300, "MEP - Water Pipework (supply & install)"],
  ["PPR pressure pipe, PN10 to BS EN ISO 15874, 25mm", "m", 2100, "MEP - Water Pipework (supply & install)"],
  ["PPR pressure pipe, PN10 to BS EN ISO 15874, 15mm", "m", 1900, "MEP - Water Pipework (supply & install)"],

  // ── Fittings. 25mm bend is deliberately absent: the source bill prices it
  //    twice, at 350 and at 1,600, and there is no basis to pick one.
  ["PPR equal tee, 25mm", "No.", 500, "MEP - Water Pipework Fittings (supply & install)"],
  ["PPR equal tee, 15mm", "No.", 300, "MEP - Water Pipework Fittings (supply & install)"],
  ["PPR bend, 15mm", "No.", 1500, "MEP - Water Pipework Fittings (supply & install)"],
  ["PPR coupling, 15mm", "No.", 1200, "MEP - Water Pipework Fittings (supply & install)"],
  ["PPR nipple, 15mm", "No.", 1500, "MEP - Water Pipework Fittings (supply & install)"],
  ["PPR reducing tee, 32 x 15mm", "No.", 1500, "MEP - Water Pipework Fittings (supply & install)"],
  ["PPR union connector, 25mm", "No.", 1600, "MEP - Water Pipework Fittings (supply & install)"],
  ["Flexible connection hose, 15mm", "No.", 1900, "MEP - Water Pipework Fittings (supply & install)"],

  // ── Valves ────────────────────────────────────────────────────────────────
  ["Stop valve, 25mm, chromium plated", "No.", 16500, "MEP - Valves (supply & install)"],
  ["Isolating valve, 15mm", "No.", 3500, "MEP - Valves (supply & install)"],

  // ── Soil, waste and vent ──────────────────────────────────────────────────
  ["uPVC soil, waste and vent pipe to BS 4514, 100mm", "m", 4000, "MEP - Soil, Waste & Vent (supply & install)"],
  ["uPVC bend, 100mm", "No.", 3500, "MEP - Soil, Waste & Vent (supply & install)"],
  ["uPVC vent cowl, 100mm", "No.", 5000, "MEP - Soil, Waste & Vent (supply & install)"],
  ["uPVC plug, 100mm", "No.", 550, "MEP - Soil, Waste & Vent (supply & install)"],
  ["uPVC pan connector, 100mm", "No.", 5000, "MEP - Soil, Waste & Vent (supply & install)"],
  ["uPVC liquid waste and vent pipe, 38mm", "m", 2800, "MEP - Soil, Waste & Vent (supply & install)"],
  ["uPVC bend, 38mm", "No.", 2500, "MEP - Soil, Waste & Vent (supply & install)"],

  // ── Rainwater. The bill's fourth rainwater line is omitted: its whole
  //    description is the single character "7".
  ["uPVC rigid rainwater downpipe, 75mm", "m", 2800, "MEP - Rainwater (supply & install)"],
  ["uPVC rigid rainwater bend, 75mm", "No.", 2500, "MEP - Rainwater (supply & install)"],
  ["uPVC rigid rainwater socket, 75mm", "No.", 250, "MEP - Rainwater (supply & install)"],

  // ── Sanitary. Only the shower is added. The bill's WC (85,000), wash hand
  //    basin (29,000) and kitchen sink (35,000) are NOT loaded: the library
  //    already carries all three at fuller specification and a higher price,
  //    and a second cheaper row of the same fitting is how a QS picks the
  //    wrong one.
  ["Shower and shower tray, including all accessories", "No.", 39000, "MEP - Sanitary Fittings (supply & install)"],

  ["Toilet roll holder, fully recessed, 150 x 150mm", "No.", 9500, "MEP - Toilet Accessories (supply & install)"],
  ["Wall hung mirror, 900 x 600 x 6mm thick glass", "No.", 12000, "MEP - Toilet Accessories (supply & install)"],
  ["Soap dish", "No.", 6500, "MEP - Toilet Accessories (supply & install)"],

  // ── Storage and pumps ─────────────────────────────────────────────────────
  ["PVC water storage tank, 3500 litres", "No.", 280000, "MEP - Water Storage & Pumps (supply & install)"],
  ["Tank stand, 4 inch pipe scaffold to 9m high, 16 No. pipes, 32 No. clips, concrete base and hardwood bearers", "No.", 650000, "MEP - Water Storage & Pumps (supply & install)"],
  ["Union float switch, 10A single pole", "No.", 50000, "MEP - Water Storage & Pumps (supply & install)"],
  ["Water pump, 1HP, surface mounted", "No.", 80000, "MEP - Water Storage & Pumps (supply & install)"],
];

const APPLY = process.argv.includes("--apply");
const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);
const coll = db.collection(config.rategenMatCollection);

// Never overwrite a curated row. If a name already exists in a zone, skip it
// and say so, the same principle load-rategen-catalog.js works on.
const existing = new Set(
  (await coll.find({}, { projection: { _id: 0, MaterialName: 1, zone: 1 } }).toArray())
    .map((r) => `${r.MaterialName} ${r.zone}`)
);

const ops = [];
let planned = 0;
let skipped = 0;
const collisions = [];

for (const zone of Object.keys(ZONE_FACTORS)) {
  for (const [name, unit, price, category] of ROWS) {
    if (existing.has(`${name} ${zone}`)) {
      skipped++;
      if (zone === "south_west") collisions.push(name);
      continue;
    }
    planned++;
    ops.push({
      updateOne: {
        filter: { MaterialName: name, zone },
        update: {
          $set: {
            MaterialName: name,
            MaterialUnit: unit,
            MaterialPrice: round(price * ZONE_FACTORS[zone]),
            MaterialCategory: category,
            zone,
            updatedAt: new Date().toISOString(),
            updatedBy: "mep-bill-2025-12",
          },
        },
        upsert: true,
      },
    });
  }
}

const cats = [...new Set(ROWS.map((r) => r[3]))];
console.log(
  `${APPLY ? "APPLYING" : "DRY RUN (no writes - pass --apply)"} to ${config.rategenMasterDb}.${config.rategenMatCollection}\n`
);
console.log(`  plumbing rows defined  : ${ROWS.length} names across ${cats.length} categories`);
console.log(`  zones                  : ${Object.keys(ZONE_FACTORS).length}`);
console.log(`  inserts planned        : ${planned}`);
console.log(`  skipped, already present: ${skipped}`);
if (collisions.length) {
  console.log(`\n  names that already exist and were left alone:`);
  collisions.forEach((c) => console.log(`    ${c}`));
}
console.log(`\n  categories being created:`);
cats.forEach((c) => console.log(`    ${c}`));
console.log(`\n  south_west sample:`);
ROWS.slice(0, 6).forEach(([n, u, p]) =>
  console.log(`    ${n.slice(0, 52).padEnd(52)} ${u.padEnd(4)} ${String(round(p)).padStart(9)}`)
);

if (APPLY && ops.length) {
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(`\nupserted=${res.upsertedCount} modified=${res.modifiedCount} matched=${res.matchedCount}`);
} else {
  console.log(`\n${ops.length} operations prepared. Dry run only - re-run with --apply to write.`);
}

await client.close();
