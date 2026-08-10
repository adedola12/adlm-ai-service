// Zone-aware loader for the RateGen master price library.
//
// Replaces seed-rategen-prices.js, which keyed on SerialNumber and is now
// guarded off: the master collections are keyed on NAME + ZONE and carry no
// SerialNumber at all, so the old script could only ever have updated one
// arbitrary zone per item.
//
//   node scripts/load-rategen-catalog.js                 dry run, prints a diff
//   node scripts/load-rategen-catalog.js --apply         writes
//   node scripts/load-rategen-catalog.js --zone=south_west --apply
//
// DRY RUN IS THE DEFAULT. Nothing is written without --apply.
//
// Zone factors are DERIVED from the library's own data, not invented: the 63
// materials that are currently priced in all six zones give a consistent
// median ratio against south_west, and those ratios are applied to every row.
// south_west is the base because the bundled catalog is priced off Lagos
// bills and Lagos market observation.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const ZONE_FACTORS = {
  south_west: 1.0,
  north_central: 1.0204,
  north_east: 1.0612,
  south_east: 1.0714,
  north_west: 1.0918,
  south_south: 1.125,
};

const args = process.argv.slice(2);
const APPLY = args.includes("--apply");
const onlyZone = (args.find((a) => a.startsWith("--zone=")) || "").split("=")[1] || null;
const rategenDir = args.find((a) => !a.startsWith("--")) || "C:/Users/ADLM/source/repos/ADLMRateGen";

const load = (f) =>
  JSON.parse(readFileSync(join(rategenDir, "Data", f), "utf-8").replace(/^\uFEFF/, ""));

const materials = load("defaultMaterials.json");
const labours = load("defaultLabours.json");

// Round the way a price list is quoted, not the way a float lands.
const round = (v) => {
  if (!v) return 0;
  if (v < 1_000) return Math.round(v / 5) * 5;
  if (v < 100_000) return Math.round(v / 50) * 50;
  return Math.round(v / 500) * 500;
};

const zones = onlyZone ? [onlyZone] : Object.keys(ZONE_FACTORS);
for (const z of zones) {
  if (!(z in ZONE_FACTORS)) {
    console.error(`Unknown zone "${z}". Known: ${Object.keys(ZONE_FACTORS).join(", ")}`);
    process.exit(1);
  }
}

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);

async function loadKind(collName, rows, nameField, unitField, priceField, catField) {
  const coll = db.collection(collName);
  let created = 0, changed = 0, unchanged = 0;
  const samples = [];

  for (const zone of zones) {
    const factor = ZONE_FACTORS[zone];
    const existing = new Map(
      (await coll.find({ zone }, { projection: { _id: 0, [nameField]: 1, [priceField]: 1, [unitField]: 1 } }).toArray())
        .map((r) => [r[nameField], { price: Number(r[priceField]) || 0, unit: r[unitField] }])
    );

    const ops = [];
    for (const r of rows) {
      const name = r[nameField];
      const price = round((Number(r[priceField]) || 0) * factor);
      const prev = existing.get(name);

      if (!prev) created++;
      else if (Math.abs(prev.price - price) > 0.5 || prev.unit !== r[unitField]) {
        changed++;
        if (samples.length < 12 && zone === "south_west")
          samples.push(`    ${name.slice(0, 40).padEnd(40)} ${String(prev.price).padStart(12)} -> ${String(price).padStart(12)}  ${prev.unit || "?"} -> ${r[unitField]}`);
      } else unchanged++;

      ops.push({
        updateOne: {
          filter: { [nameField]: name, zone },
          update: {
            $set: {
              [nameField]: name,
              [unitField]: r[unitField],
              [priceField]: price,
              [catField]: r[catField],
              zone,
              updatedAt: new Date().toISOString(),
              updatedBy: "catalog-2026.08-loader",
            },
          },
          upsert: true,
        },
      });
    }

    if (APPLY && ops.length) {
      const res = await coll.bulkWrite(ops, { ordered: false });
      console.log(`  ${zone.padEnd(15)} x${factor}  upserted=${res.upsertedCount} modified=${res.modifiedCount}`);
    } else {
      console.log(`  ${zone.padEnd(15)} x${factor}  would write ${ops.length} rows`);
    }
  }

  console.log(`  → new=${created} changed=${changed} unchanged=${unchanged}`);
  if (samples.length) {
    console.log("  sample south_west changes:");
    samples.forEach((s) => console.log(s));
  }
}

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes — pass --apply)"} to ${config.rategenMasterDb}`);
console.log(`source: ${rategenDir}\\Data  (${materials.length} materials, ${labours.length} labour)\n`);

console.log(`${config.rategenMatCollection}:`);
await loadKind(config.rategenMatCollection, materials, "MaterialName", "MaterialUnit", "MaterialPrice", "MaterialCategory");

console.log(`\n${config.rategenLabCollection}:`);
await loadKind(config.rategenLabCollection, labours, "LabourName", "LabourUnit", "LabourPrice", "LabourCategory");

await client.close();
console.log(APPLY ? "\nDone." : "\nDry run only. Re-run with --apply to write.");
