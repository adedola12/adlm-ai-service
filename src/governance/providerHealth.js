// Provider health for the model transport.
//
// WHY THIS EXISTS: on 14 Aug 2026 QUIV's AI assistant showed "AI service is
// unreachable" for every prompt. The C# SDK retries 5xx twice and then degrades
// with that one sentence, so a 503 MODEL_UNAVAILABLE and a 500 from a dead
// Mongo look identical from inside Revit — and nothing on this side answered
// the question either, because /health only ever said `ok: true`.
//
// This module records the outcome of every model call so /health/ai can say
// WHICH half is broken without anyone opening CloudWatch. It is deliberately
// dependency-free and in-memory: it must answer even when the database is the
// thing that is down, and a Lambda container that has served no calls yet
// honestly reports "unknown" rather than inventing a verdict.

const MAX_MESSAGE = 300;

const state = {
  lastOkAt: null,
  lastFailAt: null,
  lastProvider: "",
  lastFailProvider: "",
  lastFailKind: "",
  lastFailMessage: "",
  consecutiveFailures: 0,
  fellBackAt: null,
  fellBackFrom: "",
};

/**
 * Classify a transport failure into something an operator can act on. The
 * kinds map to distinct fixes, which is the whole point of separating them:
 *   model_access   → grant the model in the Bedrock console (an AWS action)
 *   credentials    → the IAM role or the API key is wrong (a config action)
 *   billing        → the Anthropic balance is spent (a payment action)
 *   rate_limited   → back off; nothing to fix
 *   timeout        → cold start or a slow model call; retry
 *   provider_error → the provider is down; wait
 */
export function classifyFailure(err) {
  const name = String(err?.name || "");
  const status = Number(err?.status || err?.statusCode || 0);
  const text = String(err?.message || err || "").toLowerCase();

  if (err?.code === "MODEL_UNAVAILABLE") return "model_access";
  if (name === "AccessDeniedException" || name === "ValidationException") return "model_access";
  if (/credit balance|billing|payment|quota exceeded for your plan/.test(text)) return "billing";
  if (status === 401 || /invalid x-api-key|authentication|unrecognizedclient|security token/.test(text))
    return "credentials";
  if (status === 429 || /throttl|rate limit|too many requests/.test(text)) return "rate_limited";
  if (name === "AbortError" || /timeout|timed out|etimedout/.test(text)) return "timeout";
  if (status >= 500 || /overloaded|service unavailable/.test(text)) return "provider_error";
  return "unknown";
}

const HINTS = {
  model_access:
    "The account cannot invoke this model. Grant Anthropic model access in the Bedrock console for this region, or set AI_PROVIDER=anthropic to fall back.",
  credentials:
    "The provider rejected our credentials — check the Lambda's IAM role (Bedrock) or ANTHROPIC_API_KEY (direct API).",
  billing:
    "The provider refused on billing grounds — top up the Anthropic balance, or move to Bedrock so spend lands on the AWS credit.",
  rate_limited: "The provider is throttling us. Retry shortly; no configuration change will help.",
  timeout: "The model call did not answer in time — usually a cold start or an unusually long generation.",
  provider_error: "The provider returned a server error. Retry shortly.",
  unknown: "Unclassified transport failure — read the message and the CloudWatch log.",
};

export function recordProviderSuccess(provider) {
  state.lastOkAt = new Date().toISOString();
  state.lastProvider = provider;
  state.consecutiveFailures = 0;
}

export function recordProviderFailure(provider, err) {
  state.lastFailAt = new Date().toISOString();
  state.lastFailProvider = provider;
  state.lastFailKind = classifyFailure(err);
  state.lastFailMessage = String(err?.message || err || "").slice(0, MAX_MESSAGE);
  state.consecutiveFailures += 1;
}

export function recordProviderFallback(from, to) {
  state.fellBackAt = new Date().toISOString();
  state.fellBackFrom = from;
  state.lastProvider = to;
}

/**
 * @param {{includeMessage?: boolean}} opts includeMessage is for admins only —
 *   the provider's own words can name models, regions and account details, and
 *   /health is public so plugins can warm the Lambda without a token.
 */
export function providerHealthSnapshot({ includeMessage = false } = {}) {
  // No call has been made yet in this container. "unknown" is the honest
  // answer: a fresh Lambda has no evidence either way, and reporting "healthy"
  // here is exactly the lie that made the last outage hard to see.
  const status = !state.lastOkAt && !state.lastFailAt
    ? "unknown"
    : state.consecutiveFailures === 0
      ? "healthy"
      : "failing";

  return {
    status,
    servingProvider: state.lastProvider || null,
    lastOkAt: state.lastOkAt,
    lastFailAt: state.lastFailAt,
    consecutiveFailures: state.consecutiveFailures,
    ...(state.lastFailKind
      ? {
          lastFailure: {
            provider: state.lastFailProvider,
            kind: state.lastFailKind,
            hint: HINTS[state.lastFailKind] || HINTS.unknown,
            ...(includeMessage ? { message: state.lastFailMessage } : {}),
          },
        }
      : {}),
    ...(state.fellBackAt
      ? { fellBack: { at: state.fellBackAt, from: state.fellBackFrom, to: state.lastProvider } }
      : {}),
  };
}

// Tests and local scripts only.
export function _resetProviderHealth() {
  Object.assign(state, {
    lastOkAt: null,
    lastFailAt: null,
    lastProvider: "",
    lastFailProvider: "",
    lastFailKind: "",
    lastFailMessage: "",
    consecutiveFailures: 0,
    fellBackAt: null,
    fellBackFrom: "",
  });
}
