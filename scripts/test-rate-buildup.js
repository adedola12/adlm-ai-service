// Feature test: full rate build-up pipeline with a RateGen-style prompt —
// grounding reads from the real RateGen library, model routing, caching,
// quota, audit, metering. Run AFTER test-meter.js passes.
//
//   node scripts/test-rate-buildup.js "225mm sandcrete blockwork in cement mortar (1:6)" m2
import "dotenv/config";
import mongoose from "mongoose";
import { connectAiDb } from "../src/db/connect.js";
import { rateBuildup } from "../src/services/rateBuildupService.js";
import { AiUsageEvent, VerdictAudit } from "../src/models/index.js";

const description =
  process.argv[2] || "225mm hollow sandcrete blockwork in cement-sand mortar (1:6)";
const unit = process.argv[3] || "m2";

await connectAiDb();

console.log(`Building rate for: "${description}" (${unit})\n`);
const started = Date.now();
const res = await rateBuildup({
  tenantId: "meter-test",
  product: "rategen",
  description,
  zone: "south_west",
  unit,
});
const elapsed = Date.now() - started;

const r = res.result;
console.log(`— Result (${elapsed}ms, cached=${res.cached}, model=${res.audit.model}) —`);
console.log(`Unit: ${r.unit}   Notes: ${r.notes || "-"}`);
console.table(
  (r.components || []).map((c) => ({
    kind: c.kind,
    name: c.name.slice(0, 40),
    qty: c.quantity,
    unit: c.unit,
    "₦/unit": c.unitPriceNgn,
    "₦ total": c.totalNgn,
    source: c.source,
  }))
);
console.log(
  `Net ₦${r.netCostNgn}  + OH ${r.overheadPercent}% (₦${r.overheadNgn})  + Profit ${r.profitPercent}% (₦${r.profitNgn})`
);
console.log(`RATE: ₦${r.rateNgn} per ${r.unit}`);
console.log(`\nConfidence: ${res.audit.confidence ?? "n/a"}   Data version: ${res.audit.dataVersion}`);
console.log(`Disclaimer: ${res.disclaimer}`);

// Show what the governance layer recorded for this call.
const events = await AiUsageEvent.find({ tenantId: "meter-test", feature: "rateBuildup" })
  .sort({ createdAt: -1 })
  .limit(3)
  .lean();
console.log(
  "\nMetering rows:",
  events.map((e) => ({
    service: e.service,
    model: e.model,
    in: e.units.inputTokens,
    out: e.units.outputTokens,
    usd: e.estimatedCostUsd,
    cacheHit: e.cacheHit,
  }))
);
const audit = await VerdictAudit.findOne({ tenantId: "meter-test", feature: "rateBuildup" })
  .sort({ createdAt: -1 })
  .lean();
console.log("Audit row:", audit ? { model: audit.model, promptVersion: audit.promptVersion, dataVersion: audit.dataVersion, confidence: audit.confidence } : "none (cached run)");

console.log("\nTip: run the same command again — it should return cached=true, cost ₦0.");
await mongoose.disconnect();
process.exit(0);
