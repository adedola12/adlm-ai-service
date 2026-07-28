import { invokeJson } from "../clients/bedrock.js";
import { pickModel } from "../governance/modelRouter.js";
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
      const best = candidates[0];
      if (best && best.matchScore >= 0.85 && best.breakdown?.length) {
        return {
          model: "library-only",
          confidence: 0.95,
          result: buildFromLibrary(best, normZone),
        };
      }

      // Model assembles the build-up, grounded in the candidates + recipes.
      const { modelId } = pickModel("rateReasoning");
      const { json } = await invokeJson(
        { tenantId, product, feature: "rateBuildup", operation: "assemble" },
        {
          modelId,
          maxTokens: 3000,
          system: SYSTEM_PROMPT,
          user: JSON.stringify({
            workItem: { description, unit: unit || null, zone: normZone },
            libraryCandidates: candidates,
            libraryRecipes: recipes,
          }),
        }
      );

      // Re-price model-proposed components against the zone-priced master
      // lists so library prices win over model guesses wherever a match exists.
      const result = await repriceComponents(json, candidates, normZone);
      return { model: modelId, confidence: json.confidence ?? 0.5, result };
    },
  });
}

const SYSTEM_PROMPT = `You are a Nigerian quantity surveyor's assistant assembling a unit-rate build-up following BESMM 4R measurement conventions. You are given a work item and candidate rates/recipes from ADLM's RateGen library (prices in NGN).

Rules:
- Prefer library data. Only infer quantities/prices the library does not cover, and mark those inferred.
- Output realistic Nigerian market values. Quantities are per single unit of the work item's measurement unit.
- Include materials, labour, plant (if applicable), then overhead and profit percentages.

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

function buildFromLibrary(rate, zone) {
  const components = rate.breakdown.map((b) => ({
    kind: b.refKind || "material",
    name: b.componentName,
    quantity: b.quantity,
    unit: b.unit,
    unitPriceNgn: b.unitPrice,
    totalNgn: b.totalPrice ?? round2((b.quantity || 0) * (b.unitPrice || 0)),
    source: "library",
    libraryRef: rate.code || rate.description,
  }));
  return totalize({
    unit: rate.unit,
    zone,
    components,
    overheadPercent: rate.overheadPercent ?? 10,
    profitPercent: rate.profitPercent ?? 25,
    notes: `Matched library rate: ${rate.description}`,
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
  });
}

function totalize(build) {
  const net = build.components.reduce((s, c) => s + (c.totalNgn || 0), 0);
  const overhead = round2((net * (build.overheadPercent || 0)) / 100);
  const profit = round2((net * (build.profitPercent || 0)) / 100);
  return {
    ...build,
    netCostNgn: round2(net),
    overheadNgn: overhead,
    profitNgn: profit,
    rateNgn: round2(net + overhead + profit),
  };
}

const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
