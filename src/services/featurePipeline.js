import { checkQuota, consumeQuota } from "../governance/quota.js";
import { checkCreditGuard } from "../governance/creditGuard.js";
import { cacheKey, cacheGet, cacheSet } from "../governance/cache.js";
import { recordCacheHit } from "../governance/meterAiCall.js";
import { VerdictAudit } from "../models/index.js";
import { libraryVersion } from "../grounding/rateLibrary.js";
import { config } from "../config/index.js";

// Shared request flow every feature passes through:
//   entitlement (route middleware) → credit guard → cache → quota → compute
//   → audit → cache write → quota consume.
// compute({ dataVersion }) must return { result, model, confidence }.
export async function runFeature({ tenantId, product, feature, input, compute }) {
  await checkCreditGuard(feature);

  const dataVersion = await libraryVersion();
  const inputHash = cacheKey({ feature, input, dataVersion });

  const cached = await cacheGet(inputHash);
  if (cached) {
    await recordCacheHit({ tenantId, product, feature, model: cached.model });
    return {
      ok: true,
      cached: true,
      feature,
      result: cached.result,
      audit: { model: cached.model, dataVersion, promptVersion: config.promptVersion },
      disclaimer: config.disclaimer,
    };
  }

  await checkQuota(tenantId, feature);

  const { result, model, confidence } = await compute({ dataVersion });

  await VerdictAudit.create({
    tenantId,
    feature,
    inputHash,
    model,
    promptVersion: config.promptVersion,
    dataVersion,
    confidence: confidence ?? null,
    summary: compactSummary(result),
  }).catch((err) => console.error("[audit] write failed:", err.message));

  await cacheSet({ inputHash, feature, result, model });
  await consumeQuota(tenantId, feature);

  return {
    ok: true,
    cached: false,
    feature,
    result,
    audit: {
      model,
      confidence: confidence ?? null,
      dataVersion,
      promptVersion: config.promptVersion,
      inputHash,
    },
    disclaimer: config.disclaimer,
  };
}

function compactSummary(result) {
  const s = JSON.stringify(result);
  return s.length > 4000 ? { truncated: true, head: s.slice(0, 4000) } : result;
}
