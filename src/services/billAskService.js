import { invokeJson } from "../clients/bedrock.js";
import { pickModel } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";

// Ask-the-bill: a free-text question answered strictly from the bill the caller
// sent. Read-only by construction — it returns prose, never findings, so no
// answer here can change a bill.
//
// The whole bill is summarised down to totals per section before it reaches the
// model. A 400-line bill sent verbatim on every question would be the most
// expensive feature in the service and would answer no better: the questions
// users actually ask ("why is substructure so large a share") are answered from
// the shape of the cost, not from every line of it.
const MAX_QUESTION = 500;
const MAX_ITEMS = 400;
const TOP_ITEMS = 30;

export async function billAsk({ tenantId, product, question, items, currencyCode }) {
  const q = String(question || "").trim().slice(0, MAX_QUESTION);
  const normItems = (items || []).slice(0, MAX_ITEMS).map((it, i) => ({
    ref: String(it.ref ?? i + 1),
    section: String(it.section || "").trim(),
    description: String(it.description || "").trim().slice(0, 200),
    unit: String(it.unit || "").trim(),
    quantity: Number(it.quantity) || 0,
    rate: Number(it.rate) || 0,
  }));

  const digest = summarise(normItems, currencyCode);

  return runFeature({
    tenantId,
    product,
    feature: "billAsk",
    input: { q: q.toLowerCase(), digest },
    compute: async () => {
      const { modelId } = pickModel("classification");
      const { json } = await invokeJson(
        { tenantId, product, feature: "billAsk", operation: "ask" },
        {
          modelId,
          maxTokens: 1500,
          system: SYSTEM_PROMPT,
          user: JSON.stringify({ question: q, bill: digest }),
        }
      );

      const answer = String(json.answer || "").trim();
      return {
        model: modelId,
        confidence: clamp01(json.confidence ?? 0.7),
        result: {
          answer: answer || "I could not answer that from this bill.",
          // Echoed so the answer can be checked against what the model actually saw.
          basis: { sections: digest.sections.length, itemsConsidered: normItems.length },
        },
      };
    },
  });
}

// Section totals plus the biggest lines. Amount is computed here rather than
// trusted from the caller so the model reasons about arithmetic we control.
function summarise(items, currencyCode) {
  const bySection = new Map();
  let total = 0;

  for (const it of items) {
    const amount = it.quantity * it.rate;
    total += amount;
    const key = it.section || "(unsectioned)";
    const row = bySection.get(key) || { section: key, items: 0, amount: 0 };
    row.items += 1;
    row.amount += amount;
    bySection.set(key, row);
  }

  const sections = [...bySection.values()]
    .map((s) => ({
      ...s,
      amount: round2(s.amount),
      shareOfTotal: total > 0 ? Number((s.amount / total).toFixed(4)) : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const topItems = items
    .map((it) => ({
      section: it.section,
      description: it.description,
      unit: it.unit,
      quantity: it.quantity,
      rate: it.rate,
      amount: round2(it.quantity * it.rate),
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, TOP_ITEMS);

  return { currency: currencyCode || "NGN", total: round2(total), sections, topItems };
}

const SYSTEM_PROMPT = `You are a Nigerian quantity surveyor answering a question about a bill of quantities the user has prepared.

You are given a digest of the bill: the total, per-section totals with each section's share, and the largest individual items. You are NOT given every line.

Rules:
- Answer only from the digest. If the question needs detail that is not in it, say plainly what you would need.
- Lead with the answer in the first sentence, then the supporting figures.
- Quote figures in the bill's currency and name the section they come from.
- Do not propose changes to the bill and do not suggest rates. This is an explanation, not advice to edit.
- Two or three short paragraphs at most.

Return JSON:
{"answer": "...", "confidence": 0.0}`;

const round2 = (n) => Number((Number(n) || 0).toFixed(2));
const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
