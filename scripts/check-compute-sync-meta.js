// Read-only. Why the Carbon and Others section can be empty in the app.
//
// The desktop syncs compute items with GET /library/compute-items/sync, which
// is VERSION GATED: the client sends the version it last saw, and if that
// equals the server's meta version the server answers "up to date" and sends
// no items at all.
//
// Every script that has loaded compute items wrote straight to the collection
// with bulkWrite. None of them called bumpMeta("compute"). So the items exist
// and the version never moved, and a client that has ever synced is told there
// is nothing new, forever.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { webDb } from "./lib/webdb.js";

const web = new MongoClient(process.env.MONGO_URI);
await web.connect();
const db = webDb(web);

const items = db.collection("rategencomputeitems");
const total = await items.countDocuments({});
const bySection = await items.aggregate([
  { $group: { _id: "$section", n: { $sum: 1 }, lastUpdated: { $max: "$updatedAt" } } },
  { $sort: { _id: 1 } },
]).toArray();

console.log(`rategencomputeitems: ${total} documents`);
for (const s of bySection)
  console.log(`   section "${s._id}": ${s.n}   last updated ${s.lastUpdated?.toISOString?.() ?? s.lastUpdated}`);

const metas = await db.collection("rategenmetas").find({}).toArray();
console.log(`\nrategenmetas:`);
for (const m of metas)
  console.log(`   ${String(m.name).padEnd(12)} version=${m.version}   updatedAt=${m.updatedAt?.toISOString?.() ?? m.updatedAt}   note="${m.note || ""}"`);

const compute = metas.find((m) => m.name === "compute");
const newest = bySection.reduce((a, s) => (s.lastUpdated > a ? s.lastUpdated : a), new Date(0));

console.log(`\nDIAGNOSIS`);
if (!compute) {
  console.log(`   No "compute" meta row exists. The first sync creates it at version 1.`);
} else if (newest > (compute.updatedAt || new Date(0))) {
  console.log(`   Items were written AFTER the compute meta last moved.`);
  console.log(`   newest item : ${newest.toISOString?.() ?? newest}`);
  console.log(`   meta bumped : ${compute.updatedAt?.toISOString?.() ?? compute.updatedAt}`);
  console.log(`   Any client already on version ${compute.version} is being told it is up to date`);
  console.log(`   and will never receive these items.`);
} else {
  console.log(`   Meta is newer than the items. Version gating is not the problem.`);
}

await web.close();
