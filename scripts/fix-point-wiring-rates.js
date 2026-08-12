// Rebuild the two point wiring rates from a component take-off.
//
//   node scripts/fix-point-wiring-rates.js            dry run
//   node scripts/fix-point-wiring-rates.js --apply    writes
//
// Point wiring has no supply price to check against: it is conduit, cable,
// boxes and time. So unlike the luminaires, this cannot be caught by comparing
// a rate to the cost of the goods. It has to be built.
//
// COMPONENT PRICES, from current Nigerian distributor listings, Aug 2026:
//   1.5mm2 single core copper   NGN 31,000 / 100m coil  =  NGN 310/m
//   2.5mm2 single core copper   NGN 56,000 / 100m coil  =  NGN 560/m
//   20mm PVC conduit            NGN 28,000 / bundle of 25 x 2.9m = NGN 386/m
//   Boxes                       estimated at NGN 700 each, about 3% of the
//                               rate, so the estimate does not carry it
//
// LABOUR, from this library's own rates at the 1.4 gang factor over 8 hours:
//   electrician 10,000/day + mate 7,000/day  =  NGN 2,975/hr for the pair
//   labourer     5,500/day                   =  NGN   963/hr, for chasing and
//                                               making good
//
// THE ASSUMPTION THAT MATTERS
// Everything above is evidenced except the RUN LENGTH per point, which is a
// take-off judgement and is the single biggest term in the answer. 12m of
// conduit for a lighting point including the switch drop, and 10m for a socket
// point, are ordinary allowances. They are declared here rather than buried,
// because someone who works to different lengths should change them and re-run
// rather than trust a number whose basis they cannot see.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const APPLY = process.argv.includes("--apply");

const CABLE_15 = 31000 / 100;          // 310/m
const CABLE_25 = 56000 / 100;          // 560/m
const CONDUIT_20 = 28000 / (25 * 2.9); // 386/m
const BOX = 700;

const GANG_HR = ((10000 + 7000) * 1.4) / 8;  // 2,975
const LAB_HR = (5500 * 1.4) / 8;             // 963

const FITTINGS_PCT = 0.15;   // bends, couplers, saddles, as a share of conduit
const SUNDRIES = 500;        // tape, screws, testing consumables

const round = (n) => Math.round(n / 500) * 500;

const POINTS = [
  {
    name: "Point wiring, lighting point, concealed PVC conduit",
    runM: 12, cores: 3, cable: CABLE_15, cableLabel: "1.5mm2",
    boxes: 2, gangHours: 3.5, labHours: 2,
    note: "12m run including the switch drop. 3 cores: live, neutral, earth. Two boxes: ceiling point and switch.",
  },
  {
    name: "Point wiring, socket/power point, concealed PVC conduit",
    runM: 10, cores: 3, cable: CABLE_25, cableLabel: "2.5mm2",
    boxes: 1, gangHours: 3.5, labHours: 2,
    note: "10m run. 3 cores of 2.5mm2 for a power circuit. One back box.",
  },
];

const rg = new MongoClient(process.env.RATEGEN_MONGO_URI);
await rg.connect();
const col = rg.db(config.rategenMasterDb).collection(config.rategenMatCollection);

console.log(`${APPLY ? "APPLYING" : "DRY RUN (no writes)"}\n`);

const ops = [];
let totalRows = 0;

for (const p of POINTS) {
  const conduit = p.runM * CONDUIT_20;
  const cable = p.runM * p.cores * p.cable;
  const boxes = p.boxes * BOX;
  const fittings = conduit * FITTINGS_PCT;
  const materials = conduit + cable + boxes + fittings + SUNDRIES;

  const gang = p.gangHours * GANG_HR;
  const lab = p.labHours * LAB_HR;
  const labour = gang + lab;

  const built = round(materials + labour);

  const lagos = await col.findOne({ MaterialName: p.name, state: "lagos" });
  if (!lagos) { console.log(`   SKIP (not in lagos): ${p.name}`); continue; }
  const old = Number(lagos.MaterialPrice);
  const ratio = built / old;

  console.log(`   ${p.name}`);
  console.log(`      ${p.note}`);
  console.log(`      conduit   ${p.runM}m x ${CONDUIT_20.toFixed(0)}            = ${Math.round(conduit).toLocaleString().padStart(8)}`);
  console.log(`      cable     ${p.runM}m x ${p.cores} core ${p.cableLabel} x ${p.cable}  = ${Math.round(cable).toLocaleString().padStart(8)}`);
  console.log(`      boxes     ${p.boxes} x ${BOX}                = ${boxes.toLocaleString().padStart(8)}`);
  console.log(`      fittings  ${(FITTINGS_PCT * 100).toFixed(0)}% of conduit          = ${Math.round(fittings).toLocaleString().padStart(8)}`);
  console.log(`      sundries                        = ${SUNDRIES.toLocaleString().padStart(8)}`);
  console.log(`      labour    ${p.gangHours}h gang + ${p.labHours}h labourer   = ${Math.round(labour).toLocaleString().padStart(8)}`);
  console.log(`                                        --------`);
  console.log(`      built                             ${built.toLocaleString().padStart(8)}`);
  console.log(`      current                           ${old.toLocaleString().padStart(8)}   (x${ratio.toFixed(2)})`);

  const all = await col.find({ MaterialName: p.name }).toArray();
  totalRows += all.length;
  for (const doc of all) {
    const next = doc.state === "lagos" ? built : round(Number(doc.MaterialPrice) * ratio);
    ops.push({
      updateOne: {
        filter: { _id: doc._id },
        update: {
          $set: {
            MaterialPrice: next,
            priceBasis: "component-takeoff",
            priceBasisNote:
              `Built from ${p.runM}m of 20mm conduit and ${p.cores} cores of ${p.cableLabel} at Aug 2026 Nigerian distributor prices, `
              + `plus ${p.gangHours}h electrician and mate and ${p.labHours}h labourer at this library's own rates. `
              + `Run length is a take-off allowance, not an observed figure.`,
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
for (const p of POINTS) {
  const d = await col.findOne({ MaterialName: p.name, state: "lagos" }, { projection: { MaterialPrice: 1, priceBasis: 1 } });
  console.log(`   ${String(d?.MaterialPrice ?? "?").padStart(8)}  [${d?.priceBasis}]  ${p.name}`);
}

await rg.close();
