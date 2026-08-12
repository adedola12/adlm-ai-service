// Read-only. The electrical trades and their day rates, per state.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const col = rg.db(config.rategenMasterDb).collection(config.rategenLabCollection);

const rows = await col
  .find({ state: "lagos" }, { projection: { _id: 0, LabourName: 1, LabourUnit: 1, LabourPrice: 1, LabourCategory: 1 } })
  .sort({ LabourPrice: 1 })
  .toArray();

for (const r of rows)
  console.log(`   ${String(r.LabourPrice).padStart(9)}  ${String(r.LabourUnit || "").padEnd(6)} ${r.LabourName}`);

await rg.close();
