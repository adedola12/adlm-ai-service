import { createRemoteJWKSet, jwtVerify } from "jose";
import { config } from "../config/index.js";

// Entitlement verification without touching ADLM Cloud's database.
// Two accepted credentials, tried in order:
//   1. Licence JWT (plugins get this from POST /auth/login on ADLM Cloud).
//      Verified locally — RS256 via ADLM Cloud's JWKS, or HS256 via the
//      shared JWT_LICENSE_SECRET. Carries the user's entitlements array.
//   2. Access JWT (web clients). Verified via JWT_ACCESS_SECRET, then the
//      entitlement list is fetched from ADLM Cloud's API with a short TTL
//      cache — an API boundary, never a DB join.

const enc = new TextEncoder();
let jwks = null;
function getJwks() {
  if (!jwks && config.adlmCloudUrl) {
    jwks = createRemoteJWKSet(new URL(`${config.adlmCloudUrl}/.well-known/jwks.json`), {
      cooldownDuration: 60000,
    });
  }
  return jwks;
}

async function verifyLicenseToken(token) {
  const opts = { issuer: "adlm", audience: "adlm-plugin" };
  if (config.jwtLicenseSecret) {
    try {
      const { payload } = await jwtVerify(token, enc.encode(config.jwtLicenseSecret), opts);
      return payload;
    } catch {
      /* fall through to RS256 */
    }
  }
  const keySet = getJwks();
  if (keySet) {
    const { payload } = await jwtVerify(token, keySet, opts);
    return payload;
  }
  throw new Error("no licence verification path configured");
}

async function verifyAccessToken(token) {
  if (!config.jwtAccessSecret) throw new Error("access-token path not configured");
  const { payload } = await jwtVerify(token, enc.encode(config.jwtAccessSecret));
  return payload;
}

// Short-TTL entitlement cache for the web path: userId -> {entitlements, at}
const entCache = new Map();
const ENT_TTL_MS = 5 * 60 * 1000;

async function fetchEntitlements(accessToken, userId) {
  const cached = entCache.get(userId);
  if (cached && Date.now() - cached.at < ENT_TTL_MS) return cached.entitlements;
  const res = await fetch(`${config.adlmCloudUrl}/api/entitlements`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`entitlement fetch failed (${res.status})`);
  const body = await res.json();
  const entitlements = body.entitlements || [];
  entCache.set(userId, { entitlements, at: Date.now() });
  return entitlements;
}

function hasActiveAi(entitlements) {
  const key = config.aiEntitlementKey;
  return (entitlements || []).some(
    (e) =>
      String(e.productKey || "").toLowerCase() === key &&
      e.status === "active" &&
      (!e.expiresAt || new Date(e.expiresAt) > new Date())
  );
}

export async function requireAiEntitlement(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      return res.status(401).json({ error: "Missing bearer token", code: "NO_TOKEN" });
    }

    let payload = null;
    let entitlements = null;

    try {
      payload = await verifyLicenseToken(token);
      entitlements = payload.entitlements || [];
    } catch {
      // Not a licence token — try the web access-token path.
      payload = await verifyAccessToken(token);
      entitlements = await fetchEntitlements(token, String(payload._id || payload.sub || ""));
    }

    if (!hasActiveAi(entitlements)) {
      return res.status(403).json({
        error: "AI add-on not active for this account",
        code: "AI_NOT_ENTITLED",
      });
    }

    req.tenantId = String(payload.sub || payload._id || "");
    req.tenantEmail = payload.email || "";
    req.product = String(req.headers["x-adlm-product"] || "unknown").toLowerCase();
    if (!req.tenantId) {
      return res.status(401).json({ error: "Token has no subject", code: "BAD_TOKEN" });
    }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid or expired token", code: "BAD_TOKEN", detail: err.message });
  }
}
