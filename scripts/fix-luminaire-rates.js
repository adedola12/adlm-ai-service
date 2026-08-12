// Rebuild the installed luminaire rates from evidenced supply prices.
//
//   node scripts/fix-luminaire-rates.js            dry run
//   node scripts/fix-luminaire-rates.js --apply    writes
//
// THE PROBLEM
// The "MEP - Electrical - Luminaires (installed)" rows came from a priced bill
// where the electrical section was billed at many times the cost of the goods.
// Checked against current Nigerian supplier listings, a 12W LED ceiling fitting
// that sells for about NGN 3,500 was carried at NGN 169,000, and a 7W LED spot
// that sells for NGN 2,500 was carried at NGN 110,000. Those are 48x and 44x.
// Nothing about fixing a light fitting costs forty times the fitting.
//
// THE METHOD
// Each rate is rebuilt the way every other build-up in this catalog is built:
//
//     installed = supply + sundries + fixing labour
//
// Supply comes from current listings at Nigerian electrical distributors, cited
// per row below. Sundries are 10% of supply for flex, connectors and fixings.
// Labour uses this library's OWN rates, an electrician at NGN 10,000 a day with
// a mate at NGN 7,000, converted at the 1.4 gang factor over 8 hours that every
// engine here uses, which is NGN 2,975 an hour for the pair.
//
// These are NET installed costs. Overhead and profit are added by the rate
// engine on top, so they must not be baked in here.
//
// STATE GRADING IS PRESERVED
// Only Lagos is rebuilt from evidence. Every other state is moved by the SAME
// RATIO as Lagos, so the regional differences already in the catalog survive
// instead of being flattened to one national figure. Correcting the level is
// what is called for; discarding the grading is not.
//
// WHAT IS NOT TOUCHED
// The accessories (sockets and switches) sit at 2.5x to 3.3x their supply
// price, which is within the normal range for supply and fix on a small item.
// High, arguably, but not wrong, and not something to change without evidence.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");

const ELECTRICIAN = 10000, MATE = 7000;      // per day, from this library
const GANG_HR = ((ELECTRICIAN + MATE) * 1.4) / 8;   // 2,975/hr
const SUNDRIES = 0.10;

const round = (n) => Math.round(n / 500) * 500;

const TARGETS = [
  {
    name: "LED spot light, ceiling mounted, 1 x 7W",
    supply: 2500, hours: 0.75, evidenced: true,
    source: "7W LED downlight, NGN 2,500, electrical.com.ng (Newton Electric), Aug 2026",
  },
  {
    name: "LED ceiling fitting, 1 x 12W",
    supply: 3500, hours: 0.75, evidenced: true,
    source: "12W round surface mounted LED panel, NGN 3,500 electrical.com.ng; NGN 2,050 electricmall.com.ng. Higher of the two taken.",
  },
  {
    name: "LED panel light 600 x 600mm, 4000K",
    supply: 26500, hours: 1.5, evidenced: true,
    source: "AKT LED edge lit troffer 600x600 40W/50W, NGN 26,500, electricmall.com.ng, Aug 2026",
  },
  {
    name: "Wall bracket fitting, 1 x 20W",
    supply: 8500, hours: 1.0, evidenced: true,
    source: "18W LED polycarbonate wall light, NGN 8,500, electrical.com.ng, Aug 2026",
  },
  {
    name: "External wall bracket (bulkhead) light, 20W",
    supply: 9500, hours: 1.0, evidenced: true,
    source: "Bulkhead outdoor security light, NGN 9,500, electrical.com.ng, Aug 2026",
  },
  {
    name: "LED batten/fluorescent fitting, 40W x 600mm",
    supply: 8000, hours: 1.0, evidenced: false,
    source: "ESTIMATE. No batten listing found. Priced at the 18W polycarbonate wall light level, NGN 8,500, as the nearest sealed linear fitting.",
  },
  {
    name: "Mirror light, 10W",
    supply: 12000, hours: 1.0, evidenced: false,
    source: "ESTIMATE. Only listing found was a branded Eterna dual voltage shaver light at NGN 45,000, which is a premium item. Priced above the plain wall lights instead.",
  },
  {
    name: "Chandelier fitting, 4 x 20W",
    supply: 35000, hours: 3.0, evidenced: false,
    source: "ESTIMATE. Decorative fittings have no single market price. Priced at the top of the observed decorative range, NGN 35,000, with 3 hours for assembly and hanging.",
  },
];

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const col = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}`);
console.log(`gang rate: NGN ${GANG_HR.toFixed(0)}/hr (electrician ${ELECTRICIAN} + mate ${MATE} per day, 1.4 factor over 8h)\n`);

const ops = [];
let totalRows = 0;

for (const t of TARGETS) {
  const lagos = await col.findOne({ MaterialName: t.name, state: "lagos" });
  if (!lagos) { console.log(`   SKIP (not found in lagos): ${t.name}`); continue; }

  const built = round(t.supply * (1 + SUNDRIES) + t.hours * GANG_HR);
  const old = Number(lagos.MaterialPrice);
  const ratio = built / old;

  console.log(`   ${t.name}`);
  console.log(`      supply ${t.supply.toLocaleString()} + ${(SUNDRIES * 100).toFixed(0)}% sundries + ${t.hours}h gang`);
  console.log(`      ${old.toLocaleString()}  ->  ${built.toLocaleString()}   (x${ratio.toFixed(3)}, was x${(old / t.supply).toFixed(1)} of supply)`);
  console.log(`      ${t.evidenced ? "EVIDENCED" : "ESTIMATE"}: ${t.source}`);

  // Move every other state by the same ratio, so the regional grading survives.
  const all = await col.find({ MaterialName: t.name }).toArray();
  totalRows += all.length;
  for (const doc of all) {
    const next = doc.state === "lagos" ? built : round(Number(doc.MaterialPrice) * ratio);
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            MaterialPrice: next,
            priceBasis: t.evidenced ? "supplier-listing" : "estimated",
            priceBasisNote: `Rebuilt as supply + 10% sundries + ${t.hours}h electrician and mate. ${t.source}`,
          },
        },
      },
    });
  }
  console.log(`      ${all.length} rows across states\n`);
}

console.log(`rows to update: ${totalRows}`);

if (!APPLY) {
  console.log(`\nRe-run with --apply to write.`);
  await rg.close();
  process.exit(0);
}

const res = await col.bulkWrite(ops, { ordered: false });
console.log(`\nmodified: ${res.modifiedCount}`);

console.log(`\nVERIFY (lagos):`);
for (const t of TARGETS) {
  const d = await col.findOne({ MaterialName: t.name, state: "lagos" }, { projection: { MaterialPrice: 1, priceBasis: 1 } });
  console.log(`   ${String(d?.MaterialPrice ?? "?").padStart(8)}  [${d?.priceBasis}]  ${t.name}`);
}

await rg.close();
