// Read-only. How far the corrupted roofing sheet pair reaches across states.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const c = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

for (const n of [
  "0.55mm (24SWG) sheet, coloured",
  "0.55mm (24SWG) sheet, colouredd",
  "0.55mm (24SWG) sheet, Stucco mill",
]) {
  const rows = await c
    .find({ MaterialName: n })
    .project({ _id: 0, state: 1, MaterialPrice: 1, MaterialCategory: 1 })
    .toArray();
  const prices = [...new Set(rows.map((r) => r.MaterialPrice))];
  const cats = [...new Set(rows.map((r) => r.MaterialCategory))];
  console.log(
    `"${n}"\n   rows=${rows.length}  prices=${JSON.stringify(prices)}  cats=${JSON.stringify(cats)}`,
  );
}

await rg.close();
