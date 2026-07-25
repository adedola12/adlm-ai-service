import { AiUsageEvent } from "../models/index.js";
import { costUsd, toNgn } from "./pricing.js";

// Every Bedrock and Textract call in this codebase goes through meterAiCall.
// No AI call may bypass it — this is the invariant the whole governance
// layer rests on (see CLAUDE.md).
//
//   const out = await meterAiCall(
//     { tenantId, product, feature, service: "bedrock", model, operation },
//     async () => ({ result, units: { inputTokens, outputTokens } })
//   );
//
// fn must return { result, units }. meterAiCall computes cost from the
// PricingRate store, persists an AiUsageEvent, and returns
// { result, units, costUsd, eventId }.
export async function meterAiCall(meta, fn) {
  const started = Date.now();
  let units = { inputTokens: 0, outputTokens: 0, pages: 0 };
  let result;
  try {
    const out = await fn();
    result = out.result;
    units = { ...units, ...(out.units || {}) };
  } finally {
    const latencyMs = Date.now() - started;
    try {
      const usd = await costUsd({ service: meta.service, model: meta.model, units });
      await AiUsageEvent.create({
        tenantId: meta.tenantId || "system",
        product: meta.product || "",
        feature: meta.feature,
        service: meta.service,
        model: meta.model || "",
        operation: meta.operation || "",
        units,
        estimatedCostUsd: usd,
        estimatedCostNgn: toNgn(usd),
        cacheHit: false,
        escalated: Boolean(meta.escalated),
        latencyMs,
      });
    } catch (err) {
      // Metering failures must never take the feature down, but they must be loud.
      console.error("[meterAiCall] failed to record usage event:", err.message);
    }
  }
  const usd = await costUsd({ service: meta.service, model: meta.model, units });
  return { result, units, costUsd: usd };
}

// Cache hits are recorded too (zero cost) so cache effectiveness is measurable.
export async function recordCacheHit(meta) {
  try {
    await AiUsageEvent.create({
      tenantId: meta.tenantId || "system",
      product: meta.product || "",
      feature: meta.feature,
      service: "cache",
      model: meta.model || "",
      operation: "hit",
      units: {},
      estimatedCostUsd: 0,
      estimatedCostNgn: 0,
      cacheHit: true,
      latencyMs: 0,
    });
  } catch (err) {
    console.error("[meterAiCall] failed to record cache hit:", err.message);
  }
}
