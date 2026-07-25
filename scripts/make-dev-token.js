// Mints a dev licence token (HS256, same shape ADLM Cloud issues to plugins)
// so the SDK / HTTP API can be tested without going through a full login.
// Requires JWT_LICENSE_SECRET in .env — the same value ADLM Cloud uses.
//
//   node scripts/make-dev-token.js [tenantId] [days]
import "dotenv/config";
import { SignJWT } from "jose";
import { config } from "../src/config/index.js";

if (!config.jwtLicenseSecret) {
  console.error("JWT_LICENSE_SECRET is not set in .env — copy it from ADLM Cloud's env.");
  process.exit(1);
}

const tenantId = process.argv[2] || "dev-tenant";
const days = Number(process.argv[3]) || 30;

const token = await new SignJWT({
  ver: 1,
  email: "dev@adlm.local",
  productKey: "rategen",
  entitlements: [
    { productKey: config.aiEntitlementKey, status: "active", expiresAt: new Date(Date.now() + days * 86400000).toISOString() },
    { productKey: "rategen", status: "active" },
  ],
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuer("adlm")
  .setAudience("adlm-plugin")
  .setSubject(tenantId)
  .setIssuedAt()
  .setExpirationTime(`${days}d`)
  .sign(new TextEncoder().encode(config.jwtLicenseSecret));

console.log(token);
