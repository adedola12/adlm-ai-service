// Repair the corrupted roofing sheet pair and the four zero-priced materials.
//
//   node scripts/repair-zero-and-corrupt-rows.js            dry run
//   node scripts/repair-zero-and-corrupt-rows.js --apply    writes
//
// WHY THIS MATTERS
// A material at zero does not fail loudly. It prices every build-up that uses
// it a little low, and the rate still looks like a rate. That is the same class
// of fault as the three zero-cost lookups fixed earlier in this catalog.
//
// TWO DIFFERENT REPAIRS, ON DIFFERENT FOOTINGS
//
// 1. The roofing sheet pair is DATA RECOVERY, not estimation. Someone editing
//    "0.55mm (24SWG) sheet, coloured" typed an extra d into the name and "lm"
//    into the category, and the price was zeroed. The real row survives under
//    the typo'd name with its price and category intact. This copies them back
//    onto the correctly named row and removes the typo. Nothing is invented.
//
// 2. The other three are ESTIMATES, derived from a priced neighbour in the same
//    category, and they are labelled as such on the row. They are not quotations
//    and should be replaced when a supplier list arrives. A defensible estimate
//    beats a silent zero, but only if it is not passed off as evidence.
//
// Every price is resolved PER STATE from that state's own neighbour, so the
// regional grading already in the catalog is preserved rather than flattened to
// the Lagos figure.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");

const TYPO = "0.55mm (24SWG) sheet, colouredd";
const REAL = "0.55mm (24SWG) sheet, coloured";
const ROOF_CAT = "Longspan Aluminium Roofing Sheet";

// name -> how to price it from a neighbour in the same state
const ESTIMATES = [
  {
    name: "60/70 ex PH",
    unit: "Tonne",
    from: "80/100 ex PH",
    factor: 1,
    basis: "priced equal to 80/100 ex PH, the adjacent penetration grade in the same category",
  },
  {
    name: "Pealux Vinyl Enamel",
    unit: "4 Litre",
    from: "Enamel, Vinyl. Colour Yellow",
    factor: 1,
    basis: "priced equal to the other vinyl enamel at the same 4 litre size",
  },
  {
    name: "Pealux Marine Undercoat (20 Litre)",
    unit: "20 Litre",
    from: "Pealux Marine Undercoat",
    // The only 4L/20L pair in the catalog is Peacotex Textured Finish at 3,450
    // and 5,200, so a 20 litre tin carries about 1.5 times the 4 litre price
    // rather than 5 times it. Using that observed ratio rather than assuming
    // volume scales linearly, which the data plainly says it does not.
    ratioFrom: ["Peacotex Textured Finish (Standard White)", "Peacotex Textured Finish (B/W)"],
    basis: "4 litre price scaled by the observed 20 litre to 4 litre ratio of the one such pair in the catalog",
  },
];

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const col = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

const scopeKey = (d) => `${d.state ?? ""}|${d.zone ?? ""}`;

/* ---------------- 1. roofing sheet recovery ---------------- */

const typos = await col.find({ MaterialName: TYPO }).toArray();
const reals = await col.find({ MaterialName: REAL }).toArray();
const realByScope = new Map(reals.map((d) => [scopeKey(d), d]));

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}\n`);
console.log(`1. ROOFING SHEET RECOVERY`);
console.log(`   "${TYPO}" rows: ${typos.length}`);
console.log(`   "${REAL}" rows: ${reals.length}`);

const roofOps = [];
const orphanTypos = [];
for (const t of typos) {
  const r = realByScope.get(scopeKey(t));
  if (!r) { orphanTypos.push(t); continue; }
  roofOps.push({
    updateOne: {
      filter: { _id: r._id },
      update: { $set: { MaterialPrice: t.MaterialPrice, MaterialCategory: ROOF_CAT } },
    },
  });
}

// Only delete a typo row once its price has a home to go to. Deleting an
// orphan would destroy the only copy of that price.
const deletableIds = typos.filter((t) => realByScope.has(scopeKey(t))).map((t) => t._id);

const sample = typos.slice(0, 3).map((t) => `${t.state ?? t.zone}=${t.MaterialPrice}`).join(", ");
console.log(`   would set ${roofOps.length} rows to their real price and category (${sample}, ...)`);
console.log(`   would delete ${deletableIds.length} typo rows`);
if (orphanTypos.length)
  console.log(`   LEAVING ${orphanTypos.length} typo row(s) alone: no matching correctly named row`);

/* ---------------- 2. estimates from neighbours ---------------- */

console.log(`\n2. ZERO PRICES, ESTIMATED FROM A NEIGHBOUR`);

const estOps = [];
const unresolved = [];

for (const est of ESTIMATES) {
  const targets = await col.find({ MaterialName: est.name }).toArray();
  let done = 0;
  const seen = [];

  for (const t of targets) {
    if (Number(t.MaterialPrice) > 0) continue;   // already priced, leave it

    const src = await col.findOne({
      MaterialName: est.from,
      state: t.state ?? { $exists: false },
      zone: t.zone ?? { $exists: false },
    });
    if (!src || !(Number(src.MaterialPrice) > 0)) { unresolved.push(`${est.name} @ ${scopeKey(t)}`); continue; }

    let factor = est.factor ?? 1;
    if (est.ratioFrom) {
      const [smallName, bigName] = est.ratioFrom;
      const small = await col.findOne({ MaterialName: smallName, state: t.state ?? { $exists: false }, zone: t.zone ?? { $exists: false } });
      const big = await col.findOne({ MaterialName: bigName, state: t.state ?? { $exists: false }, zone: t.zone ?? { $exists: false } });
      if (!small || !big || !(Number(small.MaterialPrice) > 0)) { unresolved.push(`${est.name} ratio @ ${scopeKey(t)}`); continue; }
      factor = Number(big.MaterialPrice) / Number(small.MaterialPrice);
    }

    const price = Math.round(Number(src.MaterialPrice) * factor);
    if (!(price > 0)) { unresolved.push(`${est.name} computed ${price} @ ${scopeKey(t)}`); continue; }

    estOps.push({
      updateOne: {
        filter: { _id: t._id },
        update: {
          $set: {
            MaterialPrice: price,
            priceBasis: "estimated",
            priceBasisNote: est.basis,
          },
        },
      },
    });
    done++;
    if (seen.length < 3) seen.push(`${t.state ?? t.zone}=${price}`);
  }

  console.log(`   "${est.name}" [${est.unit}]`);
  console.log(`      ${est.basis}`);
  console.log(`      ${done} row(s) would be priced (${seen.join(", ")}${done > 3 ? ", ..." : ""})`);
}

if (unresolved.length) {
  console.log(`\n   COULD NOT RESOLVE ${unresolved.length}:`);
  unresolved.slice(0, 10).forEach((u) => console.log(`      ${u}`));
}

/* ---------------- write ---------------- */

if (!APPLY) {
  console.log(`\nRe-run with --apply to write.`);
  await rg.close();
  process.exit(0);
}

if (roofOps.length) {
  const r = await col.bulkWrite(roofOps, { ordered: false });
  console.log(`\nroofing rows updated: ${r.modifiedCount}`);
}
if (deletableIds.length) {
  const d = await col.deleteMany({ _id: { $in: deletableIds } });
  console.log(`typo rows deleted: ${d.deletedCount}`);
}
if (estOps.length) {
  const e = await col.bulkWrite(estOps, { ordered: false });
  console.log(`estimated rows priced: ${e.modifiedCount}`);
}

/* ---------------- verify ---------------- */

const stillZero = await col.countDocuments({ $or: [{ MaterialPrice: 0 }, { MaterialPrice: null }] });
const typoLeft = await col.countDocuments({ MaterialName: TYPO });
const badCat = await col.countDocuments({ MaterialCategory: "lm" });
console.log(`\nVERIFY across all states`);
console.log(`   materials still at zero: ${stillZero}`);
console.log(`   "${TYPO}" rows remaining: ${typoLeft}`);
console.log(`   rows still categorised "lm": ${badCat}`);

await rg.close();
