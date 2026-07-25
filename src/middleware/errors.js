export class QuotaExceededError extends Error {
  constructor(quota) {
    super("Monthly AI quota reached");
    this.code = "QUOTA_REACHED";
    this.status = 200; // clean, non-error response by design — plugins show a friendly message
    this.quota = quota;
  }
}

export class ThrottledError extends Error {
  constructor(feature) {
    super(`Feature '${feature}' temporarily throttled by the platform credit guard`);
    this.code = "CREDIT_THROTTLED";
    this.status = 503;
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof QuotaExceededError) {
    return res.status(200).json({
      ok: false,
      code: err.code,
      message: err.message,
      quota: err.quota,
    });
  }
  if (err instanceof ThrottledError) {
    return res.status(503).json({ ok: false, code: err.code, message: err.message });
  }
  console.error("[adlm-ai] unhandled error:", err);
  return res.status(500).json({ ok: false, code: "INTERNAL", message: "Internal error" });
}
