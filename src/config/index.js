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
  // "bedrock" (bills the AWS Activate credit, holds no provider key) or
  // "anthropic" (direct API, bills cash). Same models, same prices.
  //
  // bedrock since the model-access grant landed in us-east-1 on 2026-07-29.
  // The rule this default follows is unchanged: name the option that WORKS.
  // Lambda always receives AI_PROVIDER from the template so this never decides
  // production, but a wrong default here fails local dev with a
  // 503 MODEL_UNAVAILABLE for a reason nothing in the code names. If the grant
  // is revoked, put this back to "anthropic" together with template.yaml.
  aiProvider: (process.env.AI_PROVIDER || "bedrock").toLowerCase(),
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || "",
  // Bedrock cross-region INFERENCE PROFILE ids, not bare model ids. Bedrock
  // rejects the bare form with "on-demand throughput isn't supported — retry
  // with the ID or ARN of an inference profile", and the "us." prefix is what
  // makes it one. Verified working on account 065634457992 in us-east-1.
  //
  // Sonnet 4.5 rather than Sonnet 5: the bare-id models (claude-sonnet-5,
  // claude-opus-4-8, claude-haiku-4-5) are served only by the newer Mantle
  // endpoint and are AWS-direct-exclusive — a reseller-managed account under
  // another AWS Organization cannot be granted them. Confirmed by Spendbase
  // 2026-07-28. These two are what this account can actually call.
  models: {
    cheap: process.env.BEDROCK_MODEL_CHEAP || "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    strong: process.env.BEDROCK_MODEL_STRONG || "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
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
  // 100 quota units per account per month for every active subscriber across
  // QUIV, HERON, MEP and RateGen. NOT 100 calls: features carry weights (see
  // featureWeights below), so this is 100 rate build-ups, or 50 boq-checks or
  // bill clean-ups, or 20 catalogue extracts — or any mix summing to 100.
  // Existing tenants keep whatever monthlyQuota their document already holds;
  // scripts/set-monthly-quota.js backfills them.
  defaultMonthlyQuota: num(process.env.DEFAULT_MONTHLY_QUOTA, 100),
  cacheTtlSeconds: num(process.env.CACHE_TTL_SECONDS, 604800),

  // Quota weight consumed per feature call (cache hits consume 0).
  featureWeights: {
    rateBuildup: 1,
    boqCheck: 2,
    outliers: 1,
    catalogueExtract: 5,
    takeoffCommand: 1,
    budgetMatch: 1,
    // 8, not 2. This is the one feature that is not a single model call: it
    // batches 25 items at a time across a bill of up to 400, so ONE review can
    // be 16 calls plus escalation to the strong tier on low-confidence batches.
    // A full review costs ~$0.10-0.17 against ~$0.018 for a rate build-up, so a
    // weight of 2 let a user spend roughly 7x the intended ceiling without ever
    // hitting their quota. 8 makes a quota unit mean about the same thing
    // whichever feature spends it. Revisit once there is measured data —
    // this is calculated from batch sizes and token prices, not observed.
    billCleanup: 8,
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
  // Earlier: 07-28.4 rate build-up pro-rating rules (gang day-rates must be
  // divided by a daily output); 07-28.5 bill clean-up + ask-the-bill prompts.
  promptVersion: "2026-07-29.1",

  disclaimer:
    "Advisory estimate generated by ADLM AI from the RateGen library and market data. Not a professional opinion; verify before contractual use.",
};

export function assertConfig() {
  const missing = [];
  if (!config.mongoUri) missing.push("MONGO_URI");
  if (!config.jwtLicenseSecret && !config.adlmCloudUrl) missing.push("JWT_LICENSE_SECRET or ADLM_CLOUD_URL");
  if (missing.length) throw new Error(`Missing required config: ${missing.join(", ")}`);
}
