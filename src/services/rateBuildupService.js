import { invokeJson } from "../clients/bedrock.js";
import { pickModel, withEscalation } from "../governance/modelRouter.js";
import { findCandidateRates, findComputeItems, findPrices, NIGERIAN_ZONES } from "../grounding/rateLibrary.js";
import { runFeature } from "./featurePipeline.js";

// Smart rate build-up: library-first, model fills gaps, every component
// carries its source ("library" | "model") so the QS can see exactly what
// was looked up and what was inferred.
export async function rateBuildup({ tenantId, product, description, zone, unit }) {
  const normZone = NIGERIAN_ZONES.includes(zone) ? zone : null;

  return runFeature({
    tenantId,
    product,
    feature: "rateBuildup",
    input: { description: description.trim().toLowerCase(), zone: normZone, unit: unit || null },
    compute: async () => {
      const [candidates, recipes] = await Promise.all([
        findCandidateRates(description),
        findComputeItems(description),
      ]);

      // Strong exact-ish library match: return it directly, no model call.
      // Components are re-priced against the zone's master price list so the
      // same work item yields the correct rate per location.
      const best = candidates[0];
      if (best && best.matchScore >= 0.85 && best.breakdown?.length) {
        return {
          model: "library-only",
          confidence: 0.95,
          result: await buildFromLibrary(best, normZone),
        };
      }

      // Model assembles the build-up, grounded in the candidates + recipes.
      //
      // Cheap tier FIRST, escalating to the strong tier only when the cheap
      // model reports low confidence. This is the single biggest latency lever
      // on this endpoint: measured on the same build-up, the strong tier took
      // 16-30s versus ~6s cheap, because the cost is OUTPUT generation (a full
      // JSON build-up), not reasoning depth — trimming the prompt from 4.1k to
      // 1.3k tokens changed nothing. Quality was comparable on the A/B (cheap:
      // 7 components, all library-priced, confidence 0.85, net N15,449;
      // strong: 5 components, all library-priced, confidence 0.82, net
      // N14,851 — 4% apart), and the escalation gate catches the cases where
      // it is not.
      const user = JSON.stringify({
        workItem: { description, unit: unit || null, zone: normZone },
        libraryCandidates: candidates,
        libraryRecipes: recipes,
      });

      const { result: json, confidence, modelId, escalated } = await withEscalation(
        "rateReasoning",
        async (id) => {
          const { json: out } = await invokeJson(
            {
              tenantId,
              product,
              feature: "rateBuildup",
              operation: "assemble",
              ...(id === pickModel("rateReasoning", { escalate: true }).modelId ? { escalated: true } : {}),
            },
            { modelId: id, maxTokens: 3000, system: SYSTEM_PROMPT, user }
          );
          return { result: out, confidence: out.confidence ?? 0.5 };
        }
      );

      // Re-price model-proposed components against the zone-priced master
      // lists so library prices win over model guesses wherever a match exists.
      const result = await repriceComponents(json, candidates, normZone);
      return { model: modelId, confidence, result: { ...result, escalated } };
    },
  });
}

const SYSTEM_PROMPT = `You are a Nigerian quantity surveyor's assistant assembling a unit-rate build-up following BESMM 4R measurement conventions. You are given a work item and candidate rates/recipes from ADLM's RateGen library (prices in NGN).

Rules:
- Prefer library data. Only infer quantities/prices the library does not cover, and mark those inferred.
- Output realistic Nigerian market values.
- EVERY quantity is per ONE unit of the work item (one m2, one m3, one m...), never per day, per gang or per batch.
- Library labour and plant are priced per DAY or per HOUR for a whole gang. You MUST pro-rate them to one unit by dividing by a daily output: quantity = 1 / (units produced per day). A quantity of 1 or more against a "per day" unit is almost always a missing pro-rate — check it before returning.
- Take the daily output from the library build-up whenever one is supplied; only fall back to a realistic Nigerian site output when the library is silent, and state which you used in notes. Do not under-state labour: pro-rating is about the correct output rate, not the cheapest one.
- Waste and allowance lines must carry a real quantity and price that multiply out to the allowance value; do not emit a percentage with a zero price.
- Include materials, labour, plant (if applicable), then overhead and profit percentages.
- Sanity-check the final rate against the library candidates you were given. If your total is several times the closest library rate for similar work, you have made a units or pro-rating error — fix it, or lower your confidence so the answer is escalated.

Return JSON:
{
  "unit": "m2",
  "components": [
    {"kind": "material|labour|plant", "name": "...", "quantity": 0.0, "unit": "...", "unitPriceNgn": 0.0, "source": "library|model", "libraryRef": "code or null"}
  ],
  "overheadPercent": 10,
  "profitPercent": 25,
  "notes": "one short sentence on assumptions",
  "confidence": 0.0
}`;

const SUBTOTAL_LINE = /^\s*(sub-?total|total)\b/i;
const ALLOWANCE_LINE = /^\s*(add\s+for|allow)\b/i;

async function buildFromLibrary(rate, zone) {
  // Master breakdowns mix real components with subtotal and allowance rows.
  // Subtotals are dropped (they duplicate value); allowance rows keep their
  // stored totals and are never repriced; stored TotalPrice is the source of
  // truth for every line unless a confident zone reprice replaces it.
  const components = rate.breakdown
    .filter((b) => !SUBTOTAL_LINE.test(String(b.componentName || "")))
    .map((b) => ({
      kind: ALLOWANCE_LINE.test(String(b.componentName || "")) ? "allowance" : b.refKind || "material",
      name: b.componentName,
      quantity: b.quantity,
      unit: b.unit,
      unitPriceNgn: b.unitPrice,
      totalNgn: round2(b.totalPrice ?? (b.quantity || 0) * (b.unitPrice || 0)),
      source: "library",
      libraryRef: rate.code || rate.description,
    }));

  // Zone repricing — strict matches only (score >= 0.6), clean components only.
  if (zone) {
    const repriceable = components.filter((c) => c.kind === "material" || c.kind === "labour");
    const [mats, labs] = await Promise.all([
      findPrices(repriceable.filter((c) => c.kind === "material").map((c) => c.name), "material", zone, 0.6),
      findPrices(repriceable.filter((c) => c.kind === "labour").map((c) => c.name), "labour", zone, 0.6),
    ]);
    const priceMap = new Map([...mats, ...labs].map((p) => [p.query, p]));
    for (const c of components) {
      const hit = priceMap.get(c.name);
      if (hit && hit.priceNgn > 0 && hit.zone === zone && (c.quantity || 0) > 0) {
        c.unitPriceNgn = hit.priceNgn;
        c.totalNgn = round2(c.quantity * hit.priceNgn);
        c.pricedZone = zone;
      }
    }
  }

  return totalize({
    unit: rate.unit,
    zone,
    components,
    overheadPercent: rate.overheadPercent ?? 10,
    profitPercent: rate.profitPercent ?? 25,
    notes: `Matched library rate: ${rate.description}${zone ? ` (zone prices applied where matched: ${zone})` : ""}`,
    librarySource: rate.code || rate.description,
  });
}

async function repriceComponents(json, candidates, zone = null) {
  const components = (json.components || []).map((c) => ({
    kind: c.kind || "material",
    name: c.name,
    quantity: Number(c.quantity) || 0,
    unit: c.unit || "",
    unitPriceNgn: Number(c.unitPriceNgn) || 0,
    source: c.source === "library" ? "library" : "model",
    libraryRef: c.libraryRef || null,
  }));

  const modelPriced = components.filter((c) => c.source === "model");
  const [mats, labs] = await Promise.all([
    findPrices(modelPriced.filter((c) => c.kind === "material").map((c) => c.name), "material", zone),
    findPrices(modelPriced.filter((c) => c.kind === "labour").map((c) => c.name), "labour", zone),
  ]);
  const priceMap = new Map([...mats, ...labs].map((p) => [p.query, p]));
  for (const c of components) {
    const hit = priceMap.get(c.name);
    if (hit && hit.priceNgn > 0) {
      c.unitPriceNgn = hit.priceNgn;
      c.source = "library";
      c.libraryRef = hit.name;
    }
    c.totalNgn = round2(c.quantity * c.unitPriceNgn);
  }

  return totalize({
    unit: json.unit,
    components,
    overheadPercent: Number(json.overheadPercent) || 10,
    profitPercent: Number(json.profitPercent) || 25,
    notes: json.notes || "",
    libraryCandidatesConsidered: candidates.slice(0, 3).map((c) => c.description),
  }, candidates);
}

// Units that price a gang or a machine for a period rather than for one unit
// of finished work. The prompt tells the model to pro-rate these by a daily
// output; this is what verifies that it did.
const PER_PERIOD_UNIT = /\b(day|days|hr|hrs|hour|hours|wk|week|weeks|month|months)\b/i;

// How far out of line with the closest library rate a total has to be before
// it is reported. Deliberately loose — a genuine 2x difference between a
// library rate and a fresh build-up is ordinary, 3x usually is not.
const RATE_RATIO_LIMIT = 3;

/**
 * Recompute the checks the prompt asks the model to perform on itself.
 *
 * The model is instructed to pro-rate per-day labour and to sanity-check its
 * total against the library candidates it was given, but nothing verified that
 * it had. A build-up that ignored those instructions came back indistinguishable
 * from a clean one, so the QS was shown a suspect rate as ordinary output.
 *
 * These are the three failures the SDK documents on RateBuildup.Warnings:
 * a component priced per period without pro-rating, a total wildly out against
 * the closest library rate, and a single line dearer than the whole rate.
 *
 * Returns [] for a clean build-up. Never throws: a check that cannot run must
 * not cost the caller their rate.
 */
function checkBuildup(build, candidates = []) {
  const warnings = [];
  try {
    const components = Array.isArray(build.components) ? build.components : [];
    const rate = Number(build.rateNgn) || 0;

    for (const c of components) {
      const unit = String(c.unit || "");
      const qty = Number(c.quantity) || 0;
      const isTimePriced = (c.kind === "labour" || c.kind === "plant") && PER_PERIOD_UNIT.test(unit);
      if (isTimePriced && qty >= 1) {
        warnings.push(
          `"${c.name}" is priced per ${unit} and carries a quantity of ${qty}. ` +
            `A quantity of 1 or more against a per-period unit is almost always a missing pro-rate — ` +
            `it should be 1 divided by the output per ${unit}.`,
        );
      }
    }

    const reference = candidates
      .map((c) => Number(c.totalCost) || 0)
      .find((v) => v > 0);
    if (reference && rate > 0) {
      const ratio = rate / reference;
      if (ratio >= RATE_RATIO_LIMIT || ratio <= 1 / RATE_RATIO_LIMIT) {
        const closest = candidates.find((c) => (Number(c.totalCost) || 0) === reference);
        warnings.push(
          `This rate is ${ratio >= 1 ? `${ratio.toFixed(1)}x higher than` : `${(1 / ratio).toFixed(1)}x lower than`} ` +
            `the closest library rate for similar work (${closest?.description || "library item"} ` +
            `at ${reference.toLocaleString("en-NG")}). That usually means a units or pro-rating error.`,
        );
      }
    }

    for (const c of components) {
      const total = Number(c.totalNgn) || 0;
      if (rate > 0 && total > rate) {
        warnings.push(
          `"${c.name}" alone costs ${total.toLocaleString("en-NG")}, which is more than the whole ` +
            `rate of ${rate.toLocaleString("en-NG")}. One of the two is wrong.`,
        );
      }
    }
  } catch {
    // A failed check is not worth failing the request over.
  }
  return warnings;
}

function totalize(build, candidates = []) {
  const net = build.components.reduce((s, c) => s + (c.totalNgn || 0), 0);
  const overhead = round2((net * (build.overheadPercent || 0)) / 100);
  const profit = round2((net * (build.profitPercent || 0)) / 100);
  const totalled = {
    ...build,
    netCostNgn: round2(net),
    overheadNgn: overhead,
    profitNgn: profit,
    rateNgn: round2(net + overhead + profit),
  };
  // Always present, empty when clean — the SDK documents it that way, and an
  // absent field would be indistinguishable from "not checked".
  return { ...totalled, warnings: checkBuildup(totalled, candidates) };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
