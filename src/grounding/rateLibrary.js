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

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

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
// NOT cached in memory, deliberately. The price lists are small enough to
// cache (Materials 2,874 docs / 781 KB), and doing so cut this from ~1.3s to
// ~3ms — but it also CHANGED WHICH PRICE IS RETURNED. Candidate names tie
// constantly ("cement" scores a perfect 1.0 against "Cement (50kg bag)",
// "Coloured Cement" and "Loading and unloading cement" alike, and each
// material repeats across six zones), so the winner was only ever decided by
// the order MongoDB happened to return rows in. Any reimplementation reshuffles
// that, and a silently different unit rate is a worse outcome than a slower
// one. The ~1.3s stays until the matching itself is fixed — see the note in
// findCandidateRates; the tie-breaking needs to be made deliberate (exact/
// prefix name match, non-zero price, explicit zone) before this can be a pure
// performance change.
export async function findPrices(names, kind = "material", zone = null, minScore = 0.3) {
  const db = await rategenMasterDb();
  const coll = kind === "labour" ? config.rategenLabCollection : config.rategenMatCollection;
  const nameField = kind === "labour" ? "LabourName" : "MaterialName";
  const unitField = kind === "labour" ? "LabourUnit" : "MaterialUnit";
  const priceField = kind === "labour" ? "LabourPrice" : "MaterialPrice";
  const normZone = NIGERIAN_ZONES.includes(zone) ? zone : null;

  const results = [];
  for (const name of (names || []).slice(0, 20)) {
    const tokens = tokenize(name);
    if (!tokens.length) continue;
    const or = tokens.slice(0, 4).map((t) => ({ [nameField]: { $regex: escapeRegex(t), $options: "i" } }));
    const filter = normZone ? { $and: [{ $or: or }, { $or: [{ zone: normZone }, { zone: { $exists: false } }] }] } : { $or: or };
    let rows = [];
    try {
      rows = await db.collection(coll).find(filter).limit(30).toArray();
    } catch {
      continue;
    }
    const scored = rows
      .map((r) => ({
        row: r,
        score: scoreMatch(tokens, r[nameField]) + (normZone && r.zone === normZone ? 0.25 : 0),
      }))
      .sort((a, b) => b.score - a.score);
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
