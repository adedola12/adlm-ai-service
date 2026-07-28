// Fixes *_items whose header totals (NetCost/OverheadValue/ProfitValue/
// TotalCost) drifted from their own breakdown lines — WITHOUT touching any
// line. Conservative by design:
//
//   An item is auto-fixable only when its lines provably follow the linear
//   model: every priced line (qty>0 && unitPrice>0) satisfies
//   TotalPrice = qty x unitPrice (within N1), and there are no unexplained
//   value lines (qty/price 0 but TotalPrice > 0) other than subtotal/total
//   and allowance rows. Then:
//       trueNet = sum(stored TotalPrice of component + allowance lines)
//   and OH/Profit are re-derived from the item's stored ratios
//   (fallback 10% / 25%). Items that fail the gate are listed for manual
//   review in the RateGen admin — never modified.
//
// Usage:
//   node scripts/resave-item-totals.js           (dry run)
//   node scripts/resave-item-totals.js --apply   (backup + write headers)
import "dotenv/config";
import { writeFileSync, mkdirSync } from "node:fs";
import { MongoClient } from "mongodb";

const APPLY = process.argv.includes("--apply");
const COLLECTIONS = [
  "blockwork_items", "concretework_items", "finishes_items", "groundwork_items",
  "paintwork_items", "roofwork_items", "steelwork_items", "windowsAndDoor_items",
];
const TOTALISH = /^\s*(sub-?total|total)\b/i;
const ALLOWANCE = /^\s*(add\s+for|allow)\b/i;
const r2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Returns { net } or { fail: reason }
function analyse(lines) {
  let net = 0;
  for (const l of lines) {
    const name = String(l.ComponentName || "");
    const qty = Number(l.Quantity) || 0;
    const price = Number(l.UnitPrice) || 0;
    const stored = Number(l.TotalPrice) || 0;
    if (TOTALISH.test(name)) continue; // display rows, excluded from the sum
    if (ALLOWANCE.test(name)) { net += stored; continue; }
    if (qty > 0 && price > 0) {
      if (Math.abs(stored - qty * price) > 1)
        return { fail: `line '${name.slice(0, 30)}' stored ${stored} != qty*price ${r2(qty * price)}` };
      net += stored;
      continue;
    }
    if (Math.abs(stored) <= 0.01) continue; // empty row
    return { fail: `line '${name.slice(0, 30)}' has value ${stored} with no qty*price (intermediate calculator?)` };
  }
  return { net: r2(net) };
}

const c = new MongoClient(process.env.RATEGEN_MONGO_URI, { serverSelectionTimeoutMS: 15000 });
await c.connect();
const db = c.db(process.env.RATEGEN_MASTER_DB || "ADLMRateDB");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const backupDir = `${process.env.TEMP || "."}/adlm-item-backups-${stamp}`;
if (APPLY) mkdirSync(backupDir, { recursive: true });

let fixed = 0, consistent = 0;
const review = [];
for (const coll of COLLECTIONS) {
  const docs = await db.collection(coll).find({}).toArray();
  if (APPLY && docs.length) writeFileSync(`${backupDir}/${coll}.json`, JSON.stringify(docs, null, 1));
  for (const doc of docs) {
    const bf = Object.keys(doc).find((k) => Array.isArray(doc[k]) && doc[k].length && doc[k][0]?.ComponentName !== undefined);
    if (!bf) { review.push(`${coll} #${doc.ItemNo} — no breakdown`); continue; }
    const res = analyse(doc[bf]);
    if (res.fail) { review.push(`${coll} #${doc.ItemNo} ${String(doc.Description).slice(0, 40)} — ${res.fail}`); continue; }

    const oldNet = Number(doc.NetCost) || 0;
    if (Math.abs(res.net - oldNet) <= 1) { consistent++; continue; }

    const ohPct = oldNet > 0 ? (Number(doc.OverheadValue) || 0) / oldNet : 0.10;
    const prPct = oldNet > 0 ? (Number(doc.ProfitValue) || 0) / oldNet : 0.25;
    const oh = r2(res.net * ohPct), pr = r2(res.net * prPct), total = r2(res.net + oh + pr);
    console.log(`${APPLY ? "FIX " : "DRIFT"} ${coll} #${doc.ItemNo} ${String(doc.Description).slice(0, 48)}`);
    console.log(`      net ${oldNet} -> ${res.net} | total ${doc.TotalCost} -> ${total}`);
    fixed++;
    if (APPLY) {
      await db.collection(coll).updateOne(
        { _id: doc._id },
        { $set: { NetCost: res.net, OverheadValue: oh, ProfitValue: pr, TotalCost: total, totalsResavedAt: new Date() } }
      );
    }
  }
}
console.log(`\n${APPLY ? "APPLIED" : "DRY RUN"}: ${fixed} header fixes, ${consistent} consistent, ${review.length} need manual review`);
for (const r of review) console.log("  REVIEW:", r);
if (APPLY) console.log("Backups:", backupDir);
await c.close();
