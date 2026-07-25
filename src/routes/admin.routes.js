import { Router } from "express";
import { requireAdminKey } from "../middleware/adminKey.js";
import { creditStatus, getCreditAccount } from "../governance/creditGuard.js";
import { loadPricing } from "../governance/pricing.js";
import * as reporting from "../services/reportingService.js";

const router = Router();
router.use(requireAdminKey);

router.get("/usage", async (req, res, next) => {
  try {
    const { tenantId, feature, from, to, limit } = req.query;
    res.json({ ok: true, events: await reporting.usage({ tenantId, feature, from, to, limit: Number(limit) || 200 }) });
  } catch (err) {
    next(err);
  }
});

router.get("/usage/summary", async (req, res, next) => {
  try {
    const { from, to } = req.query;
    res.json({ ok: true, summary: await reporting.usageSummary({ from, to }) });
  } catch (err) {
    next(err);
  }
});

router.get("/credit", async (req, res, next) => {
  try {
    res.json({ ok: true, credit: await creditStatus(true) });
  } catch (err) {
    next(err);
  }
});

router.patch("/credit", async (req, res, next) => {
  try {
    const acct = await getCreditAccount();
    const { totalUsd, startDate, expiryDate, guardThreshold } = req.body || {};
    if (totalUsd !== undefined) acct.totalUsd = Number(totalUsd);
    if (startDate) acct.startDate = new Date(startDate);
    if (expiryDate) acct.expiryDate = new Date(expiryDate);
    if (guardThreshold !== undefined) acct.guardThreshold = Number(guardThreshold);
    acct.updatedAt = new Date();
    await acct.save();
    res.json({ ok: true, credit: await creditStatus(true) });
  } catch (err) {
    next(err);
  }
});

router.get("/pricing-rates", async (req, res, next) => {
  try {
    res.json({ ok: true, rates: await reporting.listPricing() });
  } catch (err) {
    next(err);
  }
});

router.patch("/pricing-rates/:id", async (req, res, next) => {
  try {
    const rate = await reporting.updatePricing(req.params.id, req.body || {});
    if (!rate) return res.status(404).json({ error: "not found" });
    await loadPricing(true);
    res.json({ ok: true, rate });
  } catch (err) {
    next(err);
  }
});

router.get("/quotas", async (req, res, next) => {
  try {
    res.json({ ok: true, quotas: await reporting.listQuotas() });
  } catch (err) {
    next(err);
  }
});

router.patch("/quotas/:tenantId", async (req, res, next) => {
  try {
    res.json({ ok: true, quota: await reporting.updateQuota(req.params.tenantId, req.body || {}) });
  } catch (err) {
    next(err);
  }
});

export default router;
