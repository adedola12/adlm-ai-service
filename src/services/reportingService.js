import { AiUsageEvent, TenantAiQuota, PricingRate } from "../models/index.js";

// Internal reporting for ADLM — a few read routes, not a dashboard product.

export async function usage({ tenantId, feature, from, to, limit = 200 }) {
  const q = {};
  if (tenantId) q.tenantId = tenantId;
  if (feature) q.feature = feature;
  if (from || to) {
    q.createdAt = {};
    if (from) q.createdAt.$gte = new Date(from);
    if (to) q.createdAt.$lte = new Date(to);
  }
  return AiUsageEvent.find(q).sort({ createdAt: -1 }).limit(Math.min(limit, 1000)).lean();
}

export async function usageSummary({ from, to }) {
  const match = {};
  if (from || to) {
    match.createdAt = {};
    if (from) match.createdAt.$gte = new Date(from);
    if (to) match.createdAt.$lte = new Date(to);
  }
  return AiUsageEvent.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          tenantId: "$tenantId",
          feature: "$feature",
          product: "$product",
          month: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
        },
        calls: { $sum: 1 },
        cacheHits: { $sum: { $cond: ["$cacheHit", 1, 0] } },
        escalations: { $sum: { $cond: ["$escalated", 1, 0] } },
        inputTokens: { $sum: "$units.inputTokens" },
        outputTokens: { $sum: "$units.outputTokens" },
        pages: { $sum: "$units.pages" },
        costUsd: { $sum: "$estimatedCostUsd" },
        costNgn: { $sum: "$estimatedCostNgn" },
      },
    },
    {
      $project: {
        _id: 0,
        tenantId: "$_id.tenantId",
        feature: "$_id.feature",
        product: "$_id.product",
        month: "$_id.month",
        calls: 1,
        cacheHits: 1,
        cacheHitRate: {
          $cond: [{ $gt: ["$calls", 0] }, { $divide: ["$cacheHits", "$calls"] }, 0],
        },
        escalations: 1,
        inputTokens: 1,
        outputTokens: 1,
        pages: 1,
        costUsd: { $round: ["$costUsd", 4] },
        costNgn: { $round: ["$costNgn", 2] },
      },
    },
    { $sort: { month: -1, costUsd: -1 } },
  ]);
}

export async function listQuotas() {
  return TenantAiQuota.find({}).sort({ used: -1 }).lean();
}

export async function updateQuota(tenantId, patch) {
  const allowed = {};
  if (patch.monthlyQuota !== undefined) allowed.monthlyQuota = Number(patch.monthlyQuota);
  if (patch.plan !== undefined) allowed.plan = String(patch.plan);
  if (patch.used !== undefined) allowed.used = Number(patch.used);
  return TenantAiQuota.findOneAndUpdate({ tenantId }, { $set: allowed }, { new: true, upsert: true }).lean();
}

export async function listPricing() {
  return PricingRate.find({}).sort({ service: 1, model: 1 }).lean();
}

export async function updatePricing(id, patch) {
  const allowed = {};
  if (patch.priceUsd !== undefined) allowed.priceUsd = Number(patch.priceUsd);
  allowed.updatedAt = new Date();
  return PricingRate.findByIdAndUpdate(id, { $set: allowed }, { new: true }).lean();
}
