// Feature test: breakdown fill against real BoQ descriptions — grounding reads
// the real RateGen master price lists, plus model routing, caching, quota,
// audit and metering. Run AFTER test-meter.js passes.
//
//   node scripts/test-breakdown-fill.js               # built-in HERON bill sample
//   node scripts/test-breakdown-fill.js bill.json     # [{ref,description,unit,quantity,rateNgn,known}]
import "dotenv/config";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import { connectAiDb } from "../src/db/connect.js";
import { breakdownFill } from "../src/services/breakdownFillService.js";
import { AiUsageEvent } from "../src/models/index.js";

// A bill-shaped sample: items sit under heading trails, and two of them are
// elliptical continuations — the two conventions that decide whether this
// endpoint works on a real BoQ rather than on a tidy list of sentences.
// Descriptions are written to match the shape of live Nigerian bills; no client
// bill is committed here, because this repository is public. Point the script at
// your own export to test against real content:
//   node scripts/test-breakdown-fill.js my-boq.json
const SAMPLE = [
  {
    ref: "1",
    section: "UNREINFORCED CONCRETE",
    headings: ["E10: MIXING/CASTING/CURING/IN-SITU CONCRETE", "10MPa/19mm concrete"],
    description: "Column bases; thickness not exceeding 50mm",
    unit: "m3",
    quantity: 10,
    rateNgn: 75000,
  },
  {
    ref: "2",
    section: "UNREINFORCED CONCRETE",
    headings: ["10MPa/19mm concrete", "20MPa/19mm concrete"],
    // Opens in lower case: continues the item above it.
    description: "strip foundations; poured on or against earth and in steps",
    unit: "m3",
    quantity: 15,
    rateNgn: 75000,
  },
  {
    ref: "3",
    section: "M10: SAND CEMENT/CONCRETE/SCREEDS/TOPPINGS",
    headings: ["Mortar, cement and sand (1:3) screeded bed.", "30mm work to floors on concrete base; one coat"],
    // "Skirting" alone is meaningless — the trail makes it a screeded skirting.
    description: "Skirting",
    unit: "m",
    quantity: 655,
    rateNgn: 450,
  },
  {
    ref: "4",
    section: "M40: STONE/QUARRY/CERAMIC TILING/MOSAIC",
    headings: ["10mm Porcelain/Vitrified tiles laid to 2mm spacing and fixed with adhesive"],
    description: "Patterned, width exceeding 300; (Bedrooms)",
    unit: "m2",
    quantity: 276,
    rateNgn: 18500,
    known: [{ name: "Porcelain floor tile 600x600", quantity: 1.05, unit: "m2", unitPriceNgn: 9500 }],
  },
  {
    ref: "5",
    section: "M40: STONE/QUARRY/CERAMIC TILING/MOSAIC",
    headings: ["10mm Porcelain/Vitrified tiles laid to 2mm spacing and fixed with adhesive"],
    // Ditto: the same tile as item 4, in a different room.
    description: "Ditto; width exceeding 300; (Toilets)",
    unit: "m²",
    quantity: 48,
    rateNgn: 18500,
  },
  {
    ref: "6",
    section: "SUBSTRUCTURE",
    headings: ["Nature and location of the work"],
    // Names no physical work: the right answer is nothing at all.
    description: "The contractor is referred to the Architectural and Structural drawings",
    unit: "",
    quantity: 0,
    rateNgn: 0,
  },
];

const items = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : SAMPLE;

await connectAiDb();
console.log(`Filling breakdowns for ${items.length} item(s)\n`);

const started = Date.now();
const res = await breakdownFill({
  tenantId: "meter-test",
  product: "heron",
  items,
  zone: "south_west",
});
const elapsed = Date.now() - started;
const r = res.result;

console.log(`— Result (${elapsed}ms, cached=${res.cached}, model=${res.audit.model}) —`);
console.log(
  `${r.summary.filled}/${r.summary.items} items filled, ${r.summary.lines} lines` +
    (r.summary.unfilled.length ? `   unfilled: ${r.summary.unfilled.join(", ")}` : ""),
);

for (const item of r.items) {
  const src = items.find((i) => String(i.ref) === item.ref);
  const trail = (src?.headings || []).slice(-1).join("");
  console.log(
    `\n[${item.ref}] ${trail ? trail.slice(0, 44) + "  >  " : ""}${String(src?.description || "").slice(0, 60)}  (${item.unit})`,
  );
  if (!item.lines.length) {
    console.log("  — nothing proposed —");
  } else {
    console.table(
      item.lines.map((l) => ({
        kind: l.kind,
        name: l.name.slice(0, 38),
        "qty/unit": l.quantity,
        unit: l.unit,
        "₦/unit": l.unitPriceNgn,
        "₦ total": l.totalNgn,
        source: l.source,
      })),
    );
  }
  const c = item.coverage;
  console.log(
    `  net/unit ₦${c.filledNetNgn} (known ₦${c.knownNetNgn})` +
      (c.rateNgn ? `  vs rate ₦${c.rateNgn} → covers ${(c.coverageOfRate * 100).toFixed(0)}%, residual ₦${c.residualNgn}` : "  (no rate given)") +
      `   conf ${item.confidence}`,
  );
  if (item.note) console.log(`  note: ${item.note}`);
  for (const w of item.warnings) console.log(`  ⚠ ${w}`);
}

const events = await AiUsageEvent.find({ feature: "breakdownFill" }).sort({ createdAt: -1 }).limit(5).lean();
console.log(`\n— Metering (last ${events.length} calls) —`);
for (const e of events) {
  console.log(`  ${e.model}  in=${e.inputTokens} out=${e.outputTokens}  $${(e.costUsd || 0).toFixed(5)}`);
}
console.log(`\nDisclaimer: ${res.disclaimer}`);

await mongoose.disconnect();
