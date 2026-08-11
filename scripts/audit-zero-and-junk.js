// Read-only audit of the master library. Writes nothing.
//
//   node scripts/audit-zero-and-junk.js
//
// Looks for the two failures that are invisible in a rate: a material priced at
// zero, which makes any build-up using it silently under-price, and a category
// that is not a real category, which drops the row out of every filter.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const db = rg.db(config.rategenMasterDb);

const mats = await db.collection(config.rategenMatCollection)
  .find({ state: "lagos" }, { projection: { _id: 0, MaterialName: 1, MaterialUnit: 1, MaterialPrice: 1, MaterialCategory: 1 } })
  .toArray();
const labs = await db.collection(config.rategenLabCollection)
  .find({ state: "lagos" }, { projection: { _id: 0, LabourName: 1, LabourUnit: 1, LabourPrice: 1, LabourCategory: 1 } })
  .toArray();

console.log(`lagos rows: ${mats.length} materials, ${labs.length} labour\n`);

const zeroM = mats.filter((m) => !(Number(m.MaterialPrice) > 0));
console.log(`MATERIALS PRICED AT ZERO: ${zeroM.length}`);
for (const m of zeroM)
  console.log(`  "${m.MaterialName}" [${m.MaterialUnit}] cat="${m.MaterialCategory}"`);

const zeroL = labs.filter((l) => !(Number(l.LabourPrice) > 0));
console.log(`\nLABOUR PRICED AT ZERO: ${zeroL.length}`);
for (const l of zeroL)
  console.log(`  "${l.LabourName}" [${l.LabourUnit}] cat="${l.LabourCategory}"`);

// A category used by only one or two rows and shorter than a real name is
// usually a stray keystroke landing in the wrong column.
const byCat = {};
for (const m of mats) {
  const c = String(m.MaterialCategory ?? "");
  (byCat[c] = byCat[c] || []).push(m.MaterialName);
}
const suspect = Object.entries(byCat)
  .filter(([c, rows]) => c.trim().length <= 4 && rows.length <= 3);
console.log(`\nSUSPECT CATEGORIES (very short, very few rows): ${suspect.length}`);
for (const [c, rows] of suspect)
  console.log(`  "${c}" -> ${rows.length} row(s): ${rows.slice(0, 4).join(" | ")}`);

console.log(`\nblank category: ${(byCat[""] || []).length} row(s)`);

// Near-duplicate names, which is what a typo'd row looks like next to the row
// it was meant to replace.
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const seen = new Map();
for (const m of mats) {
  const k = norm(m.MaterialName);
  (seen.get(k) ? seen.get(k) : seen.set(k, []).get(k)).push(m);
}
const dupes = [...seen.values()].filter((g) => g.length > 1);
console.log(`\nEXACT DUPLICATE NAMES (ignoring case/punctuation): ${dupes.length}`);
for (const g of dupes)
  console.log(`  ${g.map((m) => `"${m.MaterialName}" [${m.MaterialUnit}] ${m.MaterialPrice}`).join("   vs   ")}`);

// One-character-apart names: "coloured" vs "colouredd".
const names = mats.map((m) => ({ raw: m.MaterialName, n: norm(m.MaterialName), p: m.MaterialPrice, c: m.MaterialCategory }));
const near = [];
for (let i = 0; i < names.length; i++) {
  for (let j = i + 1; j < names.length; j++) {
    const a = names[i], b = names[j];
    if (Math.abs(a.n.length - b.n.length) !== 1) continue;
    const [shortS, longS] = a.n.length < b.n.length ? [a.n, b.n] : [b.n, a.n];
    if (!longS.startsWith(shortS) && !longS.endsWith(shortS)) continue;
    // one repeated trailing character is the classic double-key typo
    near.push([a, b]);
  }
}
console.log(`\nNAMES ONE CHARACTER APART: ${near.length}`);
for (const [a, b] of near.slice(0, 25))
  console.log(`  "${a.raw}" (${a.p}, cat="${a.c}")\n     vs "${b.raw}" (${b.p}, cat="${b.c}")`);

await rg.close();
