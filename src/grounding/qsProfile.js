import { TenantQsProfile } from "../models/index.js";

// Per-tenant QS house style: how THIS firm words descriptions, which units it
// bills work in, how it orders sections, and which suggestions it has taken or
// refused.
//
// ─── The isolation rule ──────────────────────────────────────────────────────
// Every function here takes a tenantId and filters on it. There is deliberately
// no "find similar across tenants", no aggregation, and no shared example pool.
// Bill descriptions and specifications are tender content: one firm's wording
// surfacing in another firm's bill is a commercial breach, not a smarter model.
// If a cross-tenant feature is ever wanted it needs a product and legal decision
// first, not a quiet query change here.
//
// The profile is grounding, never truth. It biases wording; it can never
// introduce a quantity, and nothing read from it is applied without the user
// accepting the finding it produced.

const MAX_EXAMPLES = 60; // roughly what fits in a prompt without crowding out the bill
const MAX_PROMPT_EXAMPLES = 12;
const MAX_REJECTED = 30;
const MAX_SECTIONS = 40;

export async function getProfile(tenantId) {
  if (!tenantId) return null;
  return TenantQsProfile.findOne({ tenantId }).lean();
}

/// Cheap identity for the cache key. A profile change must not keep serving
/// suggestions made under the previous house style.
export function profileRevision(profile) {
  return profile ? `${profile.tenantId}:${profile.revision || 0}` : "none";
}

/// Renders the profile as a prompt section. Returns "" when the tenant is new,
/// which is the common case on a first job — the prompt then falls back to
/// generic BESMM wording rather than inventing a house style.
export function houseStyleBlock(profile) {
  if (!profile) return "";

  const lines = [];

  const examples = (profile.examples || [])
    // Specifications are what the QS wrote unprompted, so they outrank a
    // suggestion they merely clicked accept on.
    .slice()
    .sort((a, b) => rank(b.origin) - rank(a.origin) || new Date(b.at) - new Date(a.at))
    .filter((e) => e.origin !== "aiRejected")
    .slice(0, MAX_PROMPT_EXAMPLES);

  if (examples.length) {
    lines.push("How this firm words bill descriptions (their own past bills):");
    for (const e of examples) {
      lines.push(
        e.source
          ? `- take-off "${e.source}" -> billed as "${e.accepted}"${e.unit ? ` [${e.unit}]` : ""}`
          : `- "${e.accepted}"${e.unit ? ` [${e.unit}]` : ""}`
      );
    }
  }

  const units = Object.entries(profile.unitConventions || {}).slice(0, 20);
  if (units.length) {
    lines.push("", "Units this firm bills these in:");
    for (const [keyword, unit] of units) lines.push(`- ${keyword}: ${unit}`);
  }

  if ((profile.sectionOrder || []).length) {
    lines.push("", `Section order they work in: ${profile.sectionOrder.slice(0, MAX_SECTIONS).join(" > ")}`);
  }

  if ((profile.rejectedPhrases || []).length) {
    lines.push("", "Wording they have rejected before — do not propose it again:");
    for (const p of profile.rejectedPhrases.slice(0, 10)) lines.push(`- "${p}"`);
  }

  if (!lines.length) return "";

  return [
    "",
    "HOUSE STYLE — this specific firm's own past bills.",
    "Match this wording, unit choice and level of detail in preference to generic phrasing.",
    "It is a style guide, not a source of facts: never copy a quantity or a rate from it.",
    "",
    ...lines,
  ].join("\n");
}

function rank(origin) {
  if (origin === "specification") return 2;
  if (origin === "aiAccepted") return 1;
  return 0;
}

/// Records what a tenant did with a set of suggestions, and anything they wrote
/// themselves. Additive and idempotent-ish: re-sending the same example moves it
/// to the front rather than duplicating it.
export async function recordExamples(tenantId, { examples = [], sectionOrder = [] } = {}) {
  if (!tenantId || (!examples.length && !sectionOrder.length)) return null;

  const profile =
    (await TenantQsProfile.findOne({ tenantId })) ||
    new TenantQsProfile({ tenantId, examples: [], sectionOrder: [], rejectedPhrases: [] });

  const rejected = new Set(profile.rejectedPhrases || []);
  const unitConventions = new Map(Object.entries(profile.unitConventions || {}));
  let kept = profile.examples || [];

  for (const raw of examples) {
    const accepted = String(raw.accepted || "").trim().slice(0, 300);
    const origin = String(raw.origin || "").trim();
    if (!accepted || !["specification", "aiAccepted", "aiRejected"].includes(origin)) continue;

    const entry = {
      source: String(raw.source || "").trim().slice(0, 300),
      accepted,
      unit: String(raw.unit || "").trim().slice(0, 20),
      section: String(raw.section || "").trim().slice(0, 120),
      origin,
      at: new Date(),
    };

    // De-dupe on the wording itself so a re-run of the same bill does not
    // stack twenty copies of one description.
    kept = kept.filter((e) => e.accepted.toLowerCase() !== accepted.toLowerCase());

    if (origin === "aiRejected") {
      rejected.add(accepted);
      continue; // a rejection is a warning, not an example to imitate
    }

    // A phrase they once rejected and have now written themselves is no longer
    // a rejection — the newer signal wins.
    rejected.delete(accepted);
    kept.unshift(entry);

    if (entry.unit) {
      const keyword = keywordOf(accepted);
      if (keyword) unitConventions.set(keyword, entry.unit);
    }
  }

  profile.examples = kept.slice(0, MAX_EXAMPLES);
  profile.rejectedPhrases = [...rejected].slice(-MAX_REJECTED);
  profile.unitConventions = unitConventions;

  if (sectionOrder.length) {
    profile.sectionOrder = sectionOrder
      .map((s) => String(s || "").trim())
      .filter(Boolean)
      .slice(0, MAX_SECTIONS);
  }

  profile.revision = (profile.revision || 0) + 1;
  profile.updatedAt = new Date();
  await profile.save();
  return profile;
}

// First meaningful word of a description — "Blockwork in 225mm..." -> "blockwork".
// Crude on purpose: this only has to be stable enough to spot that a firm always
// bills blockwork in SQ M, not to parse the description.
function keywordOf(description) {
  const word = String(description || "")
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .split(/\s+/)
    .find((w) => w.length > 3 && !STOPWORDS.has(w));
  return word || null;
}

const STOPWORDS = new Set(["with", "and", "the", "from", "into", "over", "under", "including", "size", "thick"]);
