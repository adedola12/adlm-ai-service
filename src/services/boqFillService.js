import { invokeJson } from "../clients/bedrock.js";
import { pickModel, ESCALATION_CONFIDENCE_THRESHOLD } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";
import { isElliptical, anchorDescription } from "./breakdownFillService.js";

// BoQ fill: the client sends a bill in THEIR format, the product has measured
// the model; this puts the measured quantities against the client's lines.
//
// It is the reverse of the product's own export. There the product writes the
// descriptions; here the descriptions are the client's and the quantities are
// ours, so the question is "which of the measured lines is the work this bill
// line names?" — and a bill line is often SEVERAL measured lines (blockwork
// measured per level and per wall type; "concrete in columns" against three
// column sizes).
//
// The quantity is contractual, so the model is kept to judgement only:
//
//   - It picks candidate ids from the list it was given. It never sees or
//     writes a quantity; the quantity is the sum of the picked candidates,
//     computed here.
//   - Candidates are grouped first: the same description in the same unit is
//     one GROUP however many levels it was measured on, and the model picks
//     groups (optionally narrowed to named levels). A group always brings every
//     member with it, so a wall type measured on twenty floors can never be
//     under-counted because a shortlist ran out of room.
//   - Units are enforced here, not trusted. A group whose unit cannot be
//     converted into the bill line's unit is never offered and never accepted.
//     Mass is the one conversion allowed (rebar measured in kg, billed in t).
//   - The shortlist each row sees is built deterministically before the model
//     is asked: unit-compatible groups ranked by shared words with the row's
//     description and heading trail. A row with no compatible group is
//     reported unmatched without a model call.
//   - A measured line picked by two bill lines is reported, not resolved: that
//     is either a double count or two lines the QS meant to split, and only
//     the QS can say which.
//
// A bill description is a fragment (see breakdownFillService for the evidence),
// so rows carry their heading trail, and "Ditto"/lower-case continuations are
// sent with the item they continue, as context — never substituted.
//
// rows:       [{ id, description, unit, headings?: [], section? }]
// candidates: [{ id, description, unit, qty, level?, type? }]
const BATCH_SIZE = 20;
const MAX_ROWS = 400;
const MAX_CANDIDATES = 1500;
const SHORTLIST_PER_ROW = 12;
const MAX_HEADINGS = 4;
const MIN_CONFIDENCE = 0.5;

export async function boqFill({ tenantId, product, rows, candidates }) {
  const normRows = (rows || []).slice(0, MAX_ROWS).map((r) => ({
    id: String(r.id),
    description: String(r.description || "").slice(0, 300),
    unit: String(r.unit || "").trim(),
    section: r.section ? String(r.section).slice(0, 120) : null,
    headings: (Array.isArray(r.headings) ? r.headings : [])
      .map((h) => String(h || "").slice(0, 160))
      .filter(Boolean)
      .slice(-MAX_HEADINGS),
  }));
  const normCands = (candidates || []).slice(0, MAX_CANDIDATES).map((c) => ({
    id: String(c.id),
    description: String(c.description || "").slice(0, 200),
    unit: String(c.unit || "").trim(),
    qty: Number(c.qty) || 0,
    level: c.level ? String(c.level).slice(0, 60) : null,
    type: c.type ? String(c.type).slice(0, 80) : null,
  }));
  const groups = groupCandidates(normCands);
  const groupById = new Map(groups.map((g) => [g.id, g]));

  // Context and shortlist are deterministic, so they are built before the
  // cache lookup and the key covers exactly what the model will see.
  const prepared = normRows.map((r, i) => {
    const continuesFrom = isElliptical(r.description) ? anchorDescription(normRows, i) : null;
    const context = [r.section, ...r.headings, continuesFrom, r.description].filter(Boolean).join(" ");
    return { ...r, continuesFrom, shortlist: shortlist(r.unit, context, groups) };
  });

  return runFeature({
    tenantId,
    product,
    feature: "boqFill",
    input: {
      rows: prepared.map((r) =>
        `${r.section || ""}|${r.headings.join(">")}|${r.description}|${r.unit}|${r.shortlist.join(",")}`.toLowerCase(),
      ),
      // Quantities are in the key although the model never sees them: the
      // cached result carries the summed quantity, and a re-measured model
      // must not be answered with the old totals.
      groups: [...new Set(prepared.flatMap((r) => r.shortlist))].map((id) =>
        groupById
          .get(id)
          .members.map((c) => `${c.id}|${c.description}|${c.unit}|${c.qty}|${c.level || ""}`)
          .join(";")
          .toLowerCase(),
      ),
    },
    compute: async () => {
      const picks = [];
      let usedModel = "none";
      let escalated = false;

      const askable = prepared.filter((r) => r.shortlist.length);
      for (let i = 0; i < askable.length; i += BATCH_SIZE) {
        const batch = askable.slice(i, i + BATCH_SIZE);
        const offered = [...new Set(batch.flatMap((r) => r.shortlist))];
        const payload = {
          rows: batch.map((r) => ({
            id: r.id,
            section: r.section,
            headings: r.headings,
            description: r.description,
            unit: r.unit,
            continuesFrom: r.continuesFrom,
            shortlist: r.shortlist,
          })),
          candidates: offered.map((id) => {
            const g = groupById.get(id);
            return { id: g.id, description: g.description, unit: g.unit, type: g.type, levels: g.levels };
          }),
        };

        const cheap = pickModel("boqFill");
        let { json } = await invokeJson(
          { tenantId, product, feature: "boqFill", operation: "fill-batch" },
          { modelId: cheap.modelId, maxTokens: 4000, system: SYSTEM_PROMPT, user: JSON.stringify(payload) },
        );
        usedModel = cheap.modelId;
        let batchPicks = sanitize(json.fills, batch, groupById);

        // A wrong quantity in a client's bill is worse than a slow one: a
        // low-confidence batch is asked again on the strong tier.
        if (batchPicks.length && avg(batchPicks.map((p) => p.confidence)) < ESCALATION_CONFIDENCE_THRESHOLD) {
          const strong = pickModel("boqFill", { escalate: true });
          ({ json } = await invokeJson(
            { tenantId, product, feature: "boqFill", operation: "fill-batch", escalated: true },
            { modelId: strong.modelId, maxTokens: 4000, system: SYSTEM_PROMPT, user: JSON.stringify(payload) },
          ));
          batchPicks = sanitize(json.fills, batch, groupById);
          usedModel = strong.modelId;
          escalated = true;
        }
        picks.push(...batchPicks);
      }

      const byRow = new Map(normRows.map((r) => [r.id, r]));
      const fills = picks.map((p) => finalize(p, byRow.get(p.rowId)));
      const filledIds = new Set(fills.map((f) => f.rowId));
      const usedCands = new Set(fills.flatMap((f) => f.sources.map((s) => s.candidateId)));

      return {
        model: usedModel + (escalated ? " (escalated)" : ""),
        confidence: fills.length ? avg(fills.map((f) => f.confidence)) : 0,
        result: {
          fills,
          unmatched: prepared
            .filter((r) => !filledIds.has(r.id))
            .map((r) => ({
              rowId: r.id,
              reason: r.shortlist.length ? "no measured line is this work" : "nothing measured in a compatible unit",
            })),
          sharedCandidates: sharedCandidates(fills),
          unusedCandidates: normCands.filter((c) => !usedCands.has(c.id)).map((c) => c.id),
        },
      };
    },
  });
}

// ---- deterministic grouping and shortlist -----------------------------------

// Same description, same unit → one group, whatever level it sits on.
function groupCandidates(cands) {
  const byKey = new Map();
  for (const c of cands) {
    const key = `${c.description.toLowerCase().replace(/\s+/g, " ").trim()}|${unitKey(c.unit)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(c);
  }
  return [...byKey.values()].map((members, i) => ({
    id: `g${i + 1}`,
    description: members[0].description,
    unit: members[0].unit,
    type: members[0].type,
    levels: [...new Set(members.map((m) => m.level).filter(Boolean))],
    members,
  }));
}

function shortlist(rowUnit, context, groups) {
  const rowWords = words(context);
  return groups
    .filter((g) => convertFactor(g.unit, rowUnit) != null)
    .map((g) => ({ id: g.id, score: overlap(rowWords, words(`${g.description} ${g.type || ""}`)) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, SHORTLIST_PER_ROW)
    .map((s) => s.id);
}

// Shared significant words, numbers weighted double: "225mm" vs "150mm" is the
// whole difference between two blockwork lines.
function words(text) {
  return new Set(
    String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9. ]/g, " ")
      .split(/\s+/)
      .map((w) => w.replace(/^\.+|\.+$/g, ""))
      .filter((w) => w.length > 1 && !STOPWORDS.has(w)),
  );
}
function overlap(a, b) {
  let n = 0;
  for (const w of a) if (b.has(w)) n += /\d/.test(w) ? 2 : 1;
  return n;
}
const STOPWORDS = new Set([
  "the", "of", "in", "to", "and", "for", "with", "on", "or", "at", "by", "as", "be", "is",
  "per", "all", "any", "not", "exceeding", "including", "ditto", "above", "described", "work", "works",
]);

// ---- units --------------------------------------------------------------------

// Factor that converts a quantity in `from` into `to`, or null when the two
// cannot be the same measurement. Only mass converts; m, m2, m3 and nr never do.
export function convertFactor(from, to) {
  const a = unitOf(from);
  const b = unitOf(to);
  if (!a || !b || a.dim !== b.dim) return null;
  return a.scale / b.scale;
}
function unitKey(unit) {
  const u = unitOf(unit);
  return u ? `${u.dim}:${u.scale}` : String(unit || "").trim().toLowerCase();
}
function unitOf(unit) {
  const u = String(unit || "").trim().toLowerCase().replace(/\s+/g, "").replace(/\.$/, "");
  return UNITS[u] || null;
}
const UNITS = (() => {
  const t = {};
  const add = (dim, scale, ...names) => names.forEach((n) => (t[n] = { dim, scale }));
  add("area", 1, "m2", "m²", "sqm", "sq.m", "sqmt", "sm");
  add("volume", 1, "m3", "m³", "cum", "cu.m", "cumt");
  add("length", 1, "m", "lm", "rm", "linm", "l.m", "metre", "meter", "metres");
  add("count", 1, "nr", "no", "nos", "number", "each", "ea", "pcs", "pc");
  add("mass", 1, "kg", "kgs", "kilogram");
  add("mass", 1000, "t", "tonne", "tonnes", "ton", "tons", "mt");
  return t;
})();

// ---- model output ---------------------------------------------------------------

function sanitize(rawFills, batch, groupById) {
  const rowById = new Map(batch.map((r) => [r.id, r]));
  const seen = new Set();
  const out = [];
  for (const f of Array.isArray(rawFills) ? rawFills : []) {
    const row = rowById.get(String(f?.rowId));
    if (!row || seen.has(row.id)) continue; // invented or repeated row
    const confidence = clamp01(Number(f.confidence));
    if (confidence < MIN_CONFIDENCE) continue;
    const offered = new Set(row.shortlist);
    const members = new Map();
    for (const p of Array.isArray(f.picks) ? f.picks : []) {
      const g = groupById.get(String(p?.groupId));
      if (!g || !offered.has(g.id) || convertFactor(g.unit, row.unit) == null) continue;
      // Levels narrow a group, never widen it; an unknown level name matches nothing.
      const levels =
        Array.isArray(p.levels) && p.levels.length ? new Set(p.levels.map((l) => String(l).toLowerCase())) : null;
      for (const m of g.members) if (!levels || levels.has(String(m.level || "").toLowerCase())) members.set(m.id, m);
    }
    if (!members.size) continue;
    seen.add(row.id);
    out.push({ rowId: row.id, members: [...members.values()], confidence, reason: String(f.reason || "").slice(0, 160) });
  }
  return out;
}

function finalize(pick, row) {
  const sources = pick.members.map((c) => ({
    candidateId: c.id,
    description: c.description,
    level: c.level,
    qty: c.qty,
    unit: c.unit,
    qtyInRowUnit: round(c.qty * convertFactor(c.unit, row.unit)),
  }));
  return {
    rowId: row.id,
    qty: round(sources.reduce((s, x) => s + x.qtyInRowUnit, 0)),
    unit: row.unit,
    sources,
    confidence: pick.confidence,
    reason: pick.reason,
    converted: sources.some((s) => unitOf(s.unit)?.scale !== unitOf(row.unit)?.scale),
  };
}

function sharedCandidates(fills) {
  const byCand = new Map();
  for (const f of fills)
    for (const s of f.sources) byCand.set(s.candidateId, [...(byCand.get(s.candidateId) || []), f.rowId]);
  return [...byCand].filter(([, rowIds]) => rowIds.length > 1).map(([candidateId, rowIds]) => ({ candidateId, rowIds }));
}

const round = (n) => Math.round(n * 1000) / 1000;
const clamp01 = (n) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0);
const avg = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

const SYSTEM_PROMPT = `You are a Nigerian quantity surveyor filling a client's bill of quantities from quantities measured off a BIM model.

You are given:
- "rows": the client's bill lines, each { id, section, headings, description, unit, continuesFrom, shortlist }.
  A bill description is a fragment: read it under its "section" and "headings" (the unpriced heading lines above it, outermost first).
  "continuesFrom" is set when the line is a "Ditto"/"as above"/lower-case continuation: it is the item this line continues.
  "shortlist" is the ids of the ONLY candidates you may pick for that row.
- "candidates": measured work, each { id, description, unit, type, levels }. One candidate is the same measured line on every level listed. You are NOT shown quantities; do not ask for them.

For each row, pick the candidate(s) whose measured work IS the work the bill line describes:
- A pick is { groupId, levels }. levels null = every level of that candidate (the normal case). Set levels only when the bill line (or its section/headings) names specific floors; copy level names exactly from the candidate.
- Pick SEVERAL candidates when the bill line covers them together: the same work measured as different types ("225mm sandcrete blockwork" = every 225mm blockwork candidate). Never add candidates of different work to reach a total.
- Respect every qualifier: thickness, size, mix/grade, element (column vs beam vs slab), location (internal/external), and material. "150mm blockwork" is not "225mm blockwork"; "concrete in beams" is not "concrete in columns".
- Units are already checked: every shortlisted candidate is in the row's unit or one the service converts (kg to tonnes). Do not lower confidence for a kg/tonne difference.
- Leave a row out when no candidate is the same work. A wrong fill is worse than an empty one: the QS will measure it.
- confidence: 0.9+ exact same work, 0.7-0.89 same work described differently, 0.5-0.69 probable but a qualifier is unclear. Below 0.5 leave the row out.
- rowId and groupId must be copied EXACTLY from the input, and groupId must come from that row's shortlist.

Return JSON:
{"fills":[{"rowId":"...","picks":[{"groupId":"...","levels":null}],"confidence":0.0,"reason":"<10 words>"}]}`;
