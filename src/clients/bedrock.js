import { AnthropicBedrockMantle } from "@anthropic-ai/bedrock-sdk";
import { config } from "../config/index.js";
import { meterAiCall } from "../governance/meterAiCall.js";

// Single Bedrock entry point. There is deliberately NO unmetered invoke —
// every model call flows through meterAiCall by construction.
// AWS credentials come from the Lambda execution role (or env in local dev).
const client = new AnthropicBedrockMantle({ awsRegion: config.awsRegion });

function extractText(message) {
  return (message.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("");
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
    { ...meta, service: "bedrock", model: modelId },
    async () => {
      const message = await client.messages.create({
        model: modelId,
        max_tokens: maxTokens,
        system: `${system}\nRespond with a single JSON object only. No prose, no markdown fences.`,
        messages: [{ role: "user", content: user }],
      });
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
