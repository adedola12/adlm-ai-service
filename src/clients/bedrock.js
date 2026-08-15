// AnthropicBedrock targets bedrock-runtime (InvokeModel). It replaced
// AnthropicBedrockMantle, which targets the separate bedrock-mantle endpoint — a
// different model-id space that 404s inference-profile ids. Mantle was the real
// reason "Bedrock doesn't work here": this account HAS Claude access (Haiku 4.5,
// Sonnet 4.5/4.6, Opus 4.5 all invoke fine), it was simply being asked over an
// endpoint that could not see those models. Verified 2026-08-15.
import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
// import Anthropic from "@anthropic-ai/sdk";   // direct-API fallback — disabled, see below
import { config } from "../config/index.js";
import { meterAiCall } from "../governance/meterAiCall.js";
import { ModelUnavailableError } from "../middleware/errors.js";

// Single model-call entry point. There is deliberately NO unmetered invoke —
// every model call flows through meterAiCall by construction.
//
// ALL AI now runs on Bedrock (AWS credit). The direct-Anthropic-API fallback is
// disabled: it billed a separate Anthropic account, and when that account ran out
// of credit every AI call failed — the provider returned 400 "credit balance is
// too low", this service logged it as an unhandled error and returned a bare 500,
// and the SDK retried twice before telling the user "AI service is unreachable".
// One provider, funded by AWS credit, removes that whole failure mode.
//
// To restore the fallback: uncomment the import and the two `direct` lines below,
// then set AI_PROVIDER=anthropic and ANTHROPIC_API_KEY. Model ids stay in Bedrock
// form; the "anthropic." prefix is stripped only for the direct call, and unit
// prices are identical so metering and PricingRate are unaffected either way.
// const direct = config.aiProvider === "anthropic";
const direct = false;
const client = // direct ? new Anthropic({ apiKey: config.anthropicApiKey }) :
  new AnthropicBedrock({ awsRegion: config.awsRegion });

function extractText(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
}

// Bedrock reports "you have not been granted access to this model" as an
// AccessDenied, and an id that is not enabled in the region as a Validation
// error. Both mean the same thing operationally — the account cannot call this
// model — and neither is retryable, so they are separated from real faults.
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

// Metered JSON completion. meta: { tenantId, product, feature, operation, escalated }.
// Returns { json, modelId, costUsd }.
export async function invokeJson(meta, { modelId, system, user, maxTokens = 2048 }) {
  const { result, costUsd } = await meterAiCall(
    { ...meta, service: "bedrock", model: modelId, operation: direct ? `${meta.operation || ""}@direct` : meta.operation },
    async () => {
      let message;
      try {
        message = await client.messages.create({
          model: direct ? modelId.replace(/^anthropic\./, "") : modelId,
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
    }
  );
  return { json: result, modelId, costUsd };
}
