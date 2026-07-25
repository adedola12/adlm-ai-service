import { groundingDb, rategenMasterDb } from "../db/connect.js";
import { config } from "../config/index.js";

// Read-only access to ADLM's RateGen library — the grounding source for every
// QS-facing verdict. Collections live in the ADLM Cloud databases; this module
// only ever reads.
//
//  adlmWeb.rategenrates          master rate items (with material/labour breakdowns)
//  adlmWeb.rategencomputeitems   build-up recipes
//  adlmWeb.rategenmetas          { name, version } — library version, used for
//                                cache busting and audit dataVersion stamps
//  ADLMRateDB.Materials/labours  master price lists

export const NIGERIAN_ZONES = [
  "north_west",
  "north_east",
  "north_central",
  "south_west",
  "south_east",
  "south_south",
];

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Library version string — stamped on every verdict audit and folded into
// every cache key so a library update busts stale cached verdicts.
export async function libraryVersion() {
  try {
    const db = await groundingDb();
    const metas = await db.collection("rategenmetas").find({}).limit(5).toArray();
    if (metas.length) {
      return metas.map((m) => `${m.name || "lib"}:${m.version ?? 0}`).sort().join("|");
    }
  } catch (err) {
    console.error("[rateLibrary] version lookup failed:", err.message);
  }
  return "unversioned";
}

function tokenize(description) {
  return String(description || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2);
}

function scoreMatch(tokens, text) {
  const hay = String(text || "").toLowerCase();
  let hits = 0;
  for (const t of tokens) if (hay.includes(t)) hits++;
  return tokens.length ? hits / tokens.length : 0;
}

// Candidate master rates for a work-item description. Keyword-scored regex
// search — the library is small enough that this is fast and index-free.
export async function findCandidateRates(description, { limit = 8 } = {}) {
  const db = await groundingDb();
  const tokens = tokenize(description);
  if (!tokens.length) return [];
  const or = tokens.slice(0, 6).map((t) => ({ description: { $regex: escapeRegex(t), $options: "i" } }));
  const rows = await db
    .collection("rategenrates")
    .find({ $or: or })
    .limit(100)
    .toArray();
  return rows
    .map((r) => ({ rate: r, score: scoreMatch(tokens, r.description) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ rate, score }) => ({
      code: rate.code || rate.itemNo || "",
      section: rate.sectionLabel || rate.sectionKey || "",
      description: rate.description,
      unit: rate.unit,
      netCost: rate.netCost,
      totalCost: rate.totalCost,
      overheadPercent: rate.overheadPercent,
      profitPercent: rate.profitPercent,
      breakdown: (rate.breakdown || []).map((b) => ({
        componentName: b.componentName,
        quantity: b.quantity,
        unit: b.unit,
        unitPrice: b.unitPrice,
        totalPrice: b.totalPrice,
        refKind: b.refKind,
      })),
      matchScore: Number(score.toFixed(2)),
    }));
}

// Build-up recipes matching a description (used to assemble build-ups from
// library components before asking the model to fill gaps).
export async function findComputeItems(description, { limit = 4 } = {}) {
  const db = await groundingDb();
  const tokens = tokenize(description);
  if (!tokens.length) return [];
  const or = tokens.slice(0, 6).map((t) => ({ name: { $regex: escapeRegex(t), $options: "i" } }));
  const rows = await db.collection("rategencomputeitems").find({ $or: or }).limit(50).toArray();
  return rows
    .map((r) => ({ item: r, score: scoreMatch(tokens, r.name) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ item, score }) => ({
      section: item.section,
      name: item.name,
      outputUnit: item.outputUnit,
      overheadPercentDefault: item.overheadPercentDefault,
      profitPercentDefault: item.profitPercentDefault,
      lines: item.lines || [],
      matchScore: Number(score.toFixed(2)),
    }));
}

// Master material / labour price lookups from ADLMRateDB.
export async function findPrices(names, kind = "material") {
  const db = await rategenMasterDb();
  const coll =
    kind === "labour" ? config.rategenLabCollection : config.rategenMatCollection;
  const results = [];
  for (const name of names.slice(0, 20)) {
    const tokens = tokenize(name);
    if (!tokens.length) continue;
    const or = tokens.slice(0, 4).map((t) => ({
      [kind === "labour" ? "LabourName" : "MaterialName"]: { $regex: escapeRegex(t), $options: "i" },
    }));
    const rows = await db.collection(coll).find({ $or: or }).limit(20).toArray();
    const scored = rows
      .map((r) => {
        const label = kind === "labour" ? r.LabourName : r.MaterialName;
        return { row: r, score: scoreMatch(tokens, label) };
      })
      .sort((a, b) => b.score - a.score);
    if (scored.length && scored[0].score > 0.3) {
      const r = scored[0].row;
      results.push(
        kind === "labour"
          ? { query: name, name: r.LabourName, unit: r.LabourUnit, priceNgn: r.LabourPrice }
          : { query: name, name: r.MaterialName, unit: r.MaterialUnit, priceNgn: r.MaterialPrice }
      );
    }
  }
  return results;
}
