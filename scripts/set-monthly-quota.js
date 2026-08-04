// Backfills TenantAiQuota.monthlyQuota for tenants that already have a quota
// document. New tenants get config.defaultMonthlyQuota on first call, so this
// script exists only for accounts created under an earlier default.
//
//   node scripts/set-monthly-quota.js              # dry run, prints what would change
//   node scripts/set-monthly-quota.js --apply      # writes
//   node scripts/set-monthly-quota.js --apply 250  # a value other than the config default
//
// Deliberately does NOT touch `used` or `resetAt`. Raising someone's allowance
// mid-month should not also hand back the month's spend, and resetting the
// window would silently give a second month's worth.
import "dotenv/config";
import mongoose from "mongoose";
import { config } from "../src/config/index.js";
import { TenantAiQuota } from "../src/models/index.js";

const apply = process.argv.includes("--apply");
const explicit = process.argv.find((a) => /^\d+$/.test(a));
const target = explicit ? Number(explicit) : config.defaultMonthlyQuota;

if (!Number.isFinite(target) || target <= 0) {
  console.error(`Refusing to set a non-positive quota (${target}).`);
  process.exit(1);
}

await mongoose.connect(config.mongoUri, { dbName: config.aiDb });

const all = await TenantAiQuota.find({}, { tenantId: 1, monthlyQuota: 1, used: 1 }).lean();
const changing = all.filter((q) => q.monthlyQuota !== target);

console.log(`Target monthly quota: ${target}`);
console.log(`Tenants with a quota document: ${all.length}`);
console.log(`Would change: ${changing.length}`);

// Anyone already past the new ceiling is locked out for the rest of the month.
// Worth naming individually rather than discovering via support tickets.
const nowOverspent = changing.filter((q) => (q.used || 0) > target);
if (nowOverspent.length) {
  console.log(
    `\n⚠ ${nowOverspent.length} tenant(s) have already used more than ${target} this month and will be` +
      ` blocked until their reset date:`
  );
  for (const q of nowOverspent) console.log(`   ${q.tenantId}  used=${q.used}`);
}

if (!apply) {
  console.log("\nDry run — nothing written. Re-run with --apply to commit.");
  await mongoose.disconnect();
  process.exit(0);
}

const res = await TenantAiQuota.updateMany(
  { monthlyQuota: { $ne: target } },
  { $set: { monthlyQuota: target } }
);
console.log(`\nUpdated ${res.modifiedCount} tenant(s) to monthlyQuota=${target}.`);

await mongoose.disconnect();
