// Provider selection, the fallback latch, and the failure taxonomy.
//
// These are the parts of the Bedrock migration that fail SILENTLY when they
// are wrong: a mis-classified error either strands the service on a provider
// that refuses every call, or burns cash on the direct API when Bedrock was
// merely rate-limiting. Neither shows up as a crash — the last two AI outages
// were both this shape — so they get tests even though nothing else here does.
//
// Run with `npm test`, which scopes discovery to *.test.js — a bare
// `node --test` also picks up scripts/test-*.js, which are CLI tools.
import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";

process.env.MONGO_URI ||= "mongodb://127.0.0.1:27017/test";

const { config } = await import("../config/index.js");
const { activeProvider, _markBedrockBlocked, _resetProviderLatch, _isModelAccessError } =
  await import("./bedrock.js");
const { classifyFailure, providerHealthSnapshot, recordProviderFailure, recordProviderSuccess, recordProviderFallback, _resetProviderHealth } =
  await import("../governance/providerHealth.js");

const defaults = { ...config };

beforeEach(() => {
  Object.assign(config, defaults);
  _resetProviderLatch();
  _resetProviderHealth();
});

/* ─────────────────────────── provider selection ─────────────────────────── */

test("defaults to bedrock so spend lands on the AWS credit", () => {
  config.aiProvider = "bedrock";
  assert.equal(activeProvider(), "bedrock");
});

test("AI_PROVIDER=anthropic pins every call to the direct API", () => {
  config.aiProvider = "anthropic";
  assert.equal(activeProvider(), "anthropic");
});

test("a refusal moves serving to the direct API for the retry window", () => {
  config.aiProvider = "bedrock";
  config.anthropicApiKey = "sk-test";
  _markBedrockBlocked();
  assert.equal(activeProvider(), "anthropic");
});

test("the latch expires so spend returns to Bedrock once the grant lands", () => {
  config.aiProvider = "bedrock";
  config.anthropicApiKey = "sk-test";
  _markBedrockBlocked(-1); // a window that has already closed
  assert.equal(activeProvider(), "bedrock");
});

test("with no fallback key configured we stay on Bedrock and fail loudly", () => {
  // The alternative — silently latching to a provider we cannot call — would
  // turn a fixable 503 into a confusing one.
  config.aiProvider = "bedrock";
  config.anthropicApiKey = "";
  _markBedrockBlocked();
  assert.equal(activeProvider(), "bedrock");
});

test("AI_PROVIDER_FALLBACK=false keeps a refusal on Bedrock", () => {
  config.aiProvider = "bedrock";
  config.anthropicApiKey = "sk-test";
  config.aiProviderFallback = false;
  _markBedrockBlocked();
  assert.equal(activeProvider(), "bedrock");
});

/* ─────────────────────────── access-error taxonomy ───────────────────────── */

test("Bedrock's two ways of saying 'you cannot call this model' both count", () => {
  assert.ok(_isModelAccessError({ name: "AccessDeniedException", message: "..." }));
  assert.ok(_isModelAccessError({ name: "ValidationException", message: "..." }));
  assert.ok(_isModelAccessError({ status: 403, message: "..." }));
  assert.ok(
    _isModelAccessError({ message: "You don't have access to the model with the specified model ID." }),
  );
});

test("throttling and outages are NOT access errors — falling back would waste cash", () => {
  assert.equal(_isModelAccessError({ name: "ThrottlingException", status: 429 }), false);
  assert.equal(_isModelAccessError({ name: "ServiceUnavailable", status: 503 }), false);
  assert.equal(_isModelAccessError({ message: "read ECONNRESET" }), false);
});

/* ─────────────────────────── failure classification ──────────────────────── */

test("each failure kind maps to the action that actually fixes it", () => {
  assert.equal(classifyFailure({ code: "MODEL_UNAVAILABLE" }), "model_access");
  assert.equal(classifyFailure({ name: "AccessDeniedException" }), "model_access");
  assert.equal(
    classifyFailure({ status: 400, message: "Your credit balance is too low to access the API" }),
    "billing",
  );
  assert.equal(classifyFailure({ status: 401, message: "invalid x-api-key" }), "credentials");
  assert.equal(classifyFailure({ status: 429, message: "Too many requests" }), "rate_limited");
  assert.equal(classifyFailure({ name: "AbortError", message: "aborted" }), "timeout");
  assert.equal(classifyFailure({ status: 529, message: "Overloaded" }), "provider_error");
});

test("billing is judged before credentials — a spent balance 400s, it is not a bad key", () => {
  // Anthropic returns the credit-balance message on a 400 with a valid key.
  // Reading it as "credentials" sends the operator to rotate a key that is fine.
  assert.equal(
    classifyFailure({ status: 400, message: "Your credit balance is too low" }),
    "billing",
  );
});

/* ─────────────────────────── health snapshot ─────────────────────────────── */

test("a container that has served nothing says unknown, not healthy", () => {
  // Reporting "healthy" before any evidence is exactly what made the 14 Aug
  // outage invisible from outside.
  assert.equal(providerHealthSnapshot().status, "unknown");
});

test("a success clears the failure streak", () => {
  recordProviderFailure("bedrock", { code: "MODEL_UNAVAILABLE" });
  recordProviderSuccess("anthropic");
  const snap = providerHealthSnapshot();
  assert.equal(snap.status, "healthy");
  assert.equal(snap.consecutiveFailures, 0);
  assert.equal(snap.servingProvider, "anthropic");
});

test("failures carry a kind and a hint, and the raw message only for admins", () => {
  recordProviderFailure("bedrock", {
    code: "MODEL_UNAVAILABLE",
    message: "Model 'anthropic.claude-haiku-4-5' is not available to account 1234",
  });

  const publicView = providerHealthSnapshot();
  assert.equal(publicView.status, "failing");
  assert.equal(publicView.lastFailure.kind, "model_access");
  assert.match(publicView.lastFailure.hint, /Bedrock console/);
  assert.equal(publicView.lastFailure.message, undefined, "account ids must not leak publicly");

  const adminView = providerHealthSnapshot({ includeMessage: true });
  assert.match(adminView.lastFailure.message, /not available to account/);
});

test("a fallback is recorded so the bill has an explanation", () => {
  recordProviderFailure("bedrock", { code: "MODEL_UNAVAILABLE" });
  recordProviderFallback("bedrock", "anthropic");
  const snap = providerHealthSnapshot();
  assert.equal(snap.fellBack.from, "bedrock");
  assert.equal(snap.fellBack.to, "anthropic");
});
