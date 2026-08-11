// Build MEP rates as compute-items in the "Carbon and Others" section.
//
//   node scripts/build-carbon-mep-items.js            dry run
//   node scripts/build-carbon-mep-items.js --apply    writes
//
// WHY HERE RATHER THAN IN THE MEP TAB
// Carbon and Others is the only section in RateGen that is data driven. It reads
// compute-item definitions from the server through ComputeItemEngine, so a rate
// defined here reaches every user on their next sync with NO new installer,
// and can be edited afterwards from the website admin. Every other section is
// hardcoded and needs a release.
//
// The collection has never existed, so the section has always been empty.
//
// THE SHAPE
//   { section, name, outputUnit, overheadPercentDefault, profitPercentDefault,
//     lines: [ { kind: material|labour, refName, description, unit,
//                qtyPerUnit, factor } ] }
//
// The engine computes each line as unitPrice x qtyPerUnit x factor, looking the
// price up by refName in the material or labour library. So every refName below
// MUST exist in the library or the line silently prices at zero. This script
// verifies that before writing and refuses if anything is missing.
//
// PLUMBING IS BUILT FROM SUPPLY PRICES PLUS LABOUR, because the Dec-2025 MEP
// bill gave supply prices for pipe and fittings and the labour library now has
// a plumber and a pipefitter. ELECTRICAL AND SANITARY use the installed rows as
// they are, with no labour line, because those rows already include fixing.
// Mixing the two would double count.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");
const SECTION = "carbon";

// Gang cost per hour is how every hardcoded engine expresses labour: day rate
// over 8, times the 1.4 gang factor. Reproduced here as a factor on the line.
const HR = 1.4 / 8;

const M = (refName, qtyPerUnit, unit, description, factor = 1) =>
  ({ kind: "material", refName, description: description || refName, unit, qtyPerUnit, factor });
const L = (refName, hours, description) =>
  ({ kind: "labour", refName, description: description || refName, unit: "hr", qtyPerUnit: hours, factor: HR });

const ITEMS = [
  // ── Cold water pipework, supply + install ──────────────────────────────────
  {
    name: "PPR pressure pipe PN10, 15mm; laid, fused and tested",
    outputUnit: "m",
    lines: [
      M("PPR pressure pipe, PN10 to BS EN ISO 15874, 15mm", 1.05, "m", "PPR pipe 15mm incl. 5% waste"),
      M("PPR coupling, 15mm", 0.35, "No.", "Couplings, one per 3m"),
      L("Pipefitter (PPR fusion and uPVC solvent welding)", 0.35),
      L("Plumber mate", 0.35),
    ],
  },
  {
    name: "PPR pressure pipe PN10, 25mm; laid, fused and tested",
    outputUnit: "m",
    lines: [
      M("PPR pressure pipe, PN10 to BS EN ISO 15874, 25mm", 1.05, "m", "PPR pipe 25mm incl. 5% waste"),
      M("PPR equal tee, 25mm", 0.2, "No."),
      L("Pipefitter (PPR fusion and uPVC solvent welding)", 0.4),
      L("Plumber mate", 0.4),
    ],
  },
  {
    name: "PPR pressure pipe PN10, 32mm; laid, fused and tested",
    outputUnit: "m",
    lines: [
      M("PPR pressure pipe, PN10 to BS EN ISO 15874, 32mm", 1.05, "m", "PPR pipe 32mm incl. 5% waste"),
      L("Pipefitter (PPR fusion and uPVC solvent welding)", 0.45),
      L("Plumber mate", 0.45),
    ],
  },

  // ── Soil, waste and vent ───────────────────────────────────────────────────
  {
    name: "uPVC soil, waste and vent pipe to BS 4514, 100mm; fixed to falls",
    outputUnit: "m",
    lines: [
      M("uPVC soil, waste and vent pipe to BS 4514, 100mm", 1.05, "m", "uPVC 100mm incl. 5% waste"),
      M("uPVC bend, 100mm", 0.15, "No."),
      L("Plumber (skilled)", 0.45),
      L("Plumber mate", 0.45),
    ],
  },
  {
    name: "uPVC liquid waste / vent pipe, 38mm; fixed to falls",
    outputUnit: "m",
    lines: [
      M("uPVC liquid waste and vent pipe, 38mm", 1.05, "m", "uPVC 38mm incl. 5% waste"),
      M("uPVC bend, 38mm", 0.15, "No."),
      L("Plumber (skilled)", 0.3),
      L("Plumber mate", 0.3),
    ],
  },
  {
    name: "uPVC rainwater downpipe, 75mm; fixed to wall with brackets",
    outputUnit: "m",
    lines: [
      M("uPVC rigid rainwater downpipe, 75mm", 1.05, "m", "Downpipe incl. 5% waste"),
      M("uPVC rigid rainwater socket, 75mm", 0.35, "No."),
      L("Plumber (skilled)", 0.3),
      L("Plumber mate", 0.3),
    ],
  },

  // ── Valves and controls ────────────────────────────────────────────────────
  {
    name: "Isolating valve, 15mm; fixed and connected",
    outputUnit: "No.",
    lines: [
      M("Isolating valve, 15mm", 1, "No."),
      L("Plumber (skilled)", 0.5),
    ],
  },
  {
    name: "Stop valve, 25mm chromium plated; fixed and connected",
    outputUnit: "No.",
    lines: [
      M("Stop valve, 25mm, chromium plated", 1, "No."),
      L("Plumber (skilled)", 0.6),
    ],
  },

  // ── Water storage ──────────────────────────────────────────────────────────
  {
    name: "PVC water storage tank, 3500 litres; set on stand and connected",
    outputUnit: "No.",
    lines: [
      M("PVC water storage tank, 3500 litres", 1, "No."),
      L("Plumber (skilled)", 6),
      L("Plumber mate", 6),
      L("Labourer", 6),
    ],
  },
  {
    name: "Water pump, 1 HP surface mounted; installed, wired and commissioned",
    outputUnit: "No.",
    lines: [
      M("Water pump, 1HP, surface mounted", 1, "No."),
      M("Union float switch, 10A single pole", 1, "No."),
      L("Plumber (skilled)", 4),
      L("Electrician (skilled)", 2),
    ],
  },

  // ── Sanitary, installed rows: no labour line, fixing already included ──────
  {
    name: "Water closet suite; supply, fix, connect and commission",
    outputUnit: "No.",
    lines: [M("Water closet (WC) suite, complete with cistern, seat and connections", 1, "No.")],
  },
  {
    name: "Wash hand basin with tap, waste and trap; fixed and connected",
    outputUnit: "No.",
    lines: [M("Wash hand basin (WHB) with pillar tap, waste, trap and brackets", 1, "No.")],
  },
  {
    name: "Shower and shower tray including all accessories; fixed and connected",
    outputUnit: "No.",
    lines: [
      M("Shower and shower tray, including all accessories", 1, "No."),
      L("Plumber (skilled)", 3),
      L("Plumber mate", 3),
    ],
  },

  // ── Electrical, installed rows ─────────────────────────────────────────────
  {
    name: "Lighting point complete with 600 x 600mm LED panel and switch",
    outputUnit: "No.",
    lines: [
      M("Point wiring, lighting point, concealed PVC conduit", 1, "No."),
      M("LED panel light 600 x 600mm, 4000K", 1, "No."),
      M("10A 1 way 1 gang switch", 1, "No."),
    ],
  },
  {
    name: "13A switched socket outlet point complete",
    outputUnit: "No.",
    lines: [
      M("Point wiring, socket/power point, concealed PVC conduit", 1, "No."),
      M("13A 1 gang switched socket outlet", 1, "No."),
    ],
  },
  {
    name: "Earth electrode; 19mm x 3m copper rod in inspection pit",
    outputUnit: "No.",
    lines: [
      M("Earth rod, copper, 19mm diameter x 3m long", 1, "No."),
      M("Earth pit/chamber with ground rod", 1, "No."),
      L("Electrician (skilled)", 4),
      L("Labourer", 4),
    ],
  },
];

const client = new MongoClient(process.env.MONGO_URI);
await client.connect();
const web = client.db();
const items = web.collection("rategencomputeitems");

// Verify every refName resolves before writing anything.
const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const master = rg.db(config.rategenMasterDb);
const mats = new Set((await master.collection(config.rategenMatCollection)
  .find({ zone: "south_west" }, { projection: { _id: 0, MaterialName: 1 } }).toArray()).map(r => r.MaterialName));
const labs = new Set((await master.collection(config.rategenLabCollection)
  .find({ zone: "south_west" }, { projection: { _id: 0, LabourName: 1 } }).toArray()).map(r => r.LabourName));

const missing = [];
for (const it of ITEMS) {
  for (const l of it.lines) {
    const pool = l.kind === "labour" ? labs : mats;
    if (!pool.has(l.refName)) missing.push(`${it.name}  ->  [${l.kind}] ${l.refName}`);
  }
}
await rg.close();

if (missing.length) {
  console.error(`ABORT: ${missing.length} line(s) reference names not in the library.`);
  console.error("A missing name prices at zero silently, which is the whole failure mode this guards against.\n");
  missing.forEach(m => console.error("  " + m));
  await client.close();
  process.exit(1);
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}   ${ITEMS.length} compute items into section "${SECTION}"\n`);
console.log("all refNames verified against the library\n");
for (const it of ITEMS) {
  console.log(`  ${it.name.slice(0, 62).padEnd(62)} /${it.outputUnit}  ${it.lines.length} lines`);
}

if (APPLY) {
  const ops = ITEMS.map((it) => ({
    updateOne: {
      filter: { section: SECTION, name: it.name },
      update: {
        $set: {
          section: SECTION,
          name: it.name,
          outputUnit: it.outputUnit,
          overheadPercentDefault: 10,
          profitPercentDefault: 25,
          enabled: true,
          notes: "MEP. Plumbing lines are supply price plus labour; electrical and sanitary use installed rows, which already include fixing.",
          lines: it.lines,
          updatedAt: new Date(),
        },
        $setOnInsert: { createdAt: new Date() },
      },
      upsert: true,
    },
  }));
  const res = await items.bulkWrite(ops, { ordered: false });
  console.log(`\nupserted ${res.upsertedCount}, modified ${res.modifiedCount}`);
  console.log("total compute items now:", await items.countDocuments());
} else {
  console.log("\nRe-run with --apply to write.");
}

await client.close();
