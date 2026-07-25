import { TenantAiQuota } from "../models/index.js";
import { QuotaExceededError } from "../middleware/errors.js";
import { config } from "../config/index.js";

function nextMonthStart(from = new Date()) {
  return new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 1));
}

export async function getQuota(tenantId) {
  let q = await TenantAiQuota.findOne({ tenantId });
  if (!q) {
    q = await TenantAiQuota.create({
      tenantId,
      plan: "standard",
      monthlyQuota: config.defaultMonthlyQuota,
      used: 0,
      resetAt: nextMonthStart(),
    });
  }
  if (q.resetAt <= new Date()) {
    q.used = 0;
    q.resetAt = nextMonthStart();
    await q.save();
  }
  return q;
}

// Checks the tenant's remaining quota for a feature. Throws QuotaExceededError
// (mapped to a clean 200 quota-reached response, not an error) when spent.
// Cache hits never consume quota — callers check the cache first.
export async function checkQuota(tenantId, feature) {
  const q = await getQuota(tenantId);
  const weight = config.featureWeights[feature] ?? 1;
  if (q.used + weight > q.monthlyQuota) {
    throw new QuotaExceededError({
      monthlyQuota: q.monthlyQuota,
      used: q.used,
      resetAt: q.resetAt,
    });
  }
  return { quota: q, weight };
}

export async function consumeQuota(tenantId, feature) {
  const weight = config.featureWeights[feature] ?? 1;
  await TenantAiQuota.updateOne({ tenantId }, { $inc: { used: weight } });
}
