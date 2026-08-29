// Load .env from the repo root regardless of the process working directory
// (local dev may launch from a parent folder; Lambda has no .env and no-ops).
import { config as loadEnv } from "dotenv";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
loadEnv({ path: join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".env") });

const num = (v, d) => (v !== undefined && v !== "" ? Number(v) : d);

export const config = {
  port: num(process.env.PORT, 5100),

  mongoUri: process.env.MONGO_URI,
  aiDb: process.env.AI_DB || "adlm_ai",
  groundingDb: process.env.GROUNDING_DB || "adlmWeb",
  // Zone-priced RateGen admin cluster (read-only). Same value as the
  // website's RATEGEN_MONGO_URI. Falls back to MONGO_URI when unset.
  rategenMongoUri: process.env.RATEGEN_MONGO_URI || "",
  rategenMasterDb: process.env.RATEGEN_MASTER_DB || "ADLMRateDB",
  rategenMatCollection: process.env.RATEGEN_MAT_COLLECTION || "Materials",
  rategenLabCollection: process.env.RATEGEN_LAB_COLLECTION || "labours",

  awsRegion: process.env.AWS_REGION || "us-east-1",
  // Always "bedrock" — all AI runs on AWS credit. AI_PROVIDER is deliberately no
  // longer read: a deployed AI_PROVIDER=anthropic silently moved every call onto a
  // separately-billed Anthropic account, and its credit running dry surfaced to
  // users as "AI service is unreachable". See src/clients/bedrock.js to restore
  // the direct-API fallback (kept commented, not deleted).
  aiProvider: "bedrock",
  // aiProvider: (process.env.AI_PROVIDER || "bedrock").toLowerCase(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  // bedrock-runtime INFERENCE PROFILE ids (the "us." prefix is required — bare
  // foundation-model ids return "The provided model identifier is invalid").
  // Both verified working on this account in us-east-1 on 2026-08-15.
  //
  // Not Sonnet 5 / Opus 4.8: those are AWS-exclusive and are NOT enabled for this
  // account, so escalation to them would fail. Sonnet 4.6 is the newest strong tier
  // actually available, and is Sonnet-priced rather than Opus-priced.
  models: {
    cheap: process.env.BEDROCK_MODEL_CHEAP || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    strong: process.env.BEDROCK_MODEL_STRONG || "us.anthropic.claude-sonnet-4-6",
  },

  adlmCloudUrl: process.env.ADLM_CLOUD_URL || "https://adlmweb.onrender.com",
  jwtLicenseSecret: process.env.JWT_LICENSE_SECRET || "",
  jwtAccessSecret: process.env.JWT_ACCESS_SECRET || "",
  aiEntitlementKey: (process.env.AI_ENTITLEMENT_KEY || "ai").toLowerCase(),
  // WHO gets AI access — a business decision, so it lives in config:
  //   "any-subscription" (current policy) — any active ADLM entitlement grants
  //     access. AI ships to the whole subscribed base while it is being built
  //     out; spend is bounded by quotas + the credit guard, not by the gate.
  //   "entitlement" — only accounts holding the `ai` add-on (AI_ENTITLEMENT_KEY).
  //     Switch to this when AI becomes separately priced.
  // Either way an ACTIVE, unexpired entitlement is required — never a bare
  // valid token.
  aiAccessMode: (process.env.AI_ACCESS_MODE || "any-subscription").toLowerCase(),
  adminApiKey: process.env.ADMIN_API_KEY || "",

  credit: {
    totalUsd: num(process.env.CREDIT_TOTAL_USD, 25000),
    // Actual AWS Activate credit (NVIDIA Inception Global, $25,000):
    // active 01 Jul 2026 → 31 Jul 2028, confirmed on the Billing → Credits
    // console 28 Jul 2026.
    startDate: process.env.CREDIT_START_DATE || "2026-07-01",
    expiryDate: process.env.CREDIT_EXPIRY_DATE || "2028-07-31",
    guardThreshold: num(process.env.CREDIT_GUARD_THRESHOLD, 1.25),
    alarmDailySpendUsd: num(process.env.ALARM_DAILY_SPEND_USD, 50),
  },

  usdNgnRate: num(process.env.USD_NGN_RATE, 1600),
  defaultMonthlyQuota: num(process.env.DEFAULT_MONTHLY_QUOTA, 200),
  cacheTtlSeconds: num(process.env.CACHE_TTL_SECONDS, 604800),

  // Quota weight consumed per feature call (cache hits consume 0).
  featureWeights: {
    rateBuildup: 1,
    boqCheck: 2,
    outliers: 1,
    catalogueExtract: 5,
    takeoffCommand: 1,
    budgetMatch: 1,
    // Batches across the whole bill and can escalate a batch, so it costs more
    // than a single-shot feature.
    billCleanup: 2,
    billAsk: 1,
  },
  // Features throttled first when the credit guard trips. boqCheck and
  // rateBuildup are the paid headline features and stay up the longest.
  // billAsk is an explanation of work already done — the first thing that can
  // wait when credit is tight; billCleanup blocks getting a bill out, so it does not.
  nonCriticalFeatures: ["outliers", "catalogueExtract", "billAsk"],

  // Bumped whenever a feature prompt materially changes, OR when cached
  // results must be discarded for a reason the cache key cannot see. It is
  // recorded on every audit row and folded into every cache key, so a bump
  // both invalidates cached verdicts and keeps the audit honest about which
  // prompt produced which answer.
  //
  // .1  RateGen master gaps seeded — granite, steel reinforcement, sawn timber
  //     and five trades (mason, carpenter, glazier, steelfixer, tiler) now
  //     exist in the price lists. Build-ups cached before this resolved those
  //     as "no match" and priced them from the model instead; the library
  //     version alone would not have cleared them, because the rows are new
  //     documents rather than an edit to a priced row.
  // 08-29.1 rate build-up accepts an optional "callerLibrary" — the caller's
  //     own price-library rows — and the prompt now requires a component that
  //     is one of them to be named EXACTLY as the caller holds it. Build-ups
  //     cached before this were assembled with no such instruction, so
  //     replaying one hands back the freely-named components this change
  //     exists to stop. callerLibrary is part of the cache input as well, so
  //     two callers with different libraries never share an entry.
  // Earlier: 07-28.4 rate build-up pro-rating rules (gang day-rates must be
  // divided by a daily output); 07-28.5 bill clean-up + ask-the-bill prompts.
  promptVersion: "2026-08-29.1",

  disclaimer:
    "Advisory estimate generated by ADLM AI from the RateGen library and market data. Not a professional opinion; verify before contractual use.",
};

export function assertConfig() {
  const missing = [];
  if (!config.mongoUri) missing.push("MONGO_URI");
  if (!config.jwtLicenseSecret && !config.adlmCloudUrl) missing.push("JWT_LICENSE_SECRET or ADLM_CLOUD_URL");
  if (missing.length) throw new Error(`Missing required config: ${missing.join(", ")}`);
}
