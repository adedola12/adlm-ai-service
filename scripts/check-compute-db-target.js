// Read-only. Which database do the loader scripts and the website server each
// use for compute items?
//
// The scripts write with web.db() from adlm-ai-service's MONGO_URI, which means
// "whatever database name is in that connection string". The website server
// connects with its own URI. If the two names differ, the items are written
// somewhere the API never looks, and the endpoint honestly returns nothing.
import "dotenv/config";
import { MongoClient } from "mongodb";

function dbNameOf(uri) {
  try {
    const afterHost = uri.split("://")[1].split("/").slice(1).join("/");
    const name = afterHost.split("?")[0];
    return name || "(default: test)";
  } catch { return "(unparseable)"; }
}

const aiUri = process.env.MONGO_URI || "";
console.log(`adlm-ai-service MONGO_URI database : ${dbNameOf(aiUri)}`);

const c = new MongoClient(aiUri);
await c.connect();

const admin = c.db().admin();
const { databases } = await admin.listDatabases();
console.log(`\ndatabases on this cluster:`);
for (const d of databases) {
  const db = c.db(d.name);
  let n = 0;
  try { n = await db.collection("rategencomputeitems").countDocuments({}); } catch {}
  let metas = 0;
  try { metas = await db.collection("rategenmetas").countDocuments({}); } catch {}
  console.log(`   ${d.name.padEnd(24)} rategencomputeitems=${String(n).padStart(4)}   rategenmetas=${metas}`);
}

await c.close();
