import { rategenMasterDb } from "../db/connect.js";
import { config } from "../config/index.js";

// Read-only grounding on the RateGen ADMIN cluster (RATEGEN_MONGO_URI —
// same database the website's /rategen/master routes serve):
//
//  ADLMRateDB.Materials / labours      zone-priced master price lists
//                                      (479 materials x 6 zones; labour+plant)
//  ADLMRateDB.<trade>_items            master rate build-ups with component
//                                      breakdowns (blockwork_items, ...)
//
// This module only ever reads.

export const NIGERIAN_ZONES = [
  "north_west",
  "north_east",
  "north_central",
  "south_west",
  "south_east",
  "south_south",
];

const ITEM_COLLECTIONS = [
  "blockwork_items",
  "concretework_items",
  "finishes_items",
  "groundwork_items",
  "paintwork_items",
  "roofwork_items",
  "steelwork_items",
  "windowsAndDoor_items",
];

const LABOUR_HINTS = /labour|workmanship|mason|carpenter|iron\s*bender|welder|fixing|placing|loading|unloading|foreman|headman|tradesman/i;

// ── Material/labour name matching ───────────────────────────────────────────
// Scoring by query coverage alone is why "Water" returned "Water proof
// membrane - Bitulene 180HP" at N68,000: the one query token appears, so it
// scored a perfect 1.0, exactly like a real water row would have. Six
// different cements scored 1.0 for "cement" too, and the winner was whichever
// row the database happened to return first.
//
// The signal that separates them is what the candidate adds. "Cement (50kg
// bag)" adds a size and a packaging word — still cement. "Coloured Cement",
// "Loading and unloading cement" and "Water proof membrane" add CONTENT words
// that make them a different thing. So extra tokens are classified, and only
// unexplained content words are penalised.
//
// Deliberately NOT applied to findCandidateRates: those descriptions are full
// BESMM sentences where unmatched content words are normal, not a signal.
const PACKAGING_TOKENS = new Set([
  "bag", "bags", "box", "boxes", "roll", "rolls", "pkt", "packet", "pack",
  "tin", "tins", "drum", "gallon", "sachet", "carton", "bundle", "sheet",
  "sheets", "piece", "pieces", "pair", "set", "length", "lengths", "each",
  "litre", "litres", "ltr", "kg", "tonne", "tonnes", "ton", "no", "nos",
  "ea", "unit", "units", "thick", "dia", "size", "sizes",
]);

// A token that qualifies rather than redefines: a number, a number with a
// unit suffix (50kg, 12mm, 180hp, 1m), or a packaging/measure word.
function isQualifierToken(t) {
  return /^\d/.test(t) || PACKAGING_TOKENS.has(t);
}

const squash = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

// Coverage of the QUERY, tolerant of compound splits: "waterproof" matches a
// candidate written "Water proof". Without this, tightening the score below
// would have broken "Waterproof membrane", which is a genuine match.
function coverageScore(queryTokens, candidateName) {
  const hay = String(candidateName || "").toLowerCase();
  const flat = squash(candidateName);
  let hits = 0;
  for (const t of queryTokens) {
    if (/^\d+$/.test(t)) {
      // Numbers must stand alone: "25" is not a match inside "125mm".
      if (new RegExp(`(?<!\\d)${t}(?!\\d)`).test(hay)) hits += 1;
      continue;
    }
    if (hay.includes(t) || (t.length >= 5 && flat.includes(t))) {
      hits += 1;
      continue;
    }
    // A dimension also matches the same dimension written without its unit,
    // so "Blocks 150mm" finds "150 x 225 x 450mm … Hollow blocks". Without
    // this the correct 150mm row scores no better than the 100mm one.
    const dim = /^(\d+)(?:mm|cm|m|kg|g|ltr|litre|l|in|inch)$/.exec(t);
    if (dim && new RegExp(`(?<!\\d)${dim[1]}(?!\\d)`).test(hay)) hits += 1;
  }
  return queryTokens.length ? hits / queryTokens.length : 0;
}

// Content words in the candidate the query never mentioned. Each is evidence
// the candidate is a DIFFERENT product. A candidate word also counts as
// explained when it is part of a compound the query used ("proof" inside
// "waterproof"), so a split spelling is not punished as a mismatch.
function unexplainedContent(queryTokens, candidateName) {
  const q = new Set(queryTokens);
  const flatQuery = queryTokens.filter((t) => t.length >= 5).join("|");
  let n = 0;
  for (const t of tokenize(candidateName)) {
    if (q.has(t) || isQualifierToken(t)) continue;
    if (t.length >= 4 && flatQuery.includes(t)) continue;
    n += 1;
  }
  return n;
}

// 0.25 per unexplained content word, calibrated on the real library:
//   "water"      vs "Water proof membrane - Bitulene"  1.00 - 3x.25 = 0.25  REJECTED
//   "waterproof membrane" vs the same row              1.00 - 1x.25 = 0.75  matches
//   "cement"     vs "Cement (50kg bag)"                1.00 - 0     = 1.00  wins
//   "cement"     vs "Coloured Cement"                  1.00 - 1x.25 = 0.75
//   "cement"     vs "Loading and unloading cement"     1.00 - 2x.25 = 0.50
//   "white cement" vs "White Cement"                   1.00 - 0     = 1.00  wins
//   "nails"      vs "Nails 1 1/2\""                    1.00 - 0     = 1.00  wins
//   "nails"      vs "Drive Screws/Roofing Nails"       1.00 - 3x.25 = 0.25  REJECTED
// A size-less "sandcrete blocks" now falls below the 0.3 floor rather than
// silently picking the 100mm row out of three sizes — the caller's fallback is
// the model's own price, honestly labelled "model", which beats a coin flip.
const CONTENT_PENALTY = 0.25;

function nameScore(queryTokens, candidateName) {
  return Math.max(
    0,
    coverageScore(queryTokens, candidateName) -
      CONTENT_PENALTY * unexplainedContent(queryTokens, candidateName),
  );
}

// Short tokens are usually noise ("in", "to", "of") EXCEPT numbers, which are
// the most discriminating part of a QS description: grade 10 vs grade 25,
// 1:4:8 vs 1:2:4, 12mm vs 20mm. Dropping them made "Grade 25 concrete in
// foundation" score a perfect 1.0 against "Concrete (1:4:8) grade 10 in
// foundation or slab" — a wrong build-up served as a library match. Numbers of
// any length are kept.
function tokenize(description) {
  return String(description || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 2 || /^\d+$/.test(t));
}

function scoreMatch(tokens, text) {
  const hay = String(text || "").toLowerCase();
  let hits = 0;
  for (const t of tokens) {
    if (/^\d+$/.test(t)) {
      // A number must stand alone, so "25" does not count as found inside
      // "125mm" or "1:2:5". Digit-boundary, not \b, because \b would still
      // let "25" match the "25" in "125".
      if (new RegExp(`(?<!\\d)${t}(?!\\d)`).test(hay)) hits++;
    } else if (hay.includes(t)) {
      hits++;
    }
  }
  return tokens.length ? hits / tokens.length : 0;
}

// ── Library version (cache-busting + audit stamps) ──────────────────────────
// Derived from the admin cluster's price freshness, so a price update busts
// every cached verdict automatically. Cached for 10 minutes.
let versionCache = null;
let versionAt = 0;

export async function libraryVersion() {
  if (versionCache && Date.now() - versionAt < 10 * 60 * 1000) return versionCache;
  try {
    const db = await rategenMasterDb();
    const [agg] = await db
      .collection(config.rategenMatCollection)
      .aggregate([
        { $group: { _id: null, n: { $sum: 1 }, latest: { $max: "$updatedAt" } } },
      ])
      .toArray();
    const latest = agg?.latest ? new Date(agg.latest).toISOString().slice(0, 19) : "static";
    versionCache = `admin:${agg?.n ?? 0}:${latest}`;
    versionAt = Date.now();
    return versionCache;
  } catch (err) {
    console.error("[rateLibrary] version lookup failed:", err.message);
    return "unversioned";
  }
}

// ── Candidate master rates (grounding for build-ups and BoQ benchmarks) ─────
// Searches every trade's *_items collection; each doc is a full build-up:
// Description, Unit, NetCost, OverheadValue, ProfitValue, TotalCost, and a
// breakdown array (field name varies per trade: BreakdownLines,
// BlockworkBreakdownLine, ...).
// ── In-process library cache ────────────────────────────────────────────────
// The whole build-up library is 130 documents / 0.19 MB across 8 collections,
// yet it was re-queried per lookup: 8 Atlas round-trips (~1.1s) for every
// build-up, and boqCheck calls this ONCE PER BILL LINE — 12 lines cost ~12.8s
// of pure database latency before a single token was spent. It is far smaller
// than the queries used to fetch it, so load it once and score in memory.
//
// Lambda containers persist between invocations, so warm calls pay nothing.
// The TTL matches libraryVersion()'s, so a price edit is picked up on the same
// cadence the cache keys already assume.
const LIB_TTL_MS = 10 * 60 * 1000;
let itemsCache = null;
let itemsAt = 0;

async function loadItems() {
  if (itemsCache && Date.now() - itemsAt < LIB_TTL_MS) return itemsCache;
  const db = await rategenMasterDb();
  const all = [];
  for (const coll of ITEM_COLLECTIONS) {
    try {
      const rows = await db.collection(coll).find({}).toArray();
      for (const r of rows) all.push({ row: r, coll });
    } catch {
      // A missing trade collection must not take the whole library down.
      continue;
    }
  }
  // Only replace a good cache with a non-empty read, so a transient failure
  // degrades to slightly stale data rather than to no grounding at all.
  if (all.length || !itemsCache) {
    itemsCache = all;
    itemsAt = Date.now();
  }
  return itemsCache;
}

export async function findCandidateRates(description, { limit = 8 } = {}) {
  const tokens = tokenize(description);
  if (!tokens.length) return [];

  // Same prefilter and per-collection cap as the queries this replaces (first
  // 6 tokens OR'd, 40 rows per collection in natural order), then the same
  // score and stable sort — so results are unchanged and only the round trips
  // are gone.
  const probes = tokens.slice(0, 6);
  const scored = [];
  let currentColl = null;
  let taken = 0;
  for (const { row, coll } of await loadItems()) {
    if (coll !== currentColl) {
      currentColl = coll;
      taken = 0;
    }
    if (taken >= 40) continue;
    const hay = String(row.Description || "").toLowerCase();
    if (!probes.some((t) => hay.includes(t))) continue;
    taken += 1;
    scored.push({ row, coll, score: scoreMatch(tokens, row.Description) });
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map(({ row, coll, score }) => {
      const net = Number(row.NetCost) || 0;
      const breakdownField = Object.keys(row).find(
        (k) => Array.isArray(row[k]) && row[k].length && row[k][0] && row[k][0].ComponentName !== undefined
      );
      const lines = breakdownField ? row[breakdownField] : [];
      return {
        code: String(row.ItemNo ?? ""),
        section: coll.replace(/_items$/, ""),
        description: row.Description,
        unit: row.Unit,
        netCost: net,
        totalCost: Number(row.TotalCost) || 0,
        overheadPercent: net > 0 ? Math.round(((Number(row.OverheadValue) || 0) / net) * 100) : 10,
        profitPercent: net > 0 ? Math.round(((Number(row.ProfitValue) || 0) / net) * 100) : 25,
        breakdown: lines.map((b) => ({
          componentName: b.ComponentName,
          quantity: Number(b.Quantity) || 0,
          unit: b.Unit || "",
          unitPrice: Number(b.UnitPrice) || 0,
          totalPrice: Number(b.TotalPrice) || 0,
          refKind: LABOUR_HINTS.test(String(b.ComponentName || "")) ? "labour" : "material",
        })),
        matchScore: Number(score.toFixed(2)),
      };
    });
}

// Build-up recipes lived in the (empty) web-cluster collection; the admin
// items above supersede them. Kept for API compatibility.
export async function findComputeItems() {
  return [];
}

// ── Zone-aware master price lookups ─────────────────────────────────────────
// Materials/labours carry a `zone` field (six Nigerian zones). Zone-matched
// prices win; rows without a matching zone are the fallback.
// Price lists are cached in memory (Materials 2,874 docs / 781 KB, labours
// 414 / 94 KB) — a 10-minute TTL per container, as for the build-up library.
//
// This was held back earlier because caching changed which price came out. It
// is safe now for two reasons: the score below actually discriminates between
// candidates instead of tying at 1.0, and the sort is a TOTAL deterministic
// order, so no result depends on the order rows arrive in.
//
// Caching also removes the `.limit(30)` that used to truncate the candidate
// set BEFORE scoring — which was its own correctness bug. "White cement"
// returned "Aliphatic Polyurethane (Amercoat…)" and "Coloured cement" returned
// a roofing sheet, not because the score preferred them but because the real
// row was never among the 30 rows fetched. Every row is now scored.
const priceCache = new Map(); // collection -> { rows, at }

async function loadPrices(coll) {
  const hit = priceCache.get(coll);
  if (hit && Date.now() - hit.at < LIB_TTL_MS) return hit.rows;
  const db = await rategenMasterDb();
  let rows = [];
  try {
    // Only the four fields this module reads — the full documents carry a lot
    // of admin metadata, and the projection roughly halves the cold load.
    rows = await db
      .collection(coll)
      .find(
        {},
        {
          projection: {
            _id: 0,
            zone: 1,
            MaterialName: 1,
            MaterialUnit: 1,
            MaterialPrice: 1,
            LabourName: 1,
            LabourUnit: 1,
            LabourPrice: 1,
          },
        },
      )
      .toArray();
  } catch {
    return hit?.rows || [];
  }
  // Never replace a good cache with an empty read.
  if (rows.length || !hit) priceCache.set(coll, { rows, at: Date.now() });
  return priceCache.get(coll).rows;
}

export async function findPrices(names, kind = "material", zone = null, minScore = 0.3) {
  const coll = kind === "labour" ? config.rategenLabCollection : config.rategenMatCollection;
  const nameField = kind === "labour" ? "LabourName" : "MaterialName";
  const unitField = kind === "labour" ? "LabourUnit" : "MaterialUnit";
  const priceField = kind === "labour" ? "LabourPrice" : "MaterialPrice";
  const normZone = NIGERIAN_ZONES.includes(zone) ? zone : null;

  const all = await loadPrices(coll);
  // Same zone rule as before: zone-matched rows and rows carrying no zone are
  // eligible; the +0.25 below lets a zone match win a tie.
  const rows = normZone
    ? all.filter((r) => r.zone === normZone || r.zone === undefined)
    : all;

  const results = [];
  for (const name of (names || []).slice(0, 20)) {
    const tokens = tokenize(name);
    if (!tokens.length) continue;
    // Total, deterministic ordering — no result may depend on the order rows
    // came back in:
    //   1. name score (coverage minus unexplained content), + zone bonus
    //   2. a real price beats a 0 placeholder (many zone rows are unpriced)
    //   3. the shorter name, i.e. the least-qualified variant
    //   4. name A-Z, purely to make ties total
    const scored = rows
      .map((r) => ({
        row: r,
        score: nameScore(tokens, r[nameField]) + (normZone && r.zone === normZone ? 0.25 : 0),
        priced: (Number(r[priceField]) || 0) > 0 ? 1 : 0,
        len: tokenize(r[nameField]).length,
        label: String(r[nameField] || ""),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.priced - a.priced ||
          a.len - b.len ||
          a.label.localeCompare(b.label),
      );
    if (scored.length && scored[0].score >= minScore) {
      const r = scored[0].row;
      results.push({
        query: name,
        name: r[nameField],
        unit: r[unitField],
        priceNgn: Number(r[priceField]) || 0,
        zone: r.zone || null,
      });
    }
  }
  return results;
}
