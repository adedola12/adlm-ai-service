import { AnthropicBedrock } from "@anthropic-ai/bedrock-sdk";
import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config/index.js";
import { meterAiCall } from "../governance/meterAiCall.js";
import { ModelUnavailableError } from "../middleware/errors.js";

// Single model-call entry point. There is deliberately NO unmetered invoke —
// every model call flows through meterAiCall by construction.
//
// Providers: "bedrock" (production — AWS credentials from the Lambda role or
// env) or "anthropic" (direct API fallback; same Claude models, same unit
// prices, so metering and the PricingRate store are unchanged — model ids are
// recorded in Bedrock form and the "anthropic." prefix is stripped only for
// the direct API call).
// AnthropicBedrock (the bedrock-runtime InvokeModel path), NOT
// AnthropicBedrockMantle. Mantle is the newer Messages-API endpoint and serves
// only the bare-id models, which this account cannot be granted — see the note
// on config.models. Everything this service calls goes through InvokeModel with
// a cross-region inference profile id.
const direct = config.aiProvider === "anthropic";
const client = direct
  ? new Anthropic({ apiKey: config.anthropicApiKey })
  : new AnthropicBedrock({ awsRegion: config.awsRegion });

// Bedrock inference-profile id -> the id the Anthropic API knows it by, so the
// direct fallback still works off one configured model list. Strips the region
// prefix ("us."), the provider prefix ("anthropic.") and the Bedrock version
// suffix ("-v1:0"): us.anthropic.claude-haiku-4-5-20251001-v1:0
//                → claude-haiku-4-5-20251001
function toDirectModelId(modelId) {
  return String(modelId)
    .replace(/^(us|eu|apac)\./, "")
    .replace(/^anthropic\./, "")
    .replace(/-v\d+:\d+$/, "");
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
          model: direct ? toDirectModelId(modelId) : modelId,
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
