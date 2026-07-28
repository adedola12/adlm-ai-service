// Builds the served rate library (adlmWeb.rategenrates — what QUIV's
// "Profile rates" and RateGen desktop's rate catalog sync from) out of the
// master build-ups on the RateGen ADMIN cluster (*_items collections).
//
// Two modes:
//   node scripts/build-rate-library.js
//     Convert every admin *_items build-up into a rategenrates row (upsert
//     by code, provenance stamped). Costs nothing — no AI calls.
//
//   node scripts/build-rate-library.js --ai items.txt [zone]
//     For each description in items.txt (one per line), call the LIVE
//     /rate-buildup endpoint and write the result as an AI DRAFT row
//     (aiDraft: true, code prefixed AI-) for review before publishing.
//     Requires ADLM_AI_URL + ADLM_AI_TOKEN in the environment.
import "dotenv/config";
import { readFileSync } from "node:fs";
import { MongoClient } from "mongodb";

const SECTION_LABELS = {
  blockwork_items: ["blockwork", "Blockwork"],
  concretework_items: ["concretework", "Concrete Work"],
  finishes_items: ["finishes", "Finishes"],
  groundwork_items: ["groundwork", "Groundwork"],
  paintwork_items: ["paintwork", "Painting & Decorating"],
  roofwork_items: ["roofwork", "Roof Work"],
  steelwork_items: ["steelwork", "Steelwork"],
  windowsAndDoor_items: ["windowsdoors", "Windows & Doors"],
};
const LABOUR_HINTS = /labour|workmanship|mason|carpenter|iron\s*bender|welder|fixing|placing|loading|unloading|foreman|headman|tradesman|crew|gang/i;
const TOTALISH = /^\s*(sub-?total|total)\b/i;
const ALLOWANCE = /^\s*(add\s+for|add\s|allow)\b/i;
const r2 = (n) => Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

// A breakdown is exported ONLY when it provably follows the linear model:
// every priced line = qty x unitPrice and the component+allowance sum matches
// the item's NetCost. Non-linear calculator templates (six-use formwork,
// per-day gang costs, per-sheet conversions) sum to per-BATCH figures, not
// per-unit — deriving material/labour portions from them poisons every
// consumer (QUIV budget decomposition, AI labour candidates: the N31,063/m2
// formwork-labour incident). Those items serve their headline rate only.
function linearBreakdown(rawLines, netCost) {
  const lines = [];
  let sum = 0;
  for (const b of rawLines) {
    const name = String(b.ComponentName || "");
    const qty = Number(b.Quantity) || 0;
    const price = Number(b.UnitPrice) || 0;
    const stored = Number(b.TotalPrice) || 0;
    if (TOTALISH.test(name)) continue; // display rows — never exported
    if (ALLOWANCE.test(name) && stored > 0 && !(qty > 0 && price > 0)) {
      sum += stored;
      lines.push({ name, qty, unit: b.Unit || "", price, stored, kind: "material" });
      continue;
    }
    if (qty > 0 && price > 0) {
      if (Math.abs(stored - qty * price) > 1) return null;
      sum += stored;
      lines.push({
        name, qty, unit: b.Unit || "", price, stored,
        kind: LABOUR_HINTS.test(name) ? "labour" : "material",
      });
      continue;
    }
    if (Math.abs(stored) <= 0.01) continue; // empty row
    return null; // unexplained value line — calculator template
  }
  if (!lines.length || Math.abs(sum - netCost) > 1) return null;
  return lines;
}

const admin = new MongoClient(process.env.RATEGEN_MONGO_URI, { serverSelectionTimeoutMS: 15000 });
const web = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000 });
await admin.connect();
await web.connect();
const adminDb = admin.db(process.env.RATEGEN_MASTER_DB || "ADLMRateDB");
const rates = web.db(process.env.GROUNDING_DB || "adlmWeb").collection("rategenrates");

function toRow({ sectionKey, sectionLabel, code, itemNo, description, unit, net, oh, profit, total, lines, extra }) {
  return {
    sectionKey,
    sectionLabel,
    itemNo,
    code,
    description,
    unit: unit || "",
    netCost: r2(net),
    overheadPercent: net > 0 ? r2((oh / net) * 100) : 10,
    profitPercent: net > 0 ? r2((profit / net) * 100) : 25,
    overheadValue: r2(oh),
    profitValue: r2(profit),
    totalCost: r2(total),
    breakdown: lines,
    updatedAt: new Date(),
    ...extra,
  };
}

async function upsert(row) {
  await rates.updateOne({ code: row.code }, { $set: row }, { upsert: true });
}

const aiMode = process.argv.indexOf("--ai");
if (aiMode === -1) {
  // ── Mode 1: convert admin master build-ups ────────────────────────────────
  let count = 0;
  let withBreakdown = 0;
  for (const [coll, [sectionKey, sectionLabel]] of Object.entries(SECTION_LABELS)) {
    const docs = await adminDb.collection(coll).find({}).toArray();
    for (const doc of docs) {
      const bf = Object.keys(doc).find((k) => Array.isArray(doc[k]) && doc[k].length && doc[k][0]?.ComponentName !== undefined);
      const clean = linearBreakdown(bf ? doc[bf] : [], Number(doc.NetCost) || 0);
      const lines = (clean || []).map((l) => ({
        componentName: l.name,
        quantity: l.qty,
        unit: l.unit,
        unitPrice: r2(l.price),
        totalPrice: r2(l.stored),
        refKind: l.kind,
      }));
      if (clean) withBreakdown++;
      await upsert(
        toRow({
          sectionKey,
          sectionLabel,
          code: `${sectionKey}-${doc.ItemNo}`,
          itemNo: Number(doc.ItemNo) || 0,
          description: doc.Description,
          unit: doc.Unit,
          net: doc.NetCost,
          oh: doc.OverheadValue,
          profit: doc.ProfitValue,
          total: doc.TotalCost,
          lines,
          extra: {
            source: "admin-items",
            sourceCollection: coll,
            aiDraft: false,
            // Headline-only items: calculator-template breakdowns are not
            // per-unit-linear, so no component split is served for them.
            breakdownOmitted: !clean,
          },
        })
      );
      count++;
    }
  }
  console.log(`Converted ${count} admin build-ups (${withBreakdown} with linear breakdowns, ${count - withBreakdown} headline-only).`);
} else {
  // ── Mode 2: AI drafts for new work items ─────────────────────────────────
  const file = process.argv[aiMode + 1];
  const zone = process.argv[aiMode + 2] || "south_west";
  const base = process.env.ADLM_AI_URL;
  const token = process.env.ADLM_AI_TOKEN;
  if (!file || !base || !token) {
    console.error("Usage: --ai items.txt [zone]  (needs ADLM_AI_URL + ADLM_AI_TOKEN env)");
    process.exit(1);
  }
  const items = readFileSync(file, "utf-8").split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let n = 0;
  for (const description of items) {
    const res = await fetch(`${base.replace(/\/$/, "")}/api/ai/rate-buildup`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "x-adlm-product": "rategen" },
      body: JSON.stringify({ description, zone }),
    });
    const body = await res.json();
    if (!res.ok || body.ok === false || !body.result) {
      console.error(`SKIP "${description.slice(0, 50)}": ${body.code || res.status}`);
      continue;
    }
    const r = body.result;
    n++;
    await upsert(
      toRow({
        sectionKey: "ai-drafts",
        sectionLabel: "AI Drafts (review before publish)",
        code: `AI-${n}-${description.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40)}`,
        itemNo: n,
        description,
        unit: r.unit,
        net: r.netCostNgn,
        oh: r.overheadNgn,
        profit: r.profitNgn,
        total: r.rateNgn,
        lines: (r.components || []).map((c) => ({
          componentName: c.name,
          quantity: c.quantity,
          unit: c.unit,
          unitPrice: r2(c.unitPriceNgn),
          totalPrice: r2(c.totalNgn),
          refKind: c.kind === "labour" ? "labour" : "material",
        })),
        extra: {
          source: "ai-draft",
          aiDraft: true,
          aiModel: body.audit?.model,
          aiConfidence: body.audit?.confidence ?? null,
          zone,
        },
      })
    );
    console.log(`DRAFT "${description.slice(0, 50)}" — N${r.rateNgn}/${r.unit} (${(body.audit?.model || "").slice(0, 30)})`);
  }
  console.log(`Wrote ${n} AI draft rows (aiDraft: true).`);
}

await admin.close();
await web.close();
