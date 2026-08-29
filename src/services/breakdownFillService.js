import { invokeJson } from "../clients/bedrock.js";
import { pickModel, ESCALATION_CONFIDENCE_THRESHOLD } from "../governance/modelRouter.js";
import { findPrices, NIGERIAN_ZONES } from "../grounding/rateLibrary.js";
import { runFeature } from "./featurePipeline.js";

// Breakdown fill: works out what a BoQ item is actually MADE OF, from the
// description the QS wrote, and prices those lines from the RateGen master
// lists. It exists for the gap the first-principles recipe leaves behind —
// HERON's MaterialBreakdownCalculator only knows the trades it has recipes for,
// so an item outside that set arrives at the budget with little or no cost and
// the whole rate falls into margin (the "Other materials" balancing line).
//
// Deliberately NOT a rate build-up. /rate-buildup answers "what should this
// cost?" and returns a rate with overhead and profit. This answers the narrower
// question "what goes into the work this description names?", takes the QS's own
// rate as given, and never tries to make its lines add up to that rate:
//
//   - The rate is NOT sent to the model and is NOT part of the cache key. A
//     model told to hit a target number will size quantities to reach it, which
//     is exactly the fabrication this feature must not produce. Quantities come
//     from the described work; coverage against the rate is then computed here,
//     deterministically, so the QS can see the shortfall rather than have it
//     papered over.
//   - Lines the caller already has are passed in as `known` and are never
//     re-proposed. This fills a breakdown; it does not overwrite one.
//
// A real BoQ description is a FRAGMENT, not a sentence. Measured against five
// live Nigerian bills, two conventions decide whether this feature works at all:
//
//   1. Items sit under unpriced heading lines that carry the actual material:
//        M10: SAND CEMENT/CONCRETE/SCREEDS/TOPPINGS
//          Mortar, cement and sand (1:3) screeded bed.
//            30mm work to floors on concrete base; one coat
//        B | Skirting | 655 | m
//      "Skirting" alone cannot be broken down. "10MPa/19mm concrete" above
//      "Column bases; thickness not exceeding 50mm" is what names the concrete.
//   2. "Ditto", "as above" and a description simply opening in lower case all
//      continue the item before them (90 such references across those bills).
//
// So the caller passes the heading trail and the items in bill order, and the
// model is given the item's context rather than a fragment. Nothing is rewritten
// deterministically: a textual ditto-substitution produces sentences no QS
// wrote ("Patterned, width exceeding 300; (Bedrooms); width exceeding 300;
// (Toilets)"), and the model reads the two fields correctly when told what they
// mean.
//
// items: [{ ref, description, unit, quantity?, rateNgn?, section?, headings?: [],
//           known?: [{ name, quantity?, unit?, unitPriceNgn? }] }]
const BATCH_SIZE = 12;
const MAX_ITEMS = 200;
const MAX_KNOWN = 12;
const MAX_LINES_PER_ITEM = 14;
const MAX_HEADINGS = 4;
// findPrices reads at most 20 names per call, so lookups are chunked to match.
const PRICE_CHUNK = 20;

export async function breakdownFill({ tenantId, product, items, zone }) {
  const normZone = NIGERIAN_ZONES.includes(zone) ? zone : null;

  const normItems = (items || []).slice(0, MAX_ITEMS).map((it, i) => ({
    ref: String(it.ref ?? i + 1),
    description: String(it.description || "").trim().slice(0, 300),
    section: String(it.section || "").trim().slice(0, 120),
    // Nearest heading last — the prompt is told the last one is the most specific.
    headings: (Array.isArray(it.headings) ? it.headings : [])
      .slice(-MAX_HEADINGS)
      .map((h) => String(h || "").trim().slice(0, 200))
      .filter(Boolean),
    unit: normalizeUnit(it.unit),
    quantity: Number(it.quantity) || 0,
    rateNgn: Number(it.rateNgn) || 0,
    known: (Array.isArray(it.known) ? it.known : [])
      .slice(0, MAX_KNOWN)
      .map((k) => ({
        name: String(k.name || "").trim().slice(0, 120),
        quantity: Number(k.quantity) || 0,
        unit: String(k.unit || "").trim(),
        unitPriceNgn: Number(k.unitPriceNgn) || 0,
      }))
      .filter((k) => k.name),
  })).filter((it) => it.description);

  return runFeature({
    tenantId,
    product,
    feature: "breakdownFill",
    // Text and known-line names only. Quantities and rates are excluded on
    // purpose: re-measuring a wall or re-pricing it changes neither what the
    // work is made of nor the per-unit quantities this returns, and a cached
    // answer must not be re-bought because a number moved.
    input: {
      zone: normZone,
      // Context is part of the question: two items both reading "Skirting" break
      // down differently under a screed heading and under a tiling heading, so
      // the trail belongs in the key.
      items: normItems.map((i) =>
        `${i.section}|${i.headings.join(">")}|${i.description}|${i.unit}|${i.known
          .map((k) => k.name)
          .sort()
          .join(",")}`.toLowerCase(),
      ),
    },
    compute: async () => {
      const proposals = [];
      const confidences = [];
      let usedModel = "none";
      let escalated = false;

      for (let i = 0; i < normItems.length; i += BATCH_SIZE) {
        const batch = normItems.slice(i, i + BATCH_SIZE);
        const payload = {
          zone: normZone,
          items: batch.map((b, n) => ({
            ref: b.ref,
            section: b.section || null,
            headings: b.headings,
            description: b.description,
            unit: b.unit,
            // Elliptical descriptions only. Sent as context, never substituted:
            // the model is told what it means and reads it correctly.
            continuesFrom: isElliptical(b.description) ? previousDescription(normItems, i + n) : null,
            alreadyCovered: b.known.map((k) => k.name),
          })),
        };

        const cheap = pickModel("breakdownFill");
        let { json } = await invokeJson(
          { tenantId, product, feature: "breakdownFill", operation: "fill-batch" },
          { modelId: cheap.modelId, maxTokens: 4000, system: SYSTEM_PROMPT, user: JSON.stringify(payload) },
        );
        usedModel = cheap.modelId;

        let batchLines = sanitize(json.items, batch);
        let avg = avgConfidence(batchLines);

        // A low-confidence batch is worth the strong tier: these quantities go
        // straight into a budget the QS prices from, and a vague guess there is
        // worse than a slow answer.
        if (batchLines.length && avg < ESCALATION_CONFIDENCE_THRESHOLD) {
          const strong = pickModel("breakdownFill", { escalate: true });
          ({ json } = await invokeJson(
            { tenantId, product, feature: "breakdownFill", operation: "fill-batch", escalated: true },
            { modelId: strong.modelId, maxTokens: 4000, system: SYSTEM_PROMPT, user: JSON.stringify(payload) },
          ));
          batchLines = sanitize(json.items, batch);
          avg = avgConfidence(batchLines);
          usedModel = strong.modelId;
          escalated = true;
        }

        confidences.push(...batchLines.map((p) => p.confidence));
        proposals.push(...batchLines);
      }

      await priceProposals(proposals, normZone);

      const byRef = new Map(normItems.map((it) => [it.ref, it]));
      const filled = proposals.map((p) => finalizeItem(p, byRef.get(p.ref)));

      return {
        model: usedModel,
        confidence: confidences.length
          ? confidences.reduce((a, b) => a + b, 0) / confidences.length
          : 0.5,
        result: {
          zone: normZone,
          summary: {
            items: normItems.length,
            filled: filled.filter((f) => f.lines.length).length,
            lines: filled.reduce((s, f) => s + f.lines.length, 0),
            unfilled: normItems
              .filter((it) => !filled.some((f) => f.ref === it.ref && f.lines.length))
              .map((it) => it.ref),
          },
          items: filled,
          escalated,
        },
      };
    },
  });
}

const SYSTEM_PROMPT = `You are a Nigerian quantity surveyor's assistant. For each bill item you are given, list what the described work is MADE OF: the materials it consumes and the labour it takes, per ONE unit of that item, following BESMM 4R measurement conventions.

You are given "items", each { ref, section, headings, description, unit, continuesFrom, alreadyCovered }.

READ THE ITEM FIRST. A bill description is a fragment, not a sentence:
- "headings" are the unpriced lines the item sits under, nearest LAST, and they usually carry the material the description omits. Under headings ["Mortar, cement and sand (1:3) screeded bed.", "30mm work to floors on concrete base; one coat"], a description of "Skirting" is a 30mm cement-sand screeded skirting — not a tiled one. Under "10MPa/19mm concrete", "Column bases; thickness not exceeding 50mm" is 10MPa concrete.
- "section" is the work section (e.g. "REINFORCED CONCRETE", "M40: STONE/QUARRY/CERAMIC TILING").
- "continuesFrom", when present, is the item immediately above: this description begins "Ditto", "as above", or in lower case, and means the SAME work varied by what follows it. "Ditto; width exceeding 300; (Toilets)" after a porcelain floor tile item is that same tile, in the toilets.
- The item is the DESCRIPTION, refined by its context — never break down the heading on its own.

Rules:
- EVERY quantity is per ONE unit of the item (one m2, one m3, one m, one nr) — never for the whole item, never per day, per gang or per batch.
- "alreadyCovered" lists lines the caller already has. Do NOT return those again, and do not return a renamed version of one. Return only what is MISSING.
- Include the waste/lap allowance a Nigerian QS would measure (mortar, laps to reinforcement, cutting waste to tiles), inside the quantity.
- Labour: return ONE line per item, named for the work ("Labour — blockwork"), quantity per one unit of the item. If the labour rate you have in mind is a gang day-rate, pro-rate it: quantity = 1 / (units the gang produces per day). A labour quantity of 1 or more against a "day" unit is almost always a missing pro-rate.
- Name materials the way a Nigerian supplier price list names them (e.g. "Cement", "Sharp sand", "Granite 3/4in", "12mm high yield reinforcement", "Hollow sandcrete block 230mm"). Plain names match the price list; brand names and long qualifiers do not.
- Return NOTHING for an item whose description does not name physical work (a heading, a preamble, a provisional sum, "as described"). An empty list is a valid, useful answer — do not invent content to fill it.
- Confidence per item: 0.9+ a standard build-up you are sure of, 0.7-0.89 a reasonable reading of the description, below 0.6 if the description is too vague to break down.

Return JSON:
{"items":[{"ref":"...","confidence":0.0,"note":"<12 words max, assumptions only>","lines":[{"kind":"material|labour","name":"...","quantity":0.0,"unit":"..."}]}]}`;

// A description that opens with "Ditto"/"as above", or simply in lower case,
// carries on from the item before it — both forms appear throughout real bills
// ("Ditto; width exceeding 300; (Toilets)", "maximum depth not exceeding
// 1.50m..." under an item that named the excavation).
// Two separate tests on purpose. The keywords are case-insensitive because bills
// write "Ditto" far more often than "ditto"; the lower-case test must NOT be,
// because opening in lower case is itself the signal that the line continues the
// one above.
// "d°" and "Do." are the ditto marks bills actually use. Matching a bare "do"
// would swallow any description starting "Double...", so the abbreviation is
// only recognised with its degree sign or its full stop.
const CONTINUATION_WORD = /^\s*(ditto\b|d°|do\.|as\s+(above|before|described))/i;
const OPENS_LOWER_CASE = /^\s*[a-z]/;
function isElliptical(description) {
  const d = String(description || "");
  return CONTINUATION_WORD.test(d) || OPENS_LOWER_CASE.test(d);
}

// The nearest preceding item's description, with its own trail, so a chain of
// dittos still resolves to something a QS would recognise.
function previousDescription(items, index) {
  const prev = items[index - 1];
  if (!prev) return null;
  return [...prev.headings.slice(-2), prev.description].filter(Boolean).join(" > ").slice(0, 300);
}

// Model output is never trusted as shape: refs must exist, numbers must be
// numbers, and a line that merely renames something the caller already has is
// dropped — re-proposing known content is how a "fill" quietly becomes a
// double-count in the budget.
function sanitize(rawItems, batch) {
  const byRef = new Map(batch.map((b) => [b.ref, b]));
  const out = [];

  for (const raw of Array.isArray(rawItems) ? rawItems : []) {
    const item = byRef.get(String(raw.ref));
    if (!item) continue; // invented ref — drop

    const knownKeys = new Set(item.known.map((k) => nameKey(k.name)));
    const seen = new Set();
    const lines = [];

    for (const line of Array.isArray(raw.lines) ? raw.lines : []) {
      const name = String(line.name || "").trim().slice(0, 120);
      const quantity = Number(line.quantity) || 0;
      if (!name || quantity <= 0) continue;

      const key = nameKey(name);
      if (knownKeys.has(key) || seen.has(key)) continue;
      seen.add(key);

      lines.push({
        kind: line.kind === "labour" ? "labour" : "material",
        name,
        quantity: round4(quantity),
        unit: String(line.unit || "").trim().slice(0, 20),
        unitPriceNgn: 0,
        totalNgn: 0,
        source: "model",
        libraryRef: null,
      });
      if (lines.length >= MAX_LINES_PER_ITEM) break;
    }

    out.push({
      ref: item.ref,
      unit: item.unit,
      lines,
      note: String(raw.note || "").slice(0, 120),
      confidence: clamp01(Number(raw.confidence) || 0),
    });
  }
  return out;
}

// Prices every proposed line against the zone-aware master lists. A line the
// library can price is relabelled source:"library" and carries the library's
// own name, so the QS can tell a looked-up price from an inferred one — the
// same contract /rate-buildup gives them.
async function priceProposals(proposals, zone) {
  const all = proposals.flatMap((p) => p.lines);
  const priceMap = new Map();

  for (const kind of ["material", "labour"]) {
    const names = [...new Set(all.filter((l) => l.kind === kind).map((l) => l.name))];
    for (let i = 0; i < names.length; i += PRICE_CHUNK) {
      const hits = await findPrices(names.slice(i, i + PRICE_CHUNK), kind, zone);
      for (const h of hits) priceMap.set(`${kind}|${h.query}`, h);
    }
  }

  for (const line of all) {
    const hit = priceMap.get(`${line.kind}|${line.name}`);
    if (hit && hit.priceNgn > 0) {
      line.unitPriceNgn = hit.priceNgn;
      line.source = "library";
      line.libraryRef = hit.name;
      if (hit.unit) line.pricedUnit = hit.unit;
      if (hit.zone) line.pricedZone = hit.zone;
    }
    line.totalNgn = round2(line.quantity * line.unitPriceNgn);
  }
}

// Units that price a gang or a machine for a period rather than one unit of
// finished work. The prompt tells the model to pro-rate these; this verifies it.
const PER_PERIOD_UNIT = /\b(day|days|hr|hrs|hour|hours|wk|week|weeks|month|months)\b/i;

function finalizeItem(proposal, item) {
  const filledNet = round2(proposal.lines.reduce((s, l) => s + (l.totalNgn || 0), 0));
  const knownNet = round2(
    (item?.known || []).reduce((s, k) => s + (k.quantity || 0) * (k.unitPriceNgn || 0), 0),
  );
  const rate = item?.rateNgn || 0;
  const quantity = item?.quantity || 0;

  const coverage = {
    knownNetNgn: knownNet,
    filledNetNgn: filledNet,
    // What the fill adds across the whole measured quantity — the figure that
    // actually moves the budget.
    filledTotalNgn: round2(filledNet * quantity),
    rateNgn: rate || null,
    // Share of the rate now accounted for. Null rather than 0 when no rate was
    // supplied: "not known" and "covers nothing" are different answers.
    coverageOfRate: rate > 0 ? round4((knownNet + filledNet) / rate) : null,
    residualNgn: rate > 0 ? round2(rate - knownNet - filledNet) : null,
  };

  return {
    ref: proposal.ref,
    unit: proposal.unit,
    lines: proposal.lines,
    note: proposal.note,
    confidence: proposal.confidence,
    coverage,
    warnings: checkFill(proposal.lines, coverage),
  };
}

// The checks the prompt asks the model to perform on itself, recomputed here.
// A batch that ignored the pro-rating rule came back indistinguishable from a
// clean one, so the QS was shown a fabricated quantity as ordinary output.
// Never throws: a failed check must not cost the caller their breakdown.
function checkFill(lines, coverage) {
  const warnings = [];
  try {
    for (const l of lines) {
      if (l.kind === "labour" && PER_PERIOD_UNIT.test(l.unit) && l.quantity >= 1) {
        warnings.push(
          `"${l.name}" is priced per ${l.unit} and carries a quantity of ${l.quantity}. ` +
            `A quantity of 1 or more against a per-period unit is almost always a missing pro-rate — ` +
            `it should be 1 divided by the output per ${l.unit}.`,
        );
      }
    }

    const rate = coverage.rateNgn || 0;
    if (rate > 0 && coverage.residualNgn !== null && coverage.residualNgn < 0) {
      warnings.push(
        `The filled breakdown costs ${fmt(coverage.knownNetNgn + coverage.filledNetNgn)} per unit against ` +
          `a rate of ${fmt(rate)} — this item is priced below its own cost, before any overhead or profit.`,
      );
    }

    for (const l of lines) {
      if (rate > 0 && l.totalNgn > rate) {
        warnings.push(
          `"${l.name}" alone costs ${fmt(l.totalNgn)} per unit, more than the whole rate of ${fmt(rate)}. ` +
            `One of the two is wrong.`,
        );
      }
    }
  } catch {
    // A failed check is not worth failing the request over.
  }
  return warnings;
}

// HERON sends PlanSwift's own unit spellings ("SQ M", "CU M", "Nr"); the price
// lists and the prompt both speak the bill's units.
function normalizeUnit(unit) {
  const u = String(unit || "").trim().toLowerCase().replace(/\s+/g, "");
  const map = {
    sqm: "m2", m2: "m2", sqmt: "m2", "m²": "m2", "sq.m": "m2", sqm2: "m2",
    cum: "m3", m3: "m3", cumt: "m3", "m³": "m3", "cu.m": "m3",
    m: "m", lm: "m", rm: "m",
    no: "nr", nr: "nr", number: "nr", each: "nr",
    kg: "kg", tonne: "tonne", ton: "tonne", t: "tonne",
    sum: "sum", item: "item",
  };
  return map[u] || String(unit || "").trim();
}

// Names match when their significant words do, so "Cement" and "cement (bags)"
// are the same line and are not proposed twice.
function nameKey(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !STOPWORDS.has(w))
    .sort()
    .join(" ");
}
const STOPWORDS = new Set(["the", "a", "of", "in", "to", "and", "for", "with", "per", "bag", "bags"]);

const avgConfidence = (rows) =>
  rows.length ? rows.reduce((s, r) => s + (r.confidence || 0), 0) / rows.length : 0;
const clamp01 = (n) => Math.min(1, Math.max(0, n));
const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
const round4 = (n) => Math.round((n + Number.EPSILON) * 10000) / 10000;
const fmt = (n) => `₦${Number(n || 0).toLocaleString("en-NG")}`;
