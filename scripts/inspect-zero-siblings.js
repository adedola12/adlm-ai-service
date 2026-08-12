// Read-only. Shows the category neighbours of each zero-priced material, so a
// repair can be based on what sits beside it rather than on a guess.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const c = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const zeros = await c
  .find({ state: "lagos", $or: [{ MaterialPrice: 0 }, { MaterialPrice: null }] })
  .project({ _id: 0, MaterialName: 1, MaterialUnit: 1, MaterialCategory: 1 })
  .toArray();

for (const z of zeros) {
  console.log(`\n=== "${z.MaterialName}" [${z.MaterialUnit}] cat="${z.MaterialCategory}" ===`);
  const sibs = await c
    .find({ state: "lagos", MaterialCategory: z.MaterialCategory })
    .project({ _id: 0, MaterialName: 1, MaterialUnit: 1, MaterialPrice: 1 })
    .sort({ MaterialPrice: 1 })
    .toArray();
  for (const s of sibs)
    console.log(`   ${String(s.MaterialPrice).padStart(10)}  ${s.MaterialUnit.padEnd(10)} ${s.MaterialName}`);
}

await rg.close();
