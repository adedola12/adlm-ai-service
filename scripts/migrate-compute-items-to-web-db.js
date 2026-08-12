// Move the compute items into the database the website API actually reads.
//
//   node scripts/migrate-compute-items-to-web-db.js            dry run
//   node scripts/migrate-compute-items-to-web-db.js --apply    writes
//
// WHAT WENT WRONG
// adlm-ai-service's MONGO_URI carries no database name. In the driver that
// means web.db() resolves to "test", silently. Every script that has ever
// loaded compute items used web.db().collection("rategencomputeitems"), so all
// 26 landed in test. The website server connects with its own URI and reads
// adlmWeb. It looked, found nothing, and correctly returned an empty list, and
// the desktop faithfully cached [] into compute-items.json. Carbon and Others
// has therefore been empty for every user since the section was built.
//
// Nothing about this failed loudly. The loader reported 26 upserts, the API
// returned 200, and the app wrote a valid file. It was only visible by asking
// which database each side was using.
//
// This copies the items across and bumps the compute meta version so clients
// that DO send sinceVersion are not told they are up to date.
import "dotenv/config";
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");
const FROM_DB = process.env.COMPUTE_FROM_DB || "test";
const TO_DB = process.env.WEB_DB_NAME || "adlmWeb";
const COLL = "rategencomputeitems";

const c = new MongoClient(process.env.MONGO_URI);
await c.connect();

const src = c.db(FROM_DB).collection(COLL);
const dst = c.db(TO_DB).collection(COLL);

const items = await src.find({}).toArray();
const before = await dst.countDocuments({});

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}`);
console.log(`   from ${FROM_DB}.${COLL}: ${items.length} documents`);
console.log(`   into ${TO_DB}.${COLL}:   ${before} documents currently\n`);

if (!items.length) {
  console.log("nothing to move");
  await c.close();
  process.exit(0);
}

const bySection = {};
for (const it of items) bySection[it.section] = (bySection[it.section] || 0) + 1;
console.log("   by section:", bySection);
console.log("\n   sample:");
for (const it of items.slice(0, 5))
  console.log(`      [${it.section}] ${it.name}  (${(it.lines || []).length} lines)`);

if (!APPLY) {
  console.log(`\nRe-run with --apply to write.`);
  await c.close();
  process.exit(0);
}

// Keyed on section + name, the same key the loaders upsert on, so re-running
// this is safe and does not duplicate.
// createdAt is dropped from the $set side: it also appears in $setOnInsert,
// and Mongo rejects an update that writes the same path twice.
const ops = items.map((it) => {
  const { _id, createdAt, ...rest } = it;
  return {
    updateOne: {
      filter: { section: it.section, name: it.name },
      update: { $set: { ...rest, updatedAt: new Date() }, $setOnInsert: { createdAt: createdAt || new Date() } },
      upsert: true,
    },
  };
});

const res = await dst.bulkWrite(ops, { ordered: false });
console.log(`\nupserted ${res.upsertedCount}, modified ${res.modifiedCount}`);

// Bump the compute meta so the version-gated sync path cannot answer
// "up to date" and withhold these.
const metas = c.db(TO_DB).collection("rategenmetas");
const existing = await metas.findOne({ name: "compute" });
if (existing) {
  await metas.updateOne(
    { name: "compute" },
    { $inc: { version: 1 }, $set: { updatedAt: new Date(), note: "compute items migrated from test db" } },
  );
} else {
  await metas.insertOne({
    name: "compute", version: 2, nextSn: 1,
    updatedBy: "", note: "compute items migrated from test db",
    createdAt: new Date(), updatedAt: new Date(),
  });
}

const after = await dst.countDocuments({});
const meta = await metas.findOne({ name: "compute" });
console.log(`\nVERIFY`);
console.log(`   ${TO_DB}.${COLL}: ${after} documents`);
console.log(`   compute meta version: ${meta?.version}`);

const sections = await dst.aggregate([{ $group: { _id: "$section", n: { $sum: 1 } } }]).toArray();
for (const s of sections) console.log(`   section "${s._id}": ${s.n}`);

await c.close();
