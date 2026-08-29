import { config } from "../config/index.js";

// Routing policy: cheapest model that can do the task; escalate to the strong
// tier only when confidence is low or the task class demands it. Which model
// served each call is recorded by meterAiCall via the meta it receives.
const TASK_TIERS = {
  classification: "cheap",
  extraction: "cheap",
  outlierScan: "cheap",
  boqVerdict: "cheap", // escalates per-item batch when confidence is low
  // Rate build-ups run cheap-first and escalate on low confidence (see
  // withEscalation + rateBuildupService). Pinning this to "strong" cost
  // 16-30s per uncached build-up versus ~6s, because the time goes into
  // generating the JSON build-up rather than into reasoning depth — and the
  // A/B produced comparable component sets and confidences. The escalation
  // gate still routes genuinely hard items to the flagship model.
  rateReasoning: "cheap",
  catalogueMapping: "cheap",
  // Bill wording is what the client reads most closely, so this escalates on a
  // low-confidence batch (see billCleanupService) rather than shipping vague
  // rewrites — but it starts cheap like everything else.
  billCleanup: "cheap",
  // Breakdown quantities land straight in a budget the QS prices from, so a
  // low-confidence batch escalates (see breakdownFillService) rather than
  // shipping a guess — but, like everything else, it starts cheap.
  breakdownFill: "cheap",
};

export const ESCALATION_CONFIDENCE_THRESHOLD = 0.6;

export function pickModel(taskType, { escalate = false } = {}) {
  const tier = escalate ? "strong" : TASK_TIERS[taskType] || "cheap";
  return { tier, modelId: config.models[tier] };
}

// Runs fn with the cheap tier first; if the returned confidence is below the
// threshold, re-runs once on the strong tier. fn(modelId) must return
// { result, confidence }. Returns { result, confidence, modelId, escalated }.
export async function withEscalation(taskType, fn) {
  const first = pickModel(taskType);
  let { result, confidence } = await fn(first.modelId);
  if (first.tier === "strong" || (confidence ?? 1) >= ESCALATION_CONFIDENCE_THRESHOLD) {
    return { result, confidence, modelId: first.modelId, escalated: false };
  }
  const strong = pickModel(taskType, { escalate: true });
  ({ result, confidence } = await fn(strong.modelId));
  return { result, confidence, modelId: strong.modelId, escalated: true };
}
