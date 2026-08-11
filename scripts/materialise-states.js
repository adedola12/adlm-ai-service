// Materialise all 36 Nigerian states plus the FCT in the master price library.
//
//   node scripts/materialise-states.js            dry run
//   node scripts/materialise-states.js --apply    writes
//
// WHAT THIS DOES
// Every material and labour row gains a copy per state, seeded from the price of
// the zone that state belongs to, and carrying both `state` and `zone`.
//
//   596 materials x 37 states = 22,052
//    84 labour    x 37 states =  3,108
//
// The existing zone rows are LEFT IN PLACE and untouched. They have no `state`
// field, so every current query keeps working unchanged; the new rows are only
// visible to a query that asks for a state. That is deliberate: this is a large
// write against a library three other products read, and it should not be able
// to break them on the way in.
//
// WHAT THIS IS NOT
// It is not thirty-seven independent price sets. There is no state-level price
// evidence; the six zone factors were derived from the library's own data and
// that is as fine as the evidence goes. Until a state is edited it carries its
// zone's price, so Kano and Katsina are identical today. The value is that they
// CAN diverge now, one state at a time, as real quotations arrive.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";
import { STATES } from "../../ADLMWebsite/server/util/states.js";

const APPLY = process.argv.includes("--apply");

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);

async function materialise(collName, nameField, priceField) {
  const coll = db.collection(collName);

  // Source rows are the zone rows: the ones with no state on them.
  const zoneRows = await coll.find({ state: { $exists: false } }).toArray();
  const byZone = new Map();
  for (const r of zoneRows) {
    if (!byZone.has(r.zone)) byZone.set(r.zone, []);
    byZone.get(r.zone).push(r);
  }

  console.log(`\n${collName}`);
  console.log(`  zone rows to seed from: ${zoneRows.length}`);
  for (const [z, rows] of [...byZone].sort()) console.log(`     ${z.padEnd(14)} ${rows.length}`);

  const existingStateRows = await coll.countDocuments({ state: { $exists: true } });
  console.log(`  state rows already present: ${existingStateRows}`);

  const ops = [];
  let planned = 0;
  for (const st of STATES) {
    const source = byZone.get(st.zone) || [];
    if (!source.length) {
      console.log(`  WARN no source rows for zone ${st.zone} (state ${st.key})`);
      continue;
    }
    for (const r of source) {
      planned++;
      const doc = { ...r };
      delete doc._id;
      doc.state = st.key;
      doc.zone = st.zone;
      doc.seededFrom = "zone";
      doc.updatedAt = new Date().toISOString();
      doc.updatedBy = "state-materialise-2026-08";
      ops.push({
        updateOne: {
          // Never clobber a state row someone has already edited: only fill in
          // fields on insert, and refresh nothing on an existing row.
          filter: { [nameField]: r[nameField], zone: st.zone, state: st.key },
          update: { $setOnInsert: doc },
          upsert: true,
        },
      });
    }
  }

  console.log(`  would write ${planned} rows across ${STATES.length} states`);

  if (!APPLY) return { planned, written: 0 };

  let upserted = 0;
  const CHUNK = 2000;
  for (let i = 0; i < ops.length; i += CHUNK) {
    const res = await coll.bulkWrite(ops.slice(i, i + CHUNK), { ordered: false });
    upserted += res.upsertedCount;
    process.stdout.write(`\r  written ${Math.min(i + CHUNK, ops.length)}/${ops.length}`);
  }
  console.log(`\n  upserted ${upserted}`);
  return { planned, written: upserted };
}

console.log(APPLY ? "APPLYING" : "DRY RUN (no writes)");
console.log(`${STATES.length} states`);

const m = await materialise(config.rategenMatCollection, "MaterialName", "MaterialPrice");
const l = await materialise(config.rategenLabCollection, "LabourName", "LabourPrice");

if (APPLY) {
  console.log("\nverifying:");
  for (const [coll, label] of [[config.rategenMatCollection, "materials"], [config.rategenLabCollection, "labour"]]) {
    const c = db.collection(coll);
    const total = await c.countDocuments();
    const stateRows = await c.countDocuments({ state: { $exists: true } });
    const distinct = (await c.distinct("state")).filter(Boolean).length;
    console.log(`  ${label}: ${total} total, ${stateRows} state rows, ${distinct} distinct states`);
  }
} else {
  console.log(`\nTotal planned: ${m.planned + l.planned} rows. Re-run with --apply.`);
}

await client.close();
