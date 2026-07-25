import { timingSafeEqual } from "node:crypto";
import { config } from "../config/index.js";

export function requireAdminKey(req, res, next) {
  const provided = String(req.headers["x-admin-key"] || "");
  const expected = config.adminApiKey;
  if (!expected) {
    return res.status(503).json({ error: "Admin API not configured", code: "ADMIN_DISABLED" });
  }
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return res.status(403).json({ error: "Forbidden", code: "BAD_ADMIN_KEY" });
  }
  next();
}
