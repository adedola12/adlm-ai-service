import { Router } from "express";
import { requireAiEntitlement } from "../middleware/auth.js";
import { rateBuildup } from "../services/rateBuildupService.js";
import { boqCheck } from "../services/boqCheckService.js";
import { detectOutliers } from "../services/outlierService.js";
import { catalogueExtract } from "../services/catalogueService.js";
import { takeoffCommand } from "../services/takeoffCommandService.js";
import { budgetMatch } from "../services/budgetMatchService.js";
import { billCleanup } from "../services/billCleanupService.js";
import { billAsk } from "../services/billAskService.js";
import { billFeedback } from "../services/billFeedbackService.js";

const router = Router();
router.use(requireAiEntitlement);

// The caller's own library rows, optional. A malformed entry is dropped rather
// than rejected: this is a naming hint, not part of the answer, so a client
// sending a stale or half-built list must still get its build-up.
//
// The cap is what stops a large library turning every request into a
// several-thousand-token prompt. Callers are meant to send their OWN additions,
// not their whole catalogue — the service already grounds on the master price
// lists, so master rows spend budget telling it what it already knows.
const MAX_LIBRARY_ITEMS = 300;
const MAX_LIBRARY_NAME = 160;

function sanitizeLibraryItems(raw) {
  if (!Array.isArray(raw)) return [];

  const seen = new Set();
  const out = [];

  for (const item of raw) {
    const name = String(item?.name || "").trim().slice(0, MAX_LIBRARY_NAME);
    if (!name) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const kind = String(item?.kind || "").trim().toLowerCase();
    out.push({
      kind: kind === "labour" ? "labour" : "material",
      name,
      unit: String(item?.unit || "").trim().slice(0, 32) || null,
    });

    if (out.length >= MAX_LIBRARY_ITEMS) break;
  }

  return out;
}

// Controllers stay thin: validate the shape, delegate to the service.
router.post("/rate-buildup", async (req, res, next) => {
  try {
    const { description, zone, unit, libraryItems } = req.body || {};
    if (!description || typeof description !== "string") {
      return res.status(400).json({ error: "description is required", code: "BAD_INPUT" });
    }
    res.json(
      await rateBuildup({
        tenantId: req.tenantId,
        product: req.product,
        description,
        zone,
        unit,
        libraryItems: sanitizeLibraryItems(libraryItems),
      })
    );
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

router.post("/budget-match", async (req, res, next) => {
  try {
    const { rows, candidates } = req.body || {};
    if (!Array.isArray(rows) || !rows.length || !Array.isArray(candidates) || !candidates.length) {
      return res.status(400).json({ error: "rows[] and candidates[] are required", code: "BAD_INPUT" });
    }
    res.json(await budgetMatch({ tenantId: req.tenantId, product: req.product, rows, candidates }));
  } catch (err) {
    next(err);
  }
});

// Bill clean-up: descriptions, units, duplicates, coverage gaps. Rates are NOT
// handled here — callers wanting a rate opinion hit /boq-check, which benchmarks
// against the RateGen library instead of asking a model.
router.post("/bill-cleanup", async (req, res, next) => {
  try {
    const { items, zone, checks, specifications } = req.body || {};
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] is required", code: "BAD_INPUT" });
    }
    res.json(
      await billCleanup({
        tenantId: req.tenantId,
        product: req.product,
        items,
        zone,
        checks,
        specifications,
      })
    );
  } catch (err) {
    next(err);
  }
});

router.post("/bill-ask", async (req, res, next) => {
  try {
    const { question, items, currencyCode } = req.body || {};
    if (!question || typeof question !== "string") {
      return res.status(400).json({ error: "question is required", code: "BAD_INPUT" });
    }
    if (!Array.isArray(items) || !items.length) {
      return res.status(400).json({ error: "items[] is required", code: "BAD_INPUT" });
    }
    res.json(await billAsk({ tenantId: req.tenantId, product: req.product, question, items, currencyCode }));
  } catch (err) {
    next(err);
  }
});

// What the QS did with the suggestions. Calls no model, so it consumes no
// quota — charging someone for telling us we were wrong is the wrong incentive.
router.post("/bill-feedback", async (req, res, next) => {
  try {
    const { decisions } = req.body || {};
    if (!Array.isArray(decisions)) {
      return res.status(400).json({ error: "decisions[] is required", code: "BAD_INPUT" });
    }
    res.json(await billFeedback({ tenantId: req.tenantId, decisions }));
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
