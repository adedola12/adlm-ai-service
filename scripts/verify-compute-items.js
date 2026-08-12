// Read-only. Verifies every server-defined compute item (the Carbon and Others
// section, which includes MEP, HVAC and fire) still resolves and still prices.
//
//   node scripts/verify-compute-items.js
//   node scripts/verify-compute-items.js kano      check against another state
//
// Two failures are checked, because they look identical on screen:
//   MISSING  a refName that is not in the library at all. Prices as zero.
//   ZERO     a refName that resolves to a row priced at zero. Also prices as
//            zero, but silently, and no name lookup would ever reveal it.
//
// Checked in EVERY state, not just Lagos: a name can exist in one state's rows
// and not another's, and a user in that state would be the only one to see it.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";
import { STATE_KEYS } from "../../ADLMWebsite/server/util/states.js";

const ONE = process.argv[2] || null;
const HR = 1.4 / 8;

const web = new MongoClient(process.env.MONGO_URI);
await web.connect();
const items = await web.db().collection("rategencomputeitems").find({}).toArray();
await web.close();

console.log(`compute items: ${items.length}`);
const bySection = {};
for (const it of items) bySection[it.section] = (bySection[it.section] || 0) + 1;
console.log(`by section:`, bySection);

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const db = rg.db(config.rategenMasterDb);

const states = ONE ? [ONE] : STATE_KEYS;
let totalMissing = 0, totalZero = 0, statesWithFault = 0;
const firstFaults = [];

for (const state of states) {
  const mats = new Map(
    (await db.collection(config.rategenMatCollection)
      .find({ state }, { projection: { _id: 0, MaterialName: 1, MaterialPrice: 1 } }).toArray())
      .map((r) => [r.MaterialName, r.MaterialPrice]));
  const labs = new Map(
    (await db.collection(config.rategenLabCollection)
      .find({ state }, { projection: { _id: 0, LabourName: 1, LabourPrice: 1 } }).toArray())
      .map((r) => [r.LabourName, r.LabourPrice]));

  let missing = 0, zero = 0;

  for (const it of items) {
    for (const l of it.lines || []) {
      const pool = l.kind === "labour" ? labs : mats;
      if (!pool.has(l.refName)) {
        missing++;
        if (firstFaults.length < 12) firstFaults.push(`MISSING [${state}] ${it.name} -> ${l.kind}:${l.refName}`);
      } else if (!(Number(pool.get(l.refName)) > 0)) {
        zero++;
        if (firstFaults.length < 12) firstFaults.push(`ZERO    [${state}] ${it.name} -> ${l.kind}:${l.refName}`);
      }
    }
  }

  if (missing || zero) statesWithFault++;
  totalMissing += missing;
  totalZero += zero;
}

console.log(`\nstates checked: ${states.length}`);
console.log(`refName misses: ${totalMissing}`);
console.log(`refNames resolving to a zero price: ${totalZero}`);
console.log(`states with any fault: ${statesWithFault}`);
if (firstFaults.length) {
  console.log(`\nfirst faults:`);
  firstFaults.forEach((f) => console.log("   " + f));
}

// Price every item in one state so a silent zero total cannot hide behind a
// clean name check.
const state = ONE || "lagos";
const mats = new Map(
  (await db.collection(config.rategenMatCollection)
    .find({ state }, { projection: { _id: 0, MaterialName: 1, MaterialPrice: 1 } }).toArray())
    .map((r) => [r.MaterialName, r.MaterialPrice]));
const labs = new Map(
  (await db.collection(config.rategenLabCollection)
    .find({ state }, { projection: { _id: 0, LabourName: 1, LabourPrice: 1 } }).toArray())
    .map((r) => [r.LabourName, r.LabourPrice]));

const zeroTotals = [];
console.log(`\npriced in ${state}:`);
for (const it of items.filter((i) => i.section === "carbon")) {
  let net = 0;
  for (const l of it.lines || []) {
    const p = Number((l.kind === "labour" ? labs : mats).get(l.refName)) || 0;
    net += p * (l.qtyPerUnit || 0) * (l.factor ?? 1);
  }
  if (!(net > 0)) zeroTotals.push(it.name);
  console.log(`   ${String(Math.round(net)).padStart(10)} /${(it.outputUnit || "").padEnd(4)} ${it.name.slice(0, 62)}`);
}
console.log(`\ncarbon items totalling zero: ${zeroTotals.length}`);
zeroTotals.forEach((n) => console.log("   " + n));

await rg.close();
process.exit(totalMissing + totalZero + zeroTotals.length === 0 ? 0 : 1);
