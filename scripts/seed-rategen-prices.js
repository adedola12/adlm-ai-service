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

  // GUARD: this script predates zone pricing and is unsafe against it.
  //
  // The master collections are now zone-priced — one document per item PER
  // ZONE (479 materials x 6 Nigerian zones = 2,874 docs), so SerialNumber is
  // no longer unique. `updateOne` with {SerialNumber: n} would update exactly
  // ONE arbitrary zone document per item and leave the other five holding the
  // old price, producing a half-updated library where the same material costs
  // different money in different zones for no reason. That is worse than not
  // running at all, and it would be invisible until a user in the wrong zone
  // priced a job.
  //
  // Refuse rather than corrupt. A zone-aware upload has to decide what a
  // national bundled price means per zone, which is a pricing decision, not a
  // scripting one.
  const zoned = await coll.countDocuments({ zone: { $exists: true } });
  if (zoned > 0) {
    throw new Error(
      `${collName} holds ${zoned} zone-priced documents. This script keys on ` +
      `${keyField} alone and would update one zone per item, leaving the rest ` +
      `stale. Use a zone-aware upload, or the website admin at ` +
      `/admin/rategen (PUT /admin/rategen/grid), instead.`
    );
  }

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
