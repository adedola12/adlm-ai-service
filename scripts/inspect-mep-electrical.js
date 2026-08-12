// Read-only. Lists the MEP rows and, where the same item exists both as a
// supply price and as an installed price, the ratio between them.
//
// That ratio is the diagnostic. A socket outlet installed should cost its
// supply price plus conduit, cable, back box and an electrician's time, which
// lands somewhere around two to five times supply. A ratio of forty means the
// installed figure is not an installed figure at all.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const col = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const rows = await col
  .find({ state: "lagos", MaterialCategory: /^MEP/ })
  .project({ _id: 0, MaterialName: 1, MaterialUnit: 1, MaterialPrice: 1, MaterialCategory: 1 })
  .sort({ MaterialCategory: 1, MaterialPrice: 1 })
  .toArray();

const byCat = {};
for (const r of rows) (byCat[r.MaterialCategory] ||= []).push(r);

for (const [cat, list] of Object.entries(byCat)) {
  console.log(`\n=== ${cat}  (${list.length}) ===`);
  for (const r of list)
    console.log(`   ${String(r.MaterialPrice).padStart(10)}  ${String(r.MaterialUnit).padEnd(6)} ${r.MaterialName}`);
}

// Pair supply against installed on the same base name.
const strip = (s) => s.replace(/\s*\((supply|installed)\)\s*$/i, "");
const supply = new Map(), installed = new Map();
for (const r of rows) {
  const cat = r.MaterialCategory || "";
  const key = `${r.MaterialName}`.toLowerCase();
  if (/\(supply\)$/i.test(cat)) supply.set(key, r);
  if (/\(installed\)$/i.test(cat)) installed.set(key, r);
}

console.log(`\n\n=== SUPPLY vs INSTALLED, same name ===`);
let pairs = 0;
for (const [k, ins] of installed) {
  const sup = supply.get(k);
  if (!sup || !(sup.MaterialPrice > 0)) continue;
  pairs++;
  const ratio = ins.MaterialPrice / sup.MaterialPrice;
  console.log(`   x${ratio.toFixed(1).padStart(6)}  supply ${String(sup.MaterialPrice).padStart(8)} -> installed ${String(ins.MaterialPrice).padStart(9)}  ${ins.MaterialName}`);
}
console.log(`   pairs found: ${pairs}`);

await rg.close();
