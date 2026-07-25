# ADLM AI Service

Central AI API for the ADLM product suite. Two layers, in priority order:

1. **QS-facing features are the product**: smart rate build-up, BoQ market
   check, outlier detection, supplier catalogue extraction. All grounded in
   the RateGen library and BESMM 4R. Forecasting is a stub until a real
   price-trend data source exists — never fake it.
2. **Spend governance is the backbone**: metering, attribution, model routing,
   caching, quotas, and the global credit guard keep the features affordable
   on the $25,000 AWS Activate credit (expires **31 July 2028**, ~$1,000/month
   effective) and economic after it. Runway and model routing matter.

## Hard rules

- **Every Bedrock and Textract call goes through `meterAiCall`** (see
  `src/governance/meterAiCall.js`). The only call sites are
  `src/clients/bedrock.js` and `src/clients/textract.js`, which wrap
  themselves in the meter by construction. Never add an unmetered call path.
- **Prices, quotas, and the credit total are config, never code.** Prices live
  in the `PricingRate` collection (seed: `scripts/seed-pricing.js`, edit via
  admin PATCH routes). Credit account lives in `CreditAccount` + env defaults.
  Quotas live in `TenantAiQuota` + `DEFAULT_MONTHLY_QUOTA`.
- **Database isolation.** This service owns the `adlm_ai` database on the
  shared Atlas cluster. Zero shared collections with ADLM Cloud (`adlmWeb`).
  Entitlements are verified from the signed licence JWT (or via ADLM Cloud's
  `/api/entitlements` API with a TTL cache) — never by joining licence
  collections. RateGen library reads (`adlmWeb`, `ADLMRateDB`) are
  **read-only** grounding data via `src/grounding/rateLibrary.js`.
- **Audit trail is Day-1 schema.** Every verdict writes an append-only
  `VerdictAudit` row (input hash, model, prompt version, RateGen data version,
  confidence). Every response carries a confidence + advisory disclaimer.
  Verdicts are professional-liability surface — keep them defensible.
- **Serverless on AWS only for this service.** ADLM Cloud, the website,
  marketplace, and licence backend stay where they are (Render/Vercel). Do
  not migrate them. No EC2/GPU — managed models only (Bedrock + Textract).
- **Cache busting is automatic**: the RateGen library version and
  `config.promptVersion` are folded into every cache key. Bump
  `promptVersion` whenever a feature prompt materially changes.

## Layout

- `src/clients/` — the ONLY Bedrock/Textract call sites (metered).
- `src/governance/` — meterAiCall, pricing, cache, quota, credit guard, router.
- `src/grounding/` — read-only RateGen library access + zones.
- `src/services/` — one service per feature + shared `featurePipeline.js`
  (guard → cache → quota → compute → audit) + reporting.
- `src/routes/` — thin controllers. `/api/ai/*` features (entitlement-gated),
  `/api/ai/admin/*` internal reporting (x-admin-key).
- `sdk/csharp/` — C# SDK for QUIV/HERON/RateGen plugins (ship first) +
  latency harness (Phase 1 exit criterion: warm p95 < 3s or the SDK contract
  goes async-with-progress by spec).
- `sdk/typescript/` — TS SDK for ADLM Cloud web.

## Model routing

Cheap tier (`BEDROCK_MODEL_CHEAP`) for classification/extraction/outlier
scans; strong tier (`BEDROCK_MODEL_STRONG`) for rate reasoning; escalate on
confidence < 0.6 (`src/governance/modelRouter.js`). The serving model is
recorded on every usage event and audit row.

## Entitlement

AI features are an add-on entitlement (`productKey: "ai"`, config
`AI_ENTITLEMENT_KEY`) on the existing ADLM Cloud licence system, following the
`quiv-boq-import` feature-grant pattern. One quota per account, shared across
products (`x-adlm-product` header attributes usage per product for reporting).
Pricing/tiering is a business decision — keep it out of code.
