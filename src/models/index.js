import mongoose from "mongoose";

const { Schema } = mongoose;

// ── Metering ─────────────────────────────────────────────────────────────────
const AiUsageEventSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    product: { type: String, default: "" }, // which ADLM product made the call (quiv|heron|rategen|cloud|bk)
    feature: { type: String, required: true, index: true },
    service: { type: String, required: true }, // bedrock | textract
    model: { type: String, default: "" },
    operation: { type: String, default: "" },
    units: {
      inputTokens: { type: Number, default: 0 },
      outputTokens: { type: Number, default: 0 },
      pages: { type: Number, default: 0 },
    },
    estimatedCostUsd: { type: Number, default: 0 },
    estimatedCostNgn: { type: Number, default: 0 },
    cacheHit: { type: Boolean, default: false },
    escalated: { type: Boolean, default: false },
    latencyMs: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);
AiUsageEventSchema.index({ tenantId: 1, createdAt: -1 });

// ── Pricing (config-driven, never hardcoded) ─────────────────────────────────
const PricingRateSchema = new Schema(
  {
    service: { type: String, required: true }, // bedrock | textract
    model: { type: String, required: true }, // model id, or textract operation
    unit: { type: String, required: true }, // input_mtok | output_mtok | page
    priceUsd: { type: Number, required: true },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);
PricingRateSchema.index({ service: 1, model: 1, unit: 1 }, { unique: true });

// ── Per-tenant quota ─────────────────────────────────────────────────────────
const TenantAiQuotaSchema = new Schema(
  {
    tenantId: { type: String, required: true, unique: true },
    plan: { type: String, default: "standard" },
    monthlyQuota: { type: Number, required: true },
    used: { type: Number, default: 0 },
    resetAt: { type: Date, required: true },
  },
  { versionKey: false }
);

// ── Global credit account (config-editable) ──────────────────────────────────
const CreditAccountSchema = new Schema(
  {
    provider: { type: String, default: "aws-activate", unique: true },
    totalUsd: { type: Number, required: true },
    startDate: { type: Date, required: true },
    expiryDate: { type: Date, required: true },
    guardThreshold: { type: Number, default: 1.25 },
    updatedAt: { type: Date, default: Date.now },
  },
  { versionKey: false }
);

// ── Cache ────────────────────────────────────────────────────────────────────
const CacheEntrySchema = new Schema(
  {
    inputHash: { type: String, required: true, unique: true },
    feature: { type: String, required: true },
    result: { type: Schema.Types.Mixed },
    model: { type: String, default: "" },
    createdAt: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
  },
  { versionKey: false }
);
CacheEntrySchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// ── Verdict audit trail (Day-1 schema, immutable) ───────────────────────────
// Every user-facing AI verdict is recorded so any dispute can be traced to
// the exact inputs, data version, model and prompt that produced it.
const VerdictAuditSchema = new Schema(
  {
    tenantId: { type: String, required: true, index: true },
    feature: { type: String, required: true },
    inputHash: { type: String, required: true },
    model: { type: String, default: "" },
    promptVersion: { type: String, default: "" },
    dataVersion: { type: String, default: "" }, // RateGen library version at time of verdict
    confidence: { type: Number, default: null },
    summary: { type: Schema.Types.Mixed }, // compact verdict payload
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);
VerdictAuditSchema.pre("updateOne", function () {
  throw new Error("VerdictAudit is append-only");
});
VerdictAuditSchema.pre("findOneAndUpdate", function () {
  throw new Error("VerdictAudit is append-only");
});

// ── Per-tenant QS house style ────────────────────────────────────────────────
// What this firm's bills actually look like: how they word descriptions, which
// units they use for which work, how they order sections, and which AI
// suggestions they have taken or thrown out.
//
// STRICTLY PER TENANT. Nothing in here may be pooled, aggregated across
// accounts, or used to ground another tenant's suggestions. Bill descriptions
// and specifications are commercially sensitive tender content — a firm's
// wording appearing in a competitor's bill would be a serious breach, not a
// feature. Every read is by tenantId; there is deliberately no cross-tenant
// query path in qsProfile.js.
const QsExampleSchema = new Schema(
  {
    // The raw take-off wording, and what this firm turned it into.
    source: { type: String, default: "" },
    accepted: { type: String, required: true },
    unit: { type: String, default: "" },
    section: { type: String, default: "" },
    // "specification" (the QS wrote it themselves — the strongest signal),
    // "aiAccepted" (they took an AI suggestion), "aiRejected" (they refused one).
    origin: { type: String, required: true },
    at: { type: Date, default: Date.now },
  },
  { _id: false, versionKey: false }
);

const TenantQsProfileSchema = new Schema(
  {
    tenantId: { type: String, required: true, unique: true },
    // Capped, most-recent-first. A profile is a style sample, not an archive —
    // an unbounded list would grow past what can be put in a prompt and would
    // weight a firm's oldest habits as heavily as its current ones.
    examples: { type: [QsExampleSchema], default: [] },
    // unit conventions: normalised description keyword -> the unit this firm
    // consistently bills that work in.
    unitConventions: { type: Map, of: String, default: {} },
    // Section names in the order this firm arranges them.
    sectionOrder: { type: [String], default: [] },
    // Wording the firm has repeatedly rejected — fed to the model as things not
    // to propose again. Rejections are as informative as acceptances.
    rejectedPhrases: { type: [String], default: [] },
    updatedAt: { type: Date, default: Date.now },
    // Bumped on every write and folded into the cache key, so a profile change
    // does not keep serving suggestions made under the old house style.
    revision: { type: Number, default: 0 },
  },
  { versionKey: false }
);

export const AiUsageEvent = mongoose.model("AiUsageEvent", AiUsageEventSchema);
export const TenantQsProfile = mongoose.model("TenantQsProfile", TenantQsProfileSchema);
export const PricingRate = mongoose.model("PricingRate", PricingRateSchema);
export const TenantAiQuota = mongoose.model("TenantAiQuota", TenantAiQuotaSchema);
export const CreditAccount = mongoose.model("CreditAccount", CreditAccountSchema);
export const CacheEntry = mongoose.model("CacheEntry", CacheEntrySchema);
export const VerdictAudit = mongoose.model("VerdictAudit", VerdictAuditSchema);
