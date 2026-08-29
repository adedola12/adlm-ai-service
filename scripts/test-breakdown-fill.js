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

// Descriptions taken verbatim from a HERON take-off, including the two the
// first-principles calculator has no recipe for — the case this endpoint exists
// for. "Door Opening" is deliberately included: it names no physical work, and
// a correct answer returns nothing for it rather than inventing content.
const SAMPLE = [
  {
    ref: "A",
    description:
      "Vibrated hollow sancrete blocks in cement mortar (1:6) laid in stretcher bond Walls 230mm thick, vertical",
    unit: "SQ M",
    quantity: 234.51,
    rateNgn: 90888.7,
    known: [{ name: "Hollow sandcrete block 230mm", quantity: 12.5, unit: "nr", unitPriceNgn: 1200 }],
  },
  { ref: "A1", description: "Wall Rendering", unit: "SQ M", quantity: 469.02, rateNgn: 6062.94 },
  { ref: "C", description: "Door Opening", unit: "SQ M", quantity: 53.33, rateNgn: 1345.43 },
  {
    ref: "C3",
    description: "12mm bar and 10mm link bar in lintel",
    unit: "Kg",
    quantity: 46.6,
    rateNgn: 0,
  },
  { ref: "FF", description: "Railing", unit: "M", quantity: 18.2, rateNgn: 13573.98 },
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
  console.log(`\n[${item.ref}] ${String(src?.description || "").slice(0, 70)}  (${item.unit})`);
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
