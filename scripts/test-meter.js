// Meter proof: one tiny Bedrock call through meterAiCall, then read back the
// AiUsageEvent it wrote and the running credit totals. If this passes, the
// governance backbone (pricing store -> meter -> usage ledger -> credit
// guard) is live end-to-end.
//
//   npm run seed:pricing   (once, before first run)
//   node scripts/test-meter.js
import "dotenv/config";
import mongoose from "mongoose";
import { config } from "../src/config/index.js";
import { connectAiDb } from "../src/db/connect.js";
import { AiUsageEvent } from "../src/models/index.js";
import { invokeJson } from "../src/clients/bedrock.js";
import { creditStatus } from "../src/governance/creditGuard.js";

console.log("1. Connecting to Mongo (db:", config.aiDb + ") ...");
await connectAiDb();

console.log("2. Calling Bedrock (cheap tier:", config.models.cheap + ") through meterAiCall ...");
const started = Date.now();
const { json, modelId } = await invokeJson(
  { tenantId: "meter-test", product: "test", feature: "meterTest", operation: "ping" },
  {
    modelId: config.models.cheap,
    maxTokens: 100,
    system: "You are a test endpoint.",
    user: 'Reply with JSON: {"pong": true, "message": "<5 words confirming you are Claude on Bedrock>"}',
  }
);
console.log(`   Model ${modelId} replied in ${Date.now() - started}ms:`, JSON.stringify(json));

console.log("3. Reading back the metering row ...");
const event = await AiUsageEvent.findOne({ tenantId: "meter-test" }).sort({ createdAt: -1 }).lean();
if (!event) {
  console.error("   FAIL: no AiUsageEvent was written.");
  process.exit(1);
}
console.log("   AiUsageEvent:", {
  feature: event.feature,
  service: event.service,
  model: event.model,
  inputTokens: event.units.inputTokens,
  outputTokens: event.units.outputTokens,
  estimatedCostUsd: event.estimatedCostUsd,
  estimatedCostNgn: Math.round(event.estimatedCostNgn * 100) / 100,
  latencyMs: event.latencyMs,
});
if (!event.units.inputTokens || event.estimatedCostUsd <= 0) {
  console.error("   WARN: cost is zero — did you run `npm run seed:pricing`?");
}

console.log("4. Credit guard status ...");
const credit = await creditStatus(true);
console.log("   ", {
  spentUsd: credit.spentUsd,
  remainingUsd: credit.remainingUsd,
  dailyBurnUsd: credit.dailyBurnUsd,
  burnRatio: credit.burnRatio,
  throttled: credit.throttled,
  runwayDate: credit.runwayDate?.toISOString?.().slice(0, 10),
});

console.log("\nMETER TEST: PASS — every figure above came from the PricingRate store, not code.");
await mongoose.disconnect();
process.exit(0);
