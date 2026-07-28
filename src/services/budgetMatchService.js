import { invokeJson } from "../clients/bedrock.js";
import { pickModel } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";

// Matches unpriced budget rows (QUIV's labour rows that price at 0 because
// their names don't align with any library entry) against caller-supplied
// candidate rates. Same contract discipline as takeoffCommand: the model only
// PICKS candidate ids from the list it was given — it never invents a rate.
// Unit compatibility is enforced here, not trusted from the model.
//
// rows:       [{ id, description, unit }]
// candidates: [{ id, name, unit, rate }]
export async function budgetMatch({ tenantId, product, rows, candidates }) {
  const inRows = (rows || []).slice(0, 120).map((r) => ({
    id: String(r.id),
    description: String(r.description || "").slice(0, 200),
    unit: String(r.unit || "").trim(),
  }));
  const inCands = (candidates || []).slice(0, 400).map((c) => ({
    id: String(c.id),
    name: String(c.name || "").slice(0, 200),
    unit: String(c.unit || "").trim(),
    rate: Number(c.rate) || 0,
  }));
  const candById = new Map(inCands.map((c) => [c.id, c]));

  return runFeature({
    tenantId,
    product,
    feature: "budgetMatch",
    input: {
      rows: inRows.map((r) => `${r.description}|${r.unit}`.toLowerCase()),
      cands: inCands.map((c) => `${c.id}|${c.unit}|${c.rate}`),
    },
    compute: async () => {
      const { modelId } = pickModel("classification");
      const { json } = await invokeJson(
        { tenantId, product, feature: "budgetMatch", operation: "match" },
        {
          modelId,
          maxTokens: 4000,
          system: SYSTEM_PROMPT,
          user: JSON.stringify({ rows: inRows, candidates: inCands }),
        }
      );

      const rowIds = new Set(inRows.map((r) => r.id));
      const matches = [];
      for (const m of json.matches || []) {
        const cand = candById.get(String(m.candidateId));
        if (!rowIds.has(String(m.rowId)) || !cand) continue; // invented id — drop
        const row = inRows.find((r) => r.id === String(m.rowId));
        if (!unitsCompatible(row.unit, cand.unit)) continue; // never cross units
        matches.push({
          rowId: row.id,
          candidateId: cand.id,
          candidateName: cand.name,
          unit: cand.unit,
          rate: cand.rate,
          confidence: Math.min(1, Math.max(0, Number(m.confidence) || 0)),
          reason: String(m.reason || "").slice(0, 160),
        });
      }
      const matchedRowIds = new Set(matches.map((m) => m.rowId));
      return {
        model: modelId,
        confidence: json.confidence ?? 0.7,
        result: {
          matches,
          unmatched: inRows.filter((r) => !matchedRowIds.has(r.id)).map((r) => r.id),
        },
      };
    },
  });
}

// A per-day trade rate must never price per-m³/m²/m/nr work.
const DAY_UNITS = /^(day|days|d|per\s*day|hr|hour|hours)$/i;
function unitsCompatible(rowUnit, candUnit) {
  const a = (rowUnit || "").toLowerCase().replace(/\s+/g, "");
  const b = (candUnit || "").toLowerCase().replace(/\s+/g, "");
  if (!a || !b) return false;
  if (DAY_UNITS.test(a) !== DAY_UNITS.test(b)) return false;
  const norm = (u) => u.replace(/[^a-z0-9]/g, "").replace(/^sqm$|^m2$/, "m2").replace(/^cum$|^m3$/, "m3").replace(/^no$|^nr$|^number$/, "nr").replace(/^lm$|^m$/, "m");
  return norm(a) === norm(b);
}

const SYSTEM_PROMPT = `You match unpriced construction-budget labour rows to candidate labour rates for a Nigerian quantity surveyor.

You are given:
- "rows": unpriced rows, each { id, description, unit }.
- "candidates": the ONLY valid rates, each { id, name, unit, rate }.

Rules:
- A match must be the SAME work in the SAME unit of measurement. "Labour placing concrete in beams" (m3) matches "Workmanship in-situ concrete beams" (m3), not "Mason (per day)".
- Never match across incompatible units (a per-day trade rate is NOT a per-m3/m2/nr workmanship rate).
- Only return matches you are reasonably sure of; leave doubtful rows unmatched. confidence per match: 0.9+ near-exact, 0.7-0.89 same work reworded, below 0.7 do not return it.
- candidateId and rowId must be copied EXACTLY from the input. Never invent ids or rates.

Return JSON:
{"matches":[{"rowId":"...","candidateId":"...","confidence":0.0,"reason":"<8 words max>"}],"confidence":0.0}`;
