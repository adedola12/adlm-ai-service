import { PricingRate } from "../models/index.js";
import { config } from "../config/index.js";

// In-memory pricing snapshot, refreshed every 5 minutes. Cost is ALWAYS
// computed from the PricingRate store — never hardcoded.
let snapshot = new Map();
let loadedAt = 0;
const TTL_MS = 5 * 60 * 1000;

function key(service, model, unit) {
  return `${service}|${model}|${unit}`;
}

export async function loadPricing(force = false) {
  if (!force && Date.now() - loadedAt < TTL_MS && snapshot.size) return snapshot;
  const rows = await PricingRate.find({}).lean();
  snapshot = new Map(rows.map((r) => [key(r.service, r.model, r.unit), r.priceUsd]));
  loadedAt = Date.now();
  return snapshot;
}

export async function costUsd({ service, model, units }) {
  const prices = await loadPricing();
  let usd = 0;
  const missing = [];
  const add = (unit, qty, divisor = 1) => {
    if (!qty) return;
    const p = prices.get(key(service, model, unit));
    if (p === undefined) missing.push(unit);
    else usd += (qty / divisor) * p;
  };
  add("input_mtok", units.inputTokens || 0, 1_000_000);
  add("output_mtok", units.outputTokens || 0, 1_000_000);
  add("page", units.pages || 0, 1);
  if (missing.length) {
    // A missing price must be loud, not silently free.
    console.error(`[pricing] no PricingRate for ${service}/${model} units=${missing.join(",")}`);
  }
  return usd;
}

export function toNgn(usd) {
  return usd * config.usdNgnRate;
}
