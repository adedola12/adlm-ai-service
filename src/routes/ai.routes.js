import { Router } from "express";
import { requireAiEntitlement } from "../middleware/auth.js";
import { rateBuildup } from "../services/rateBuildupService.js";
import { boqCheck } from "../services/boqCheckService.js";
import { detectOutliers } from "../services/outlierService.js";
import { catalogueExtract } from "../services/catalogueService.js";
import { takeoffCommand } from "../services/takeoffCommandService.js";

const router = Router();
router.use(requireAiEntitlement);

// Controllers stay thin: validate the shape, delegate to the service.
router.post("/rate-buildup", async (req, res, next) => {
  try {
    const { description, zone, unit } = req.body || {};
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required", code: "BAD_INPUT" });
    }
    res.json(await rateBuildup({ tenantId: req.tenantId, product: req.product, description, zone, unit }));
  } catch (err) {
    next(err);
  }
});

router.post("/boq-check", async (req, res, next) => {
  try {
    const { items, zone } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] is required", code: "BAD_INPUT" });
    }
    res.json(await boqCheck({ tenantId: req.tenantId, product: req.product, items, zone }));
  } catch (err) {
    next(err);
  }
});

router.post("/outliers", async (req, res, next) => {
  try {
    const { items } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] is required", code: "BAD_INPUT" });
    }
    res.json(await detectOutliers({ tenantId: req.tenantId, product: req.product, items }));
  } catch (err) {
    next(err);
  }
});

router.post("/catalogue/extract", async (req, res, next) => {
  try {
    const { pages, taxonomy, templateColumns } = req.body || {};
    if (!Array.isArray(pages) || !pages.length) {
      return res.status(400).json({ error: "pages[] (base64) is required", code: "BAD_INPUT" });
    }
    res.json(
      await catalogueExtract({ tenantId: req.tenantId, product: req.product, pages, taxonomy, templateColumns })
    );
  } catch (err) {
    next(err);
  }
});

router.post("/takeoff-command", async (req, res, next) => {
  try {
    const { prompt, context } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "prompt is required", code: "BAD_INPUT" });
    }
    res.json(await takeoffCommand({ tenantId: req.tenantId, product: req.product, prompt, context }));
  } catch (err) {
    next(err);
  }
});

// Deferred until a reliable price-trend data source exists. Deliberately a
// stub — do not fake forecasts.
router.post("/forecast", (req, res) => {
  res.status(501).json({
    ok: false,
    code: "NOT_YET_AVAILABLE",
    message:
      "Cost forecasting is not yet available. It will launch once a reliable price-trend data source is integrated.",
  });
});

export default router;
