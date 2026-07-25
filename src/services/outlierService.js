import { invokeJson } from "../clients/bedrock.js";
import { pickModel } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";

// Outlier and error detection over a takeoff/BoQ. Statistical checks run
// first (free, deterministic, explainable); the model adds a single cheap
// pass for semantic issues statistics can't see. Every flag carries a reason.
export async function detectOutliers({ tenantId, product, items }) {
  const normItems = (items || []).slice(0, 1000).map((it, i) => ({
    ref: String(it.ref ?? i + 1),
    description: String(it.description || "").trim(),
    unit: String(it.unit || "").trim(),
    quantity: Number(it.quantity) || 0,
    rate: Number(it.rate) || 0,
  }));

  return runFeature({
    tenantId,
    product,
    feature: "outliers",
    input: { items: normItems },
    compute: async () => {
      const flags = [];

      // Duplicates: same description + unit appearing more than once.
      const seen = new Map();
      for (const it of normItems) {
        const k = `${it.description.toLowerCase()}|${it.unit.toLowerCase()}`;
        if (seen.has(k)) {
          flags.push(flag(it.ref, "duplicate", `Duplicate of item ${seen.get(k)} ('${it.description}', ${it.unit}).`, 0.9));
        } else {
          seen.set(k, it.ref);
        }
      }

      // Rate outliers within same-unit groups (robust z-score via MAD).
      const byUnit = groupBy(normItems.filter((i) => i.rate > 0), (i) => i.unit.toLowerCase());
      for (const [unit, group] of byUnit) {
        if (group.length < 5) continue;
        const rates = group.map((g) => Math.log10(g.rate));
        const med = median(rates);
        const mad = median(rates.map((r) => Math.abs(r - med))) || 0.0001;
        for (const g of group) {
          const z = (Math.log10(g.rate) - med) / (1.4826 * mad);
          if (Math.abs(z) > 3.5) {
            flags.push(
              flag(
                g.ref,
                "rate_outlier",
                `Rate ₦${g.rate} is far outside the band of other '${unit}' items (robust z=${z.toFixed(1)}) — possible pricing or unit error.`,
                0.8
              )
            );
          }
        }
      }

      // Zero/negative sanity.
      for (const it of normItems) {
        if (it.quantity <= 0) flags.push(flag(it.ref, "quantity_error", `Quantity is ${it.quantity} — measured items must be positive.`, 0.95));
        if (it.rate < 0) flags.push(flag(it.ref, "rate_error", `Rate is negative (₦${it.rate}).`, 0.99));
      }

      // Cheap model pass: unit errors and semantic anomalies (e.g. concrete in
      // m instead of m3), on a compact sample of the items.
      const { modelId } = pickModel("outlierScan");
      const { json } = await invokeJson(
        { tenantId, product, feature: "outliers", operation: "semantic-scan" },
        {
          modelId,
          maxTokens: 2000,
          system: MODEL_PROMPT,
          user: JSON.stringify({ items: normItems.slice(0, 200) }),
        }
      );
      for (const f of json.flags || []) {
        flags.push(flag(String(f.ref), f.type || "semantic", `${f.reason}`, clamp01(f.confidence ?? 0.5), "model"));
      }

      return {
        model: modelId,
        confidence: 0.8,
        result: {
          itemsChecked: normItems.length,
          flagCount: flags.length,
          flags: dedupeFlags(flags),
        },
      };
    },
  });
}

const MODEL_PROMPT = `You are a Nigerian QS reviewing takeoff/BoQ items for semantic errors that statistics cannot catch: wrong measurement unit for the work type (BESMM 4R conventions), quantity/unit combinations that are implausible, descriptions that contradict their unit or rate magnitude.
Only flag genuine, explainable problems.
Return JSON: {"flags": [{"ref": "...", "type": "unit_error|quantity_error|semantic", "reason": "one short specific sentence", "confidence": 0.0}]}`;

const flag = (ref, type, reason, confidence, source = "statistical") => ({ ref, type, reason, confidence, source });
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function groupBy(arr, keyFn) {
  const m = new Map();
  for (const x of arr) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
}
function median(nums) {
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}
function dedupeFlags(flags) {
  const seen = new Set();
  return flags.filter((f) => {
    const k = `${f.ref}|${f.type}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
