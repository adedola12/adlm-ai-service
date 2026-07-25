import { createHash } from "node:crypto";
import { CacheEntry } from "../models/index.js";
import { config } from "../config/index.js";

// Deterministic stringify (sorted keys) so semantically-identical inputs hash
// identically regardless of key order.
function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(",")}}`;
}

// The RateGen library version and prompt version are part of every cache key,
// so a library update or prompt change busts the cache automatically —
// no manual invalidation step to forget.
export function cacheKey({ feature, input, dataVersion }) {
  const raw = stableStringify({ feature, input, dataVersion, promptVersion: config.promptVersion });
  return createHash("sha256").update(raw).digest("hex");
}

export async function cacheGet(inputHash) {
  const entry = await CacheEntry.findOne({ inputHash, expiresAt: { $gt: new Date() } }).lean();
  return entry ? { result: entry.result, model: entry.model } : null;
}

export async function cacheSet({ inputHash, feature, result, model }) {
  const expiresAt = new Date(Date.now() + config.cacheTtlSeconds * 1000);
  try {
    await CacheEntry.updateOne(
      { inputHash },
      { $set: { feature, result, model, expiresAt, createdAt: new Date() } },
      { upsert: true }
    );
  } catch (err) {
    console.error("[cache] set failed:", err.message);
  }
}
