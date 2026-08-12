// Read-only. Dumps every document the repair script touches, so the change can
// be reversed exactly rather than re-derived.
//
//   node scripts/backup-affected-rows.js <outfile.json>
import "dotenv/config";
import fs from "node:fs";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const out = process.argv[2];
if (!out) { console.error("usage: node scripts/backup-affected-rows.js <outfile.json>"); process.exit(1); }

const NAMES = [
  "0.55mm (24SWG) sheet, coloured",
  "0.55mm (24SWG) sheet, colouredd",
  "60/70 ex PH",
  "Pealux Vinyl Enamel",
  "Pealux Marine Undercoat (20 Litre)",
];

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const col = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const docs = await col.find({ MaterialName: { $in: NAMES } }).toArray();
fs.writeFileSync(out, JSON.stringify(docs, null, 2));

const counts = {};
for (const d of docs) counts[d.MaterialName] = (counts[d.MaterialName] || 0) + 1;
console.log(`wrote ${docs.length} documents to ${out}`);
for (const [n, c] of Object.entries(counts)) console.log(`   ${c}  ${n}`);

await rg.close();
