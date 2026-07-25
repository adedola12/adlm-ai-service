import { invokeJson } from "../clients/bedrock.js";
import { pickModel, ESCALATION_CONFIDENCE_THRESHOLD } from "../governance/modelRouter.js";
import { findCandidateRates } from "../grounding/rateLibrary.js";
import { runFeature } from "./featurePipeline.js";

// BoQ market check: per-item verdicts against RateGen market data for the
// zone. This is the paid headline feature — output must be clean and
// defensible: every verdict carries the library benchmark it was compared to,
// a deviation figure, a reason, and a confidence.
//
// items: [{ ref, description, unit, quantity, rate }]  (rate in NGN)
const BATCH_SIZE = 20;
const OVER_MARKET = 0.25; // flag when >25% above benchmark
const UNDER_MARKET = 0.25;

export async function boqCheck({ tenantId, product, items, zone }) {
  const normItems = (items || []).slice(0, 500).map((it, i) => ({
    ref: String(it.ref ?? i + 1),
    description: String(it.description || "").trim(),
    unit: String(it.unit || "").trim(),
    quantity: Number(it.quantity) || 0,
    rate: Number(it.rate) || 0,
  }));

  return runFeature({
    tenantId,
    product,
    feature: "boqCheck",
    input: { items: normItems, zone: zone || null },
    compute: async () => {
      // 1. Deterministic benchmark pass against the library — no tokens spent.
      const benchmarked = [];
      for (const item of normItems) {
        const candidates = await findCandidateRates(item.description, { limit: 3 });
        const bench = candidates[0];
        benchmarked.push({ item, bench: bench && bench.matchScore >= 0.4 ? bench : null });
      }

      const verdicts = [];
      const needModel = [];
      for (const { item, bench } of benchmarked) {
        if (bench && bench.totalCost > 0 && item.rate > 0) {
          const deviation = (item.rate - bench.totalCost) / bench.totalCost;
          verdicts.push(deterministicVerdict(item, bench, deviation));
        } else {
          needModel.push(item);
        }
      }

      // 2. Model pass only for items the library could not benchmark.
      let usedModel = "library-only";
      let escalated = false;
      if (needModel.length) {
        const cheap = pickModel("boqVerdict");
        for (let i = 0; i < needModel.length; i += BATCH_SIZE) {
          const batch = needModel.slice(i, i + BATCH_SIZE);
          let { json } = await invokeJson(
            { tenantId, product, feature: "boqCheck", operation: "verdict-batch" },
            { modelId: cheap.modelId, maxTokens: 3000, system: MODEL_PROMPT, user: JSON.stringify({ zone, items: batch }) }
          );
          usedModel = cheap.modelId;
          const avgConf = avgConfidence(json.verdicts);
          if (avgConf < ESCALATION_CONFIDENCE_THRESHOLD) {
            const strong = pickModel("boqVerdict", { escalate: true });
            ({ json } = await invokeJson(
              { tenantId, product, feature: "boqCheck", operation: "verdict-batch", escalated: true },
              { modelId: strong.modelId, maxTokens: 3000, system: MODEL_PROMPT, user: JSON.stringify({ zone, items: batch }) }
            ));
            usedModel = strong.modelId;
            escalated = true;
          }
          for (const v of json.verdicts || []) {
            verdicts.push({
              ref: String(v.ref),
              verdict: normalizeVerdict(v.verdict),
              deviationPercent: v.deviationPercent ?? null,
              benchmark: null,
              reason: `${v.reason || "Model assessment (no library benchmark available)."}`,
              source: "model",
              confidence: clamp01(v.confidence ?? 0.5),
            });
          }
        }
      }

      verdicts.sort((a, b) => Number(a.ref) - Number(b.ref) || String(a.ref).localeCompare(String(b.ref)));
      const summary = {
        items: verdicts.length,
        overMarket: verdicts.filter((v) => v.verdict === "over_market").length,
        underMarket: verdicts.filter((v) => v.verdict === "under_market").length,
        inRange: verdicts.filter((v) => v.verdict === "in_range").length,
        mismatches: verdicts.filter((v) => v.verdict === "mismatch").length,
        unbenchmarked: verdicts.filter((v) => v.source === "model").length,
      };
      return {
        model: usedModel,
        confidence: avgConfidence(verdicts),
        result: { zone: zone || null, summary, verdicts, escalated },
      };
    },
  });
}

function deterministicVerdict(item, bench, deviation) {
  let verdict = "in_range";
  let reason = `Within market range of library benchmark '${bench.description}' (₦${bench.totalCost}/${bench.unit}).`;
  if (deviation > OVER_MARKET) {
    verdict = "over_market";
    reason = `Rate is ${(deviation * 100).toFixed(0)}% above library benchmark '${bench.description}' (₦${bench.totalCost}/${bench.unit}).`;
  } else if (deviation < -UNDER_MARKET) {
    verdict = "under_market";
    reason = `Rate is ${(Math.abs(deviation) * 100).toFixed(0)}% below library benchmark '${bench.description}' (₦${bench.totalCost}/${bench.unit}) — check for under-pricing or scope difference.`;
  }
  if (bench.unit && item.unit && bench.unit.toLowerCase() !== item.unit.toLowerCase()) {
    verdict = "mismatch";
    reason = `Unit '${item.unit}' does not match library benchmark unit '${bench.unit}' for '${bench.description}' — possible unit error.`;
  }
  return {
    ref: item.ref,
    verdict,
    deviationPercent: Number((deviation * 100).toFixed(1)),
    benchmark: {
      description: bench.description,
      unit: bench.unit,
      rateNgn: bench.totalCost,
      code: bench.code,
      matchScore: bench.matchScore,
    },
    reason,
    source: "library",
    confidence: Math.min(0.95, 0.5 + bench.matchScore / 2),
  };
}

const MODEL_PROMPT = `You are a Nigerian quantity surveyor reviewing BoQ items that have no benchmark in the rate library. For each item, judge whether the quoted rate (NGN) is plausible for the described work in the given Nigerian zone.

Return JSON:
{"verdicts": [{"ref": "...", "verdict": "over_market|under_market|in_range|mismatch", "deviationPercent": null, "reason": "one short defensible sentence", "confidence": 0.0}]}`;

function normalizeVerdict(v) {
  return ["over_market", "under_market", "in_range", "mismatch"].includes(v) ? v : "in_range";
}
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
function avgConfidence(list) {
  const vals = (list || []).map((v) => v.confidence ?? 0.5);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0.5;
}
