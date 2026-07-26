// Uploads RateGen's bundled price lists (defaultMaterials.json /
// defaultLabours.json) into the ADLMRateDB grounding collections — the same
// shape RateGen's own BulkUploadUtility writes (MaterialModel / LabourModel).
// Token-free: this is a Mongo import of ADLM's own data, no AI calls.
// Idempotent: upserts by SerialNumber, so re-running refreshes prices.
//
//   node scripts/seed-rategen-prices.js [path-to-ADLMRateGen]
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const rategenDir = process.argv[2] || "C:/Users/ADLM/source/repos/ADLMRateGen";
const load = (f) => JSON.parse(readFileSync(join(rategenDir, "Data", f), "utf-8").replace(/^\uFEFF/, ""));

const materials = load("defaultMaterials.json");
const labours = load("defaultLabours.json");

const client = new MongoClient(config.mongoUri);
await client.connect();
const db = client.db(config.rategenMasterDb);

async function upsert(collName, rows, keyField) {
  const coll = db.collection(collName);
  const ops = rows.map((r) => ({
    updateOne: { filter: { [keyField]: r[keyField] }, update: { $set: r }, upsert: true },
  }));
  const res = await coll.bulkWrite(ops, { ordered: false });
  console.log(
    `${config.rategenMasterDb}.${collName}: ${res.upsertedCount} inserted, ${res.modifiedCount} updated, total now ${await coll.countDocuments()}`
  );
}

await upsert(config.rategenMatCollection, materials, "SerialNumber");
await upsert(config.rategenLabCollection, labours, "SerialNumber");
await client.close();
console.log("RateGen price lists seeded. Build-ups will now reprice components from the library.");
