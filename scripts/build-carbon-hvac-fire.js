// Add HVAC and fire protection rates to the "Carbon and Others" section.
//
//   node scripts/build-carbon-hvac-fire.js            dry run
//   node scripts/build-carbon-hvac-fire.js --apply    writes
//
// Same mechanism as build-carbon-mep-items.js: compute-items live on the server,
// so these reach every user on next sync with no installer.
//
// TREATMENT
// The HVAC and fire rows in the library are INSTALLED rates: the source bill
// prices them "supply, install, connect & commission". So most of these carry no
// labour line, because adding one would bill the fixing twice.
//
// The exception is the split air conditioners. Book3 bills the AC unit and its
// 20A DP isolator as SEPARATE items, so an AC point that is actually ready to
// run is the unit plus the isolator plus the electrician time to connect it.
// That is a composite the bill itself supports, not one invented here.
//
// Every refName is verified against the live library before anything is written.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");
const SECTION = "carbon";

// Day rate over 8 hours with the 1.4 gang factor, as every engine expresses it.
const HR = 1.4 / 8;

const M = (refName, qtyPerUnit, unit, description) =>
  ({ kind: "material", refName, description: description || refName, unit, qtyPerUnit, factor: 1 });
const L = (refName, hours, description) =>
  ({ kind: "labour", refName, description: description || refName, unit: "hr", qtyPerUnit: hours, factor: HR });

const ITEMS = [
  // ── Air conditioning. Unit + isolator + connection, because the bill
  //    measures the isolator separately from the unit.
  {
    name: "Split unit air conditioner, 1HP; installed, charged, wired and commissioned",
    outputUnit: "No.",
    lines: [
      M("Split unit air conditioner, 1HP, complete with pipework and brackets", 1, "No."),
      M("20A DP isolator switch (air conditioner/water heater)", 1, "No."),
      L("Electrician (skilled)", 2),
      L("Electrician mate", 2),
    ],
  },
  {
    name: "Split unit air conditioner, 2HP; installed, charged, wired and commissioned",
    outputUnit: "No.",
    lines: [
      M("Split unit air conditioner, 2HP, complete with pipework and brackets", 1, "No."),
      M("20A DP isolator switch (air conditioner/water heater)", 1, "No."),
      L("Electrician (skilled)", 2.5),
      L("Electrician mate", 2.5),
    ],
  },

  // ── Ventilation and fans. Installed rows, no labour line.
  {
    name: "Extractor fan, ceiling or duct mounted, with grille; installed and connected",
    outputUnit: "No.",
    lines: [M("Extractor fan, ceiling/duct mounted, with grille and connection", 1, "No.")],
  },
  {
    name: "Extractor fan, wall mounted, with external louvre; installed and connected",
    outputUnit: "No.",
    lines: [M("Extractor fan, wall mounted, with external louvre and connection", 1, "No.")],
  },
  {
    name: "Ceiling fan with regulator; installed and connected",
    outputUnit: "No.",
    lines: [M("Ceiling fan complete with regulator", 1, "No.")],
  },

  // ── Fire detection and alarm. Installed rows, no labour line.
  {
    name: "Smoke or heat detector, with base; installed and connected",
    outputUnit: "No.",
    lines: [M("Smoke/heat detector, complete with base and connection", 1, "No.")],
  },
  {
    name: "Fire alarm sounder or bell; installed and connected",
    outputUnit: "No.",
    lines: [M("Fire alarm sounder/bell", 1, "No.")],
  },
  {
    name: "Fire alarm control panel, 8 zone, with battery back-up; installed",
    outputUnit: "No.",
    lines: [M("Fire alarm control panel, 8 zone, with battery back-up", 1, "No.")],
  },

  // ── Fire fighting. Installed rows, no labour line.
  {
    name: "Fire extinguisher, dry powder or CO2, with bracket and signage",
    outputUnit: "No.",
    lines: [M("Fire extinguisher, dry powder/CO2, with bracket and signage", 1, "No.")],
  },
  {
    name: "Fire hydrant or landing valve, with hose reel, nozzle and cabinet",
    outputUnit: "No.",
    lines: [M("Fire hydrant/landing valve with hose reel, nozzle and cabinet", 1, "No.")],
  },
];

const web = new MongoClient(process.env.MONGO_URI);
await web.connect();
const items = web.db().collection("rategencomputeitems");

// Verify every refName resolves. A miss prices at zero silently, which is the
// failure this guards against.
const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const master = rg.db(config.rategenMasterDb);
const mats = new Set((await master.collection(config.rategenMatCollection)
  .find({ state: "lagos" }, { projection: { _id: 0, MaterialName: 1 } }).toArray()).map(r => r.MaterialName));
const labs = new Set((await master.collection(config.rategenLabCollection)
  .find({ state: "lagos" }, { projection: { _id: 0, LabourName: 1 } }).toArray()).map(r => r.LabourName));

const missing = [];
for (const it of ITEMS) {
  for (const l of it.lines) {
    const pool = l.kind === "labour" ? labs : mats;
    if (!pool.has(l.refName)) missing.push(`${it.name}  ->  [${l.kind}] ${l.refName}`);
  }
}

if (missing.length) {
  console.error(`ABORT: ${missing.length} line(s) reference names not in the library.\n`);
  missing.forEach((m) => console.error("  " + m));
  await rg.close(); await web.close();
  process.exit(1);
}

// Price them so the dry run shows what a user would see.
const matPrice = Object.fromEntries((await master.collection(config.rategenMatCollection)
  .find({ state: "lagos" }, { projection: { _id: 0, MaterialName: 1, MaterialPrice: 1 } }).toArray())
  .map(r => [r.MaterialName, r.MaterialPrice]));
const labPrice = Object.fromEntries((await master.collection(config.rategenLabCollection)
  .find({ state: "lagos" }, { projection: { _id: 0, LabourName: 1, LabourPrice: 1 } }).toArray())
  .map(r => [r.LabourName, r.LabourPrice]));
await rg.close();

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}   ${ITEMS.length} items into section "${SECTION}"`);
console.log("all refNames verified\n");
for (const it of ITEMS) {
  let net = 0;
  for (const l of it.lines) {
    const p = (l.kind === "labour" ? labPrice : matPrice)[l.refName] || 0;
    net += p * l.qtyPerUnit * l.factor;
  }
  console.log(`  ${it.name.slice(0, 58).padEnd(58)} ${String(Math.round(net)).padStart(9)} -> ${String(Math.round(net * 1.35)).padStart(9)} /${it.outputUnit}`);
}

if (APPLY) {
  const ops = ITEMS.map((it) => ({
    updateOne: {
      filter: { section: SECTION, name: it.name },
      update: {
        $set: {
          section: SECTION, name: it.name, outputUnit: it.outputUnit,
          overheadPercentDefault: 10, profitPercentDefault: 25, enabled: true,
          notes: "HVAC and fire. Installed rows carry no labour line because the source bill "
               + "prices them supply, install and commission. The split AC items add the isolator "
               + "and connection because Book3 bills those separately from the unit.",
          lines: it.lines, updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      upsert: true,
    },
  }));
  const res = await items.bulkWrite(ops, { ordered: false });
  console.log(`\nupserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
  console.log("compute items in section carbon:", await items.countDocuments({ section: SECTION }));
} else {
  console.log("\nRe-run with --apply to write.");
}

await web.close();
