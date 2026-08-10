// Populates ADLMRateDB.mepwork_items with RateGen's MEP build-ups, priced from
// the master library.
//
//   node scripts/build-mep-items.js            dry run
//   node scripts/build-mep-items.js --apply    writes
//
// WHY THIS IS NEEDED
// findCandidateRates() scores an incoming description against every *_items
// collection. With mepwork_items empty, an MEP query does not simply miss — it
// grounds on the WRONG TRADE. "lighting point complete with LED fitting"
// returned a luxalon ceiling and two timber panelling build-ups, because those
// were the best of a set that contained no MEP at all. A wrong-trade ground
// truth is worse than none.
//
// The item definitions mirror ViewModel/MepWork/MepWorkViewModel.cs. They are
// duplicated rather than shared because the engine is C# and this is Node; if
// the engine's item list changes, this file has to change with it.
//
// Unlike the other trades, MEP components are INSTALLED rates (the source bills
// price MEP as "supply, fix, connect & commission"), so no labour line is added
// on top. Each component is emitted as its own breakdown line for the same
// reason the desktop engine does it: so a QS can see what is in the rate.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");
const OH = 0.10, PROFIT = 0.25;               // RateGen engine defaults
const ZONE = "south_west";                     // master build-ups are zone-less; price off the base zone

const PT_LIGHT = "Point wiring, lighting point, concealed PVC conduit";
const PT_POWER = "Point wiring, socket/power point, concealed PVC conduit";
const SW1 = "10A 1 way 1 gang switch";

// [section, description, unit, [[componentName, qty], ...]]
const ITEMS = [
  ["Lighting", "Lighting point complete with 12W LED ceiling fitting, concealed conduit, switch and connection", "No.", [[PT_LIGHT,1],["LED ceiling fitting, 1 x 12W",1],[SW1,1]]],
  ["Lighting", "Lighting point complete with 7W LED spot light, concealed conduit, switch and connection", "No.", [[PT_LIGHT,1],["LED spot light, ceiling mounted, 1 x 7W",1],[SW1,1]]],
  ["Lighting", "Lighting point complete with 600 x 600mm LED panel, concealed conduit, switch and connection", "No.", [[PT_LIGHT,1],["LED panel light 600 x 600mm, 4000K",1],[SW1,1]]],
  ["Lighting", "Lighting point complete with 40W x 600mm LED batten, concealed conduit, switch and connection", "No.", [[PT_LIGHT,1],["LED batten/fluorescent fitting, 40W x 600mm",1],[SW1,1]]],
  ["Lighting", "External lighting point complete with 20W bulkhead fitting, conduit, switch and connection", "No.", [[PT_LIGHT,1],["External wall bracket (bulkhead) light, 20W",1],[SW1,1]]],
  ["Lighting", "Lighting point complete with 4 x 20W chandelier fitting, conduit, 3 gang switch and connection", "No.", [[PT_LIGHT,1],["Chandelier fitting, 4 x 20W",1],["10A 2 way 3 gang switch",1]]],
  ["Lighting", "Mirror light point complete with 10W fitting, conduit, switch and connection", "No.", [[PT_LIGHT,1],["Mirror light, 10W",1],[SW1,1]]],

  ["Power", "13A switched socket outlet point complete, concealed conduit, wiring and connection", "No.", [[PT_POWER,1],["13A 1 gang switched socket outlet",1]]],
  ["Power", "20A DP switched appliance outlet point complete, concealed conduit, wiring and connection", "No.", [[PT_POWER,1],["20A DP switched socket outlet (appliance)",1]]],
  ["Power", "Air conditioner point complete with 20A DP isolator, conduit, wiring and connection", "No.", [[PT_POWER,1],["20A DP isolator switch (air conditioner/water heater)",1]]],
  ["Power", "Water heater point complete with heater, 20A DP isolator, conduit and connection", "No.", [[PT_POWER,1],["Electric water heater, incl. 20A DP switch and connection",1],["20A DP isolator switch (air conditioner/water heater)",1]]],
  ["Power", "Distribution board (DB) with MCBs, complete, labelled and connected", "No.", [["Distribution board (DB) with MCBs, complete and labelled",1]]],

  ...[
    "4 core 70mm2 PVC/SWA/PVC copper cable",
    "4 core 35mm2 PVC/SWA/PVC copper cable",
    "4 core 25mm2 PVC/PVC copper cable",
    "5 core 6mm2 PVC/PVC copper cable",
    "5 core 4mm2 PVC/PVC copper cable",
    "1 core 35mm2 PVC/AWA/PVC copper cable",
    "1 core 16mm2 PVC/PVC copper cable",
    "12 core single mode fibre optic cable with LCUPC connectors",
  ].map((n) => ["Cables", `${n}; laid, terminated and connected`, "m", [[n, 1]]]),

  ["Earthing", "Earth electrode installation complete with 19mm x 3m copper rod and inspection pit", "No.", [["Earth rod, copper, 19mm diameter x 3m long",1],["Earth pit/chamber with ground rod",1]]],
  ["Earthing", "35mm2 bare copper earth conductor to ground grid; laid and bonded", "m", [["35mm2 bare copper earth conductor for ground grid",1]]],
  ["Earthing", "8mm copper round wire earth conductor; fixed and bonded", "m", [["8mm copper round wire, earthing",1]]],

  ...[
    "110mm diameter cable duct, laid in trench, complete",
    "75mm diameter cable duct, laid in trench, complete",
    "50mm diameter cable duct, laid in trench, complete",
    "25mm diameter cable duct, laid in trench, complete",
  ].map((n) => ["Containment", n, "m", [[n, 1]]]),

  ["Sanitary", "Water closet (WC) suite; supply, fix, connect and commission complete", "No.", [["Water closet (WC) suite, complete with cistern, seat and connections",1]]],
  ["Sanitary", "Wash hand basin (WHB) with pillar tap, waste, trap and brackets; fixed and connected", "No.", [["Wash hand basin (WHB) with pillar tap, waste, trap and brackets",1]]],
  ["Sanitary", "Double bowl kitchen sink with mixer tap, waste and trap; fixed and connected", "No.", [["Kitchen sink, double bowl, with mixer tap, waste and trap",1]]],
  ["Sanitary", "Floor drain with trap and grating; fixed and connected", "No.", [["Floor drain (FD) with trap and grating",1]]],
  ["Sanitary", "Inspection chamber complete with cover and benching", "No.", [["Inspection chamber (IC) complete with cover and benching",1]]],

  ["Air Conditioning & Ventilation", "1HP split unit air conditioner; supply, install, pipe, charge and commission", "No.", [["Split unit air conditioner, 1HP, complete with pipework and brackets",1]]],
  ["Air Conditioning & Ventilation", "2HP split unit air conditioner; supply, install, pipe, charge and commission", "No.", [["Split unit air conditioner, 2HP, complete with pipework and brackets",1]]],
  ["Air Conditioning & Ventilation", "Ceiling/duct mounted extractor fan with grille; installed and connected", "No.", [["Extractor fan, ceiling/duct mounted, with grille and connection",1]]],
  ["Air Conditioning & Ventilation", "Wall mounted extractor fan with external louvre; installed and connected", "No.", [["Extractor fan, wall mounted, with external louvre and connection",1]]],
  ["Air Conditioning & Ventilation", "Ceiling fan complete with regulator; installed and connected", "No.", [["Ceiling fan complete with regulator",1]]],

  ["Fire Protection", "Smoke/heat detector complete with base and connection", "No.", [["Smoke/heat detector, complete with base and connection",1]]],
  ["Fire Protection", "Fire alarm sounder/bell; installed and connected", "No.", [["Fire alarm sounder/bell",1]]],
  ["Fire Protection", "8 zone fire alarm control panel with battery back-up; installed and commissioned", "No.", [["Fire alarm control panel, 8 zone, with battery back-up",1]]],
  ["Fire Protection", "Fire hydrant/landing valve with hose reel, nozzle and cabinet", "No.", [["Fire hydrant/landing valve with hose reel, nozzle and cabinet",1]]],
  ["Fire Protection", "Fire extinguisher, dry powder/CO2, with bracket and signage", "No.", [["Fire extinguisher, dry powder/CO2, with bracket and signage",1]]],

  ["Security", "CCTV camera including cabling to recorder; installed and commissioned", "No.", [["CCTV camera, incl. cabling to recorder",1]]],
  ["Security", "Electric fence energizer with remote and status indicator; installed and commissioned", "No.", [["Electric fence energizer, Nemtek Wizord 2i or equal",1],["Remote control device for fence energizer",1],["Electric fence status indicator light",1]]],
  ["Security", "Strobe light and 30W sounder/siren, external; installed and connected", "No.", [["Strobe light and 30W sounder/siren, external",1]]],
];

const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);

const prices = new Map(
  (await db.collection(config.rategenMatCollection)
    .find({ zone: ZONE }, { projection: { _id: 0, MaterialName: 1, MaterialUnit: 1, MaterialPrice: 1 } })
    .toArray()).map((r) => [r.MaterialName, { p: Number(r.MaterialPrice) || 0, u: r.MaterialUnit }])
);

const docs = [];
const missing = new Set();
let itemNo = 0;

for (const [section, description, unit, parts] of ITEMS) {
  const lines = [];
  let net = 0;
  for (const [name, qty] of parts) {
    const hit = prices.get(name);
    if (!hit) { missing.add(name); continue; }
    const total = hit.p * qty;
    net += total;
    lines.push({ ComponentName: name, Quantity: qty, Unit: hit.u || "", UnitPrice: r2(hit.p), TotalPrice: r2(total) });
  }
  const ov = net * OH, pv = net * PROFIT;
  lines.push({ ComponentName: "Net cost (supply & install, from library)", Quantity: 1, Unit: unit, UnitPrice: 0, TotalPrice: r2(net) });
  lines.push({ ComponentName: `Overhead @ ${OH * 100}%`, Quantity: 1, Unit: "", UnitPrice: 0, TotalPrice: r2(ov) });
  lines.push({ ComponentName: `Profit @ ${PROFIT * 100}%`, Quantity: 1, Unit: "", UnitPrice: 0, TotalPrice: r2(pv) });
  lines.push({ ComponentName: "Total rate", Quantity: 1, Unit: unit, UnitPrice: 0, TotalPrice: r2(net + ov + pv) });

  docs.push({
    UserId: null,
    ItemNo: ++itemNo,
    Section: section,
    Description: description,
    Unit: unit,
    NetCost: r2(net),
    OverheadValue: r2(ov),
    ProfitValue: r2(pv),
    TotalCost: r2(net + ov + pv),
    MepBreakdownLine: lines,
    sourceCatalog: "2026.08",
    generatedAt: new Date().toISOString(),
  });
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN (pass --apply to write)"} — ${docs.length} MEP build-ups\n`);
docs.slice(0, 8).forEach((d) =>
  console.log(`  ${String(d.ItemNo).padStart(2)} [${d.Section.slice(0, 12).padEnd(12)}] ${d.Description.slice(0, 58).padEnd(58)} ${String(d.TotalCost).padStart(12)}/${d.Unit}`)
);
if (missing.size) {
  console.log(`\n  WARNING — ${missing.size} component(s) not found in the master library:`);
  [...missing].forEach((n) => console.log(`    ${n}`));
}

if (APPLY) {
  const coll = db.collection("mepwork_items");
  await coll.deleteMany({ sourceCatalog: "2026.08" });   // idempotent regenerate
  const res = await coll.insertMany(docs);
  console.log(`\ninserted ${res.insertedCount} into mepwork_items`);
} else {
  console.log(`\nDry run only.`);
}

await client.close();
