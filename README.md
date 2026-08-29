# ADLM AI Service

Serverless AI API (Lambda + API Gateway) powering AI cost-intelligence
features across the ADLM product suite, with a spend-governance layer
underneath. See `CLAUDE.md` for the architectural rules.

## Features (`/api/ai`, entitlement-gated)

| Route | Feature |
|---|---|
| `POST /rate-buildup` | Smart rate build-up (library-first, per-component source attribution) |
| `POST /boq-check` | BoQ market check vs RateGen benchmarks (per-item verdict + reason) |
| `POST /outliers` | Outlier & error detection (statistical + semantic, every flag has a reason) |
| `POST /breakdown-fill` | Breakdown fill — what a BoQ item is made of, per one unit, from its own description (library-priced, never sized to hit the rate) |
| `POST /catalogue/extract` | Supplier catalogue extraction (Textract + classification/mapping) |
| `POST /forecast` | Stub — returns `NOT_YET_AVAILABLE` |

Auth: `Authorization: Bearer <licence JWT or ADLM access token>` +
optional `x-adlm-product: quiv|heron|rategen|cloud|bk`.

## Admin (`/api/ai/admin`, `x-admin-key`)

`GET /usage`, `GET /usage/summary`, `GET|PATCH /credit`,
`GET /pricing-rates`, `PATCH /pricing-rates/:id`, `GET /quotas`,
`PATCH /quotas/:tenantId`.

## Run locally

```bash
npm install
cp .env.example .env   # fill MONGO_URI, secrets, AWS creds
npm run seed:pricing
npm run dev
```

## Deploy (AWS SAM)

```bash
sam build
sam deploy --guided
```

## Phase 1 exit criterion — the latency gate

Run `sdk/csharp/AdlmAi.LatencyHarness` against the deployed endpoint from a
realistic network: 50 calls to `/rate-buildup`, record cold/warm p95. Budget:
**warm p95 under ~3s** for synchronous plugin UX. If it fails, the C# SDK
contract is async-with-progress + client cache by specification (it already
supports both).
