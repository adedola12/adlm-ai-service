import { AiUsageEvent, CreditAccount } from "../models/index.js";
import { ThrottledError } from "../middleware/errors.js";
import { config } from "../config/index.js";

// Global credit guard: tracks platform-wide burn against the AWS credit and
// projected runway to the expiry date. If projected burn crosses the
// configured threshold of the straight-line budget, non-critical features
// are throttled. All figures (total, dates, threshold) are config, not code.

let guardState = null;
let guardAt = 0;
const GUARD_TTL_MS = 60 * 1000;

export async function getCreditAccount() {
  let acct = await CreditAccount.findOne({ provider: "aws-activate" });
  if (!acct) {
    acct = await CreditAccount.create({
      provider: "aws-activate",
      totalUsd: config.credit.totalUsd,
      startDate: new Date(config.credit.startDate),
      expiryDate: new Date(config.credit.expiryDate),
      guardThreshold: config.credit.guardThreshold,
    });
  }
  return acct;
}

export async function creditStatus(force = false) {
  if (!force && guardState && Date.now() - guardAt < GUARD_TTL_MS) return guardState;

  const acct = await getCreditAccount();
  const now = new Date();
  const [totals] = await AiUsageEvent.aggregate([
    { $group: { _id: null, spent: { $sum: "$estimatedCostUsd" } } },
  ]);
  const spentUsd = totals?.spent || 0;
  const remainingUsd = Math.max(0, acct.totalUsd - spentUsd);

  const elapsedDays = Math.max(1, (now - acct.startDate) / 86400000);
  const totalDays = Math.max(1, (acct.expiryDate - acct.startDate) / 86400000);
  const remainingDays = Math.max(0, (acct.expiryDate - now) / 86400000);

  const dailyBurn = spentUsd / elapsedDays;
  const budgetDaily = acct.totalUsd / totalDays;
  const burnRatio = budgetDaily > 0 ? dailyBurn / budgetDaily : 0;
  const runwayDays = dailyBurn > 0 ? remainingUsd / dailyBurn : Infinity;
  // If burn is so low the credit outlives its own expiry (or overflows the
  // Date range), the effective runway end is the expiry date itself.
  const runwayDate =
    Number.isFinite(runwayDays) && runwayDays < 36500
      ? new Date(Math.min(now.getTime() + runwayDays * 86400000, acct.expiryDate.getTime() + 366 * 86400000))
      : acct.expiryDate;

  // Last-24h spend for the daily alarm.
  const dayAgo = new Date(now.getTime() - 86400000);
  const [daily] = await AiUsageEvent.aggregate([
    { $match: { createdAt: { $gte: dayAgo } } },
    { $group: { _id: null, spent: { $sum: "$estimatedCostUsd" } } },
  ]);
  const last24hUsd = daily?.spent || 0;

  const throttled = burnRatio > acct.guardThreshold;
  const alarms = [];
  if (throttled) {
    alarms.push(
      `Burn is ${(burnRatio * 100).toFixed(0)}% of straight-line budget (threshold ${(acct.guardThreshold * 100).toFixed(0)}%) — non-critical features throttled`
    );
  }
  if (last24hUsd > config.credit.alarmDailySpendUsd) {
    alarms.push(`Last-24h spend $${last24hUsd.toFixed(2)} exceeds $${config.credit.alarmDailySpendUsd} alarm`);
  }
  if (alarms.length) console.warn("[creditGuard]", alarms.join(" | "));

  guardState = {
    totalUsd: acct.totalUsd,
    spentUsd: Number(spentUsd.toFixed(4)),
    remainingUsd: Number(remainingUsd.toFixed(4)),
    last24hUsd: Number(last24hUsd.toFixed(4)),
    dailyBurnUsd: Number(dailyBurn.toFixed(4)),
    budgetDailyUsd: Number(budgetDaily.toFixed(4)),
    burnRatio: Number(burnRatio.toFixed(3)),
    runwayDate,
    expiryDate: acct.expiryDate,
    guardThreshold: acct.guardThreshold,
    throttled,
    alarms,
  };
  guardAt = Date.now();
  return guardState;
}

// Throws ThrottledError for non-critical features while the guard is tripped.
export async function checkCreditGuard(feature) {
  const status = await creditStatus();
  if (status.throttled && config.nonCriticalFeatures.includes(feature)) {
    throw new ThrottledError(feature);
  }
  return status;
}
