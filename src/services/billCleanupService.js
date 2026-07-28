import { invokeJson } from "../clients/bedrock.js";
import { pickModel, ESCALATION_CONFIDENCE_THRESHOLD } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";

// Bill clean-up: turns a raw take-off into something that reads like a priced
// bill. Four finding kinds — description rewrites, unit fixes, duplicate lines,
// and coverage gaps.
//
// Deliberately NOT a rate check: boqCheckService already benchmarks rates
// against the RateGen library deterministically, which is both cheaper and more
// defensible than asking a model whether a number looks right. A caller that
// wants both calls both endpoints.
//
// items: [{ ref, section, description, unit, quantity, isSubItem }]
const BATCH_SIZE = 25;
const MAX_ITEMS = 400;

// Units a Nigerian QS bill actually uses. A unit outside this set is a finding
// on its own — it means the take-off template leaked a raw PlanSwift unit.
const KNOWN_UNITS = new Set(["m", "sq m", "cu m", "no", "kg", "tonne", "sum", "item", "nr", "m2", "m3"]);

export async function billCleanup({ tenantId, product, items, zone, checks }) {
  const wanted = normalizeChecks(checks);

  const normItems = (items || []).slice(0, MAX_ITEMS).map((it, i) => ({
    ref: String(it.ref ?? i + 1),
    section: String(it.section || "").trim(),
    description: String(it.description || "").trim().slice(0, 300),
    unit: String(it.unit || "").trim(),
    quantity: Number(it.quantity) || 0,
    isSubItem: Boolean(it.isSubItem),
  }));

  return runFeature({
    tenantId,
    product,
    feature: "billCleanup",
    // Cache key inputs only — quantities are excluded on purpose. Re-measuring a
    // wall changes the quantity but not the wording, and a clean-up verdict that
    // only depends on text should not be re-bought because a number moved.
    input: {
      checks: wanted,
      zone: zone || null,
      items: normItems.map((i) => `${i.section}|${i.description}|${i.unit}`.toLowerCase()),
    },
    compute: async () => {
      const findings = [];

      // 1. Deterministic pass — no tokens. Blank and unrecognised units, and
      //    exact duplicate wording within a section, need no model at all.
      if (wanted.includes("descriptions")) {
        findings.push(...duplicateFindings(normItems));
      }

      // 2. Model pass for the judgement calls: wording, the right unit for a
      //    described item, and what a QS would expect to be present.
      let usedModel = "rules-only";
      let escalated = false;
      let modelConfidence = 0.9; // deterministic findings only — high by construction

      const needsModel = wanted.includes("descriptions") || wanted.includes("coverage");
      if (needsModel && normItems.length) {
        const billable = normItems.filter((i) => !i.isSubItem);
        const cheap = pickModel("billCleanup");
        const confidences = [];

        for (let i = 0; i < billable.length; i += BATCH_SIZE) {
          const batch = billable.slice(i, i + BATCH_SIZE);
          const payload = { zone: zone || null, checks: wanted, knownUnits: [...KNOWN_UNITS], items: batch };

          let { json } = await invokeJson(
            { tenantId, product, feature: "billCleanup", operation: "cleanup-batch" },
            { modelId: cheap.modelId, maxTokens: 4000, system: SYSTEM_PROMPT, user: JSON.stringify(payload) }
          );
          usedModel = cheap.modelId;

          let batchFindings = sanitize(json.findings, batch, wanted);
          const avg = avgConfidence(batchFindings);

          // Wording is the part users read most closely, so a low-confidence
          // batch is worth the strong tier rather than shipping vague rewrites.
          if (batchFindings.length && avg < ESCALATION_CONFIDENCE_THRESHOLD) {
            const strong = pickModel("billCleanup", { escalate: true });
            ({ json } = await invokeJson(
              { tenantId, product, feature: "billCleanup", operation: "cleanup-batch", escalated: true },
              { modelId: strong.modelId, maxTokens: 4000, system: SYSTEM_PROMPT, user: JSON.stringify(payload) }
            ));
            batchFindings = sanitize(json.findings, batch, wanted);
            usedModel = strong.modelId;
            escalated = true;
          }

          confidences.push(...batchFindings.map((f) => f.confidence));
          findings.push(...batchFindings);
        }

        if (confidences.length) {
          modelConfidence = confidences.reduce((a, b) => a + b, 0) / confidences.length;
        }
      }

      findings.forEach((f, i) => {
        f.id = `f${i + 1}`;
      });

      const summary = {
        items: normItems.length,
        descriptions: findings.filter((f) => f.kind === "description").length,
        units: findings.filter((f) => f.kind === "unit").length,
        duplicates: findings.filter((f) => f.kind === "merge").length,
        missing: findings.filter((f) => f.kind === "missing").length,
      };

      return {
        model: usedModel,
        confidence: modelConfidence,
        result: { zone: zone || null, checks: wanted, summary, findings, escalated },
      };
    },
  });
}

function normalizeChecks(checks) {
  const allowed = ["descriptions", "coverage"];
  const given = (Array.isArray(checks) ? checks : []).map((c) => String(c).toLowerCase());
  const wanted = allowed.filter((c) => given.includes(c));
  // "rates" is accepted in the request and deliberately dropped here — the
  // caller is expected to hit /api/ai/boq-check for that. Defaulting to
  // everything when nothing recognisable was asked for keeps old clients working.
  return wanted.length ? wanted : allowed;
}

// Exact-duplicate wording inside one section. Reported, never merged: folding
// two lines into one means summing their quantities, and quantities are measured
// from drawings — not ours to change.
function duplicateFindings(items) {
  const seen = new Map();
  const findings = [];

  for (const item of items) {
    if (item.isSubItem || !item.description) continue;
    const key = `${item.section}||${item.description.toLowerCase()}||${item.unit.toLowerCase()}`;
    const first = seen.get(key);
    if (!first) {
      seen.set(key, item);
      continue;
    }
    const existing = findings.find((f) => f.itemId === first.ref);
    if (existing) {
      existing.mergeWith.push(item.ref);
      continue;
    }
    findings.push({
      id: "",
      kind: "merge",
      itemId: first.ref,
      section: item.section,
      current: item.description,
      proposed: item.description,
      rationale: `Appears more than once in ${item.section || "this section"} with the same wording and unit — bill it once with the combined quantity, or make the descriptions distinct.`,
      confidence: 0.95,
      severity: "medium",
      mergeWith: [item.ref],
    });
  }
  return findings;
}

// The model is not trusted to stay inside the contract: anything referencing an
// item that was not in the batch, or a kind that was not asked for, is dropped.
function sanitize(raw, batch, wanted) {
  const byRef = new Map(batch.map((i) => [i.ref, i]));
  const out = [];

  for (const f of Array.isArray(raw) ? raw : []) {
    const kind = String(f.kind || "").toLowerCase();
    if (!["description", "unit", "missing"].includes(kind)) continue;
    if (kind === "missing" && !wanted.includes("coverage")) continue;
    if (kind !== "missing" && !wanted.includes("descriptions")) continue;

    const proposed = String(f.proposed || "").trim();
    if (!proposed) continue;

    let item = null;
    if (kind !== "missing") {
      item = byRef.get(String(f.itemId));
      if (!item) continue; // hallucinated reference
      // A "rewrite" that changes nothing is noise; padding the list trains
      // users to stop reading it.
      const current = kind === "unit" ? item.unit : item.description;
      if (current.trim().toLowerCase() === proposed.toLowerCase()) continue;
    }

    out.push({
      id: "",
      kind,
      itemId: item ? item.ref : "",
      section: String(f.section || (item ? item.section : "")).trim(),
      current: item ? (kind === "unit" ? item.unit : item.description) : "",
      proposed,
      rationale: String(f.rationale || "").trim().slice(0, 400),
      confidence: clamp01(f.confidence ?? 0.5),
      severity: ["low", "medium", "high"].includes(String(f.severity)) ? String(f.severity) : "low",
      mergeWith: [],
    });
  }
  return out;
}

const SYSTEM_PROMPT = `You are a Nigerian quantity surveyor preparing a bill of quantities for tender, working to BESMM 4R / SMM principles.

You are given take-off items as measured in PlanSwift. Report only what is genuinely wrong.

Finding kinds you may return:
- "description": the wording is not fit for a priced bill. A bill description states the material, the size or thickness, and the location or application. Rewrite it in that form. Do not invent specification detail that is not implied by the item or its section.
- "unit": the unit is blank, or is not the unit the described work is measured in. Propose the correct unit from knownUnits.
- "missing": work a QS would expect to be present given what IS in the bill, and is not. Examples of the reasoning: blockwork with no rendering; a suspended slab with no formwork; a roof with no fascia or rainwater goods. Put the expected item in "proposed" and the section it belongs in "section". Leave itemId empty.

Rules:
- NEVER propose a change to a quantity. Quantities are measured from drawings.
- Return NO finding for an item that is already correct. An empty findings list is a valid and common answer.
- "rationale" is one sentence a quantity surveyor would accept.
- "confidence" is 0.0-1.0 and must be honest. A hedge is more useful than false certainty.

Return JSON:
{"findings": [{"kind": "description|unit|missing", "itemId": "<ref from the input, or empty for missing>", "section": "...", "proposed": "...", "rationale": "...", "confidence": 0.0, "severity": "low|medium|high"}]}`;

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));

function avgConfidence(list) {
  const vals = (list || []).map((f) => f.confidence ?? 0.5);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 1;
}
