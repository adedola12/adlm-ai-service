// READ ONLY. Reports the live state of the RateGen master labour library.
//
//   node scripts/inspect-rategen-labour.js
//
// There is no --apply. This script cannot write.
//
// Written because a CSV export dated 31 Dec 2025 appeared to show 44 duplicate
// zero-priced rows in the Labour category, which would be a serious costing
// bug: a build-up resolving to a zero row loses its labour silently. But that
// export was read without looking at the `zone` column, and the materials side
// of this same library is known to have whole zones unpriced. So the zeros may
// be legitimate per-zone rows that are simply empty, which is a different
// problem with a different fix. This tells us which.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);
const coll = db.collection(config.rategenLabCollection || "labours");

const all = await coll.find({}, { projection: { _id: 0 } }).toArray();
console.log(`${config.rategenMasterDb}.${coll.collectionName}: ${all.length} rows\n`);

const zones = [...new Set(all.map((r) => r.zone))].sort();
console.log(`zones present: ${zones.join(", ")}\n`);

console.log("rows and zero-prices per zone:");
for (const z of zones) {
  const rows = all.filter((r) => r.zone === z);
  const zero = rows.filter((r) => !Number(r.LabourPrice));
  console.log(
    `  ${String(z).padEnd(16)} rows ${String(rows.length).padStart(4)}   zero-priced ${String(zero.length).padStart(4)}`
  );
}

console.log("\nby category, south_west only:");
const sw = all.filter((r) => r.zone === "south_west");
const byCat = {};
for (const r of sw) {
  const c = r.LabourCategory || "(none)";
  byCat[c] = byCat[c] || { n: 0, zero: 0 };
  byCat[c].n++;
  if (!Number(r.LabourPrice)) byCat[c].zero++;
}
for (const [c, v] of Object.entries(byCat)) {
  console.log(`  ${c.padEnd(18)} rows ${String(v.n).padStart(4)}   zero ${String(v.zero).padStart(4)}`);
}

// The real question: is a NAME duplicated inside one zone, or does it appear
// once per zone as it should?
console.log("\nnames duplicated WITHIN a single zone (this would be the bug):");
const dupes = [];
for (const z of zones) {
  const seen = {};
  for (const r of all.filter((x) => x.zone === z)) {
    const k = `${r.LabourName}|${r.LabourCategory || ""}`;
    seen[k] = seen[k] || [];
    seen[k].push(Number(r.LabourPrice) || 0);
  }
  for (const [k, prices] of Object.entries(seen)) {
    if (prices.length > 1) dupes.push({ zone: z, key: k, prices });
  }
}
if (!dupes.length) {
  console.log("  none. Every name appears at most once per zone.");
} else {
  dupes.slice(0, 30).forEach((d) =>
    console.log(`  ${d.zone.padEnd(15)} ${d.key.split("|")[0].slice(0, 40).padEnd(40)} prices: ${d.prices.join(", ")}`)
  );
  console.log(`  ${dupes.length} duplicated name+category combinations in total`);
}

console.log("\nLabour category, every zone, so the shape is visible:");
const labourRows = all.filter((r) => (r.LabourCategory || "") === "Labour");
const names = [...new Set(labourRows.map((r) => r.LabourName))].sort();
const hdr = zones.map((z) => z.slice(0, 8).padStart(9)).join("");
console.log(`  ${"name".padEnd(26)}${hdr}`);
for (const n of names) {
  const cells = zones
    .map((z) => {
      const hit = labourRows.filter((r) => r.LabourName === n && r.zone === z);
      if (!hit.length) return "-".padStart(9);
      const v = hit.map((h) => Number(h.LabourPrice) || 0);
      return (hit.length > 1 ? `${v.join("/")}!` : String(v[0])).padStart(9);
    })
    .join("");
  console.log(`  ${n.slice(0, 25).padEnd(26)}${cells}`);
}
console.log("\n  a ! marks more than one row for that name in that zone");

await client.close();
