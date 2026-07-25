import express from "express";
import { connectAiDb } from "./db/connect.js";
import { assertConfig } from "./config/index.js";
import aiRoutes from "./routes/ai.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { errorHandler } from "./middleware/errors.js";

export function createApp() {
  assertConfig();
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "25mb" })); // catalogue pages arrive base64-encoded

  // Lazy DB guard — Lambda containers reuse the connection across invocations.
  app.use(async (req, res, next) => {
    try {
      await connectAiDb();
      next();
    } catch (err) {
      next(err);
    }
  });

  app.get("/health", (req, res) => res.json({ ok: true, service: "adlm-ai-service" }));

  app.use("/api/ai", aiRoutes);
  app.use("/api/ai/admin", adminRoutes);

  app.use((req, res) => res.status(404).json({ error: "Not found" }));
  app.use(errorHandler);
  return app;
}
