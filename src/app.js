import express from "express";
import { connectAiDb } from "./db/connect.js";
import { assertConfig, config } from "./config/index.js";
import { activeProvider } from "./clients/bedrock.js";
import { providerHealthSnapshot } from "./governance/providerHealth.js";
import aiRoutes from "./routes/ai.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { errorHandler } from "./middleware/errors.js";

export function createApp() {
  assertConfig();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" })); // catalogue pages arrive base64-encoded

  // Health probes are mounted BEFORE the DB guard on purpose. They were behind
  // it, which meant an unreachable Atlas cluster made the health endpoint fail
  // too — the one moment you most need it to answer. The plugins' warm-up ping
  // hits /health, so it must also stay dependency-free and unauthenticated.
  app.get("/health", (req, res) => res.json({ ok: true, service: "adlm-ai-service" }));

  // Whether the AI is actually WORKING, as opposed to whether this endpoint is
  // alive. A configured, enabled service that refuses every model call used to
  // look identical to a healthy one from out here — which is how a QUIV user
  // ends up staring at "AI service is unreachable" with nothing to go on.
  //
  // Public callers get the classification and the hint (enough to tell "our
  // model access was never granted" from "our key is out of balance" without
  // leaking request details); the provider's own words need the admin key.
  app.get("/health/ai", (req, res) => {
    const isAdmin =
      Boolean(config.adminApiKey) && req.headers["x-admin-key"] === config.adminApiKey;
    res.json({
      ok: true,
      configuredProvider: config.aiProvider,
      servingProvider: activeProvider(),
      fallbackConfigured: config.aiProviderFallback && Boolean(config.anthropicApiKey),
      region: config.awsRegion,
      models: config.models,
      transport: providerHealthSnapshot({ includeMessage: isAdmin }),
    });
  });

  // Lazy DB guard — Lambda containers reuse the connection across invocations.
  app.use(async (req, res, next) => {
    try {
      await connectAiDb();
      next();
    } catch (err) {
      next(err);
    }
  });

  app.use("/api/ai", aiRoutes);
  app.use("/api/ai/admin", adminRoutes);

  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
