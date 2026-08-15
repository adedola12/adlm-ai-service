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

// The provider refused the call itself — Bedrock model access not granted in
// this account, or a model id that is not enabled in the region. Distinct from
// a bug: nothing in the request is wrong and no retry will help until someone
// grants access in the Bedrock console. Surfaced as its own code so it does not
// hide inside a generic 500 and get chased as an application fault.
// NOTE: this message reaches END USERS verbatim — the SDK prefers the server's
// wording over its own, and plugins print it straight into the assistant log. Keep
// it in plain language and do not name env vars: the AI_PROVIDER fallback it used
// to suggest is inert now that all AI runs on Bedrock, and a quantity surveyor
// cannot act on it anyway.
export class ModelUnavailableError extends Error {
  constructor(modelId, detail) {
    super(
      "AI is not switched on for this account yet — the model access request is still pending. " +
        "Everything else in the plugin works normally. Contact ADLM Studio if this persists."
    );
    this.modelId = modelId;
    this.code = "MODEL_UNAVAILABLE";
    this.status = 503;
    this.detail = detail;
  }
}

// eslint-disable-next-line no-unused-vars
export function errorHandler(err, req, res, next) {
  if (err instanceof ModelUnavailableError) {
    // Log the model id separately — err.message is now the user-facing text, so
    // without this CloudWatch would no longer say WHICH model was refused.
    console.error(
      "[adlm-ai] model unavailable:",
      err.modelId || "(unknown model)",
      err.detail || ""
    );
    return res.status(503).json({ ok: false, code: err.code, message: err.message });
  }
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
