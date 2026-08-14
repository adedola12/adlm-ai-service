import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { meterAiCall } from "../governance/meterAiCall.js";
import {
  recordProviderFailure,
  recordProviderFallback,
  recordProviderSuccess,
} from "../governance/providerHealth.js";
import { ModelUnavailableError } from "../middleware/errors.js";

// Single model-call entry point. There is deliberately NO unmetered invoke —
// every model call flows through meterAiCall by construction.
//
// PROVIDER POLICY (changed 14 Aug 2026): Bedrock is the default and the direct
// Anthropic API is the automatic fallback, not the other way round.
//
// WHY BEDROCK LEADS. The direct endpoint authenticates with an API key drawn
// against a prepaid balance. Both are single points of failure and both have
// already taken AI down: Ada lost a day to "your credit balance is too low",
// and on 14 Aug 2026 every QUIV and RateGen prompt failed while the plugins
// could only say "AI service is unreachable". Bedrock authenticates with the
// Lambda's own IAM role and bills to the AWS Activate credit, so there is no
// key to revoke, rotate or leak and no separate balance to drain.
//
// WHY THE FALLBACK STAYS. Bedrock has its own single point of failure: model
// access is granted per account, per region, in the console. Defaulting to
// bedrock WITHOUT a fallback is what took the whole service down on
// 29 Jul 2026 — every feature answered 503 MODEL_UNAVAILABLE. So the first
// call that proves the grant is missing latches this container onto the direct
// API and retries there, and the user's request still succeeds. The cure for a
// single point of failure is a second path, not a different single path.

const PROVIDER_BEDROCK = "bedrock";
const PROVIDER_ANTHROPIC = "anthropic";

let _bedrock = null;
let _anthropic = null;

function bedrockClient() {
  if (!_bedrock) _bedrock = new AnthropicBedrockMantle({ awsRegion: config.awsRegion });
  return _bedrock;
}

function anthropicClient() {
  if (!_anthropic) _anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
  return _anthropic;
}

// Set when Bedrock refuses the model itself. Time-boxed rather than permanent:
// the fix is someone ticking a box in the Bedrock console, and when that
// happens spend should return to the AWS credit on its own rather than waiting
// for a redeploy or a container recycle.
let bedrockBlockedUntil = 0;

function fallbackAvailable() {
  return config.aiProviderFallback && Boolean(config.anthropicApiKey);
}

/** Which provider serves the next call. Evaluated per call, never cached. */
export function activeProvider() {
  if (config.aiProvider === PROVIDER_ANTHROPIC) return PROVIDER_ANTHROPIC;
  if (Date.now() < bedrockBlockedUntil && fallbackAvailable()) return PROVIDER_ANTHROPIC;
  return PROVIDER_BEDROCK;
}

function extractText(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Bedrock reports "you have not been granted access to this model" as an
// AccessDenied, and an id that is not enabled in the region as a Validation
// error. Both mean the same thing operationally — the account cannot call this
// model — and neither is retryable ON THIS PROVIDER, which is exactly what
// makes them the right trigger for switching to the other one.
function isModelAccessError(err) {
  const name = String(err?.name || "");
  const status = Number(err?.status || err?.statusCode || 0);
  const text = String(err?.message || "");
  if (name === "AccessDeniedException" || name === "ValidationException") return true;
  if (status === 403) return true;
  return /don't have access|not authorized|access to the model|model.*not.*enabled/i.test(text);
}

function parseJsonLoose(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error("model did not return JSON");
  }
}

// Model ids are recorded and priced in Bedrock form (`anthropic.claude-...`)
// whichever provider serves the call, so a fallback never mislabels a usage row
// or misses its PricingRate entry. The prefix is stripped only for the direct
// API, which does not use it.
function modelForProvider(modelId, provider) {
  return provider === PROVIDER_ANTHROPIC ? modelId.replace(/^anthropic\./, "") : modelId;
}

/**
 * One metered attempt on one provider. Kept separate from invokeJson so the
 * fallback is a second METERED call rather than a silent retry inside the
 * meter — two honest usage rows (a failed Bedrock attempt, a served direct
 * one) instead of one row that misattributes the spend.
 */
async function attempt(provider, meta, { modelId, system, user, maxTokens }) {
  return meterAiCall(
    {
      ...meta,
      service: "bedrock",
      model: modelId,
      operation:
        provider === PROVIDER_ANTHROPIC ? `${meta.operation || ""}@direct` : meta.operation,
    },
    async () => {
      const client = provider === PROVIDER_ANTHROPIC ? anthropicClient() : bedrockClient();
      let message;
      try {
        message = await client.messages.create({
          model: modelForProvider(modelId, provider),
          max_tokens: maxTokens,
          system: `${system}\nRespond with a single JSON object only. No prose, no markdown fences.`,
          messages: [{ role: "user", content: user }],
        });
      } catch (err) {
        if (isModelAccessError(err)) throw new ModelUnavailableError(modelId, err.message);
        throw err;
      }
      return {
        result: parseJsonLoose(extractText(message)),
        units: {
          inputTokens: message.usage?.input_tokens || 0,
          outputTokens: message.usage?.output_tokens || 0,
        },
      };
    },
  );
}

// Metered JSON completion. meta: { tenantId, product, feature, operation, escalated }.
// Returns { json, modelId, costUsd, provider }.
export async function invokeJson(meta, opts) {
  const { modelId, maxTokens = 2048 } = opts;
  const first = activeProvider();

  try {
    const out = await attempt(first, meta, { ...opts, maxTokens });
    recordProviderSuccess(first);
    return { json: out.result, modelId, costUsd: out.costUsd, provider: first };
  } catch (err) {
    recordProviderFailure(first, err);

    const canFallBack =
      first === PROVIDER_BEDROCK && err instanceof ModelUnavailableError && fallbackAvailable();
    if (!canFallBack) throw err;

    bedrockBlockedUntil = Date.now() + config.aiProviderRetryMs;
    recordProviderFallback(PROVIDER_BEDROCK, PROVIDER_ANTHROPIC);
    console.warn(
      `[adlm-ai] Bedrock refused ${modelId} (${err.detail || err.message}) — serving from the direct Anthropic API for the next ${Math.round(
        config.aiProviderRetryMs / 60000,
      )} min. Grant Anthropic model access in the Bedrock console for ${config.awsRegion} to return spend to the AWS credit.`,
    );

    try {
      const out = await attempt(PROVIDER_ANTHROPIC, meta, { ...opts, maxTokens });
      recordProviderSuccess(PROVIDER_ANTHROPIC);
      return { json: out.result, modelId, costUsd: out.costUsd, provider: PROVIDER_ANTHROPIC };
    } catch (fallbackErr) {
      recordProviderFailure(PROVIDER_ANTHROPIC, fallbackErr);
      // Both paths are down. Carry the ORIGINAL Bedrock refusal along: it names
      // the action that fixes the intended provider, and the fallback error is
      // often just "no key configured" noise layered on top of it.
      fallbackErr.bedrockError = err.message;
      throw fallbackErr;
    }
  }
}

// Tests and local scripts only.
export function _resetProviderLatch() {
  bedrockBlockedUntil = 0;
}

// Tests only — the latch is otherwise set exclusively by a real refusal.
export function _markBedrockBlocked(ms = config.aiProviderRetryMs) {
  bedrockBlockedUntil = Date.now() + ms;
}

// Tests only — exported so the access-error taxonomy can be pinned down
// without standing up a Bedrock client.
export const _isModelAccessError = isModelAccessError;
