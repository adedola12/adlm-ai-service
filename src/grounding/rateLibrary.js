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
export async function findCandidateRates(description, { limit = 8 } = {}) {
  const tokens = tokenize(description);
  if (!tokens.length) return [];
  const db = await rategenMasterDb();
  const or = tokens.slice(0, 6).map((t) => ({ Description: { $regex: escapeRegex(t), $options: "i" } }));

  const scored = [];
  for (const coll of ITEM_COLLECTIONS) {
    let rows = [];
    try {
      rows = await db.collection(coll).find({ $or: or }).limit(40).toArray();
    } catch {
      continue;
    }
    for (const r of rows) {
      scored.push({ row: r, coll, score: scoreMatch(tokens, r.Description) });
    }
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
export async function findPrices(names, kind = "material", zone = null) {
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
    if (scored.length && scored[0].score > 0.3) {
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
