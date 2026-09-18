// Feature test: boq-fill against a client-format bill and QUIV-shaped measured
// lines — model routing, caching, quota, audit and metering, plus the rules the
// service must hold whatever the model says. Run AFTER test-meter.js passes.
//
//   node scripts/test-boq-fill.js                 # built-in sample
//   node scripts/test-boq-fill.js input.json      # { rows: [...], candidates: [...] }
import "dotenv/config";
import { readFileSync } from "node:fs";
import mongoose from "mongoose";
import { connectAiDb } from "../src/db/connect.js";
import { boqFill, convertFactor } from "../src/services/boqFillService.js";

// A client bill written the way Nigerian bills are: headings carry the
// material, items are fragments, one line is a ditto. No client bill is
// committed here because this repository is public.
const ROWS = [
  { id: "A", section: "CONCRETE WORK", headings: ["Reinforced in-situ concrete (1:2:4) - 19mm aggregate"], description: "Suspended slabs; thickness 150mm", unit: "m3" },
  { id: "B", section: "CONCRETE WORK", headings: ["Reinforced in-situ concrete (1:2:4) - 19mm aggregate"], description: "Beams", unit: "m3" },
  { id: "C", section: "CONCRETE WORK", headings: ["Reinforced in-situ concrete (1:2:4) - 19mm aggregate"], description: "ditto in columns", unit: "m3" },
  { id: "D", section: "CONCRETE WORK", headings: ["Reinforcement", "High yield steel bars to BS 4449"], description: "Bars in beams, all sizes", unit: "t" },
  { id: "E", section: "BLOCKWORK", headings: ["Sandcrete blockwork in cement mortar (1:6)"], description: "225mm hollow sandcrete blocks in walls", unit: "m2" },
  { id: "F", section: "BLOCKWORK", headings: ["Sandcrete blockwork in cement mortar (1:6)"], description: "150mm ditto in partitions", unit: "m2" },
  // Nothing measured for this — must come back unmatched, not forced.
  { id: "G", section: "PLUMBING", headings: [], description: "WC suite complete with cistern", unit: "nr" },
  // Unit trap: area row against only volume/length candidates for the work.
  { id: "H", section: "CONCRETE WORK", headings: ["Formwork"], description: "Sides and soffits of beams", unit: "m2" },
];

const CANDIDATES = [
  { id: "c1", description: "Slab – Concrete 150mm", unit: "m3", qty: 42.5, level: "First Floor" },
  { id: "c2", description: "Slab – Concrete 150mm", unit: "m3", qty: 40.1, level: "Second Floor" },
  { id: "c3", description: "Beams – Concrete 230x450", unit: "m3", qty: 12.2, level: "First Floor" },
  { id: "c4", description: "Beams – Concrete 230x600", unit: "m3", qty: 6.4, level: "First Floor" },
  { id: "c5", description: "Beams – Concrete 230x450", unit: "m3", qty: 11.9, level: "Second Floor" },
  { id: "c6", description: "Columns – Concrete 230x230", unit: "m3", qty: 8.1, level: "Ground Floor" },
  { id: "c7", description: "Columns – Concrete 230x230", unit: "m3", qty: 7.7, level: "First Floor" },
  { id: "c8", description: "Beams – Reinforcement", unit: "kg", qty: 2450, level: "First Floor" },
  { id: "c9", description: "Beams – Reinforcement", unit: "kg", qty: 2310, level: "Second Floor" },
  { id: "c10", description: "Blockwork – Wall Area 225mm", unit: "m2", qty: 610, level: "Ground Floor" },
  { id: "c11", description: "Blockwork – Wall Area 225mm", unit: "m2", qty: 585, level: "First Floor" },
  { id: "c12", description: "Blockwork – Wall Area 150mm", unit: "m2", qty: 220, level: "Ground Floor" },
  { id: "c13", description: "Beams – Formwork", unit: "m2", qty: 180, level: "First Floor" },
  { id: "c14", description: "Beams – Formwork", unit: "m2", qty: 176, level: "Second Floor" },
];

// Deterministic rules first — these must hold without a model.
const checks = [];
const check = (name, ok) => checks.push([name, !!ok]);
check("kg -> t converts by 1/1000", convertFactor("kg", "t") === 0.001);
check("m2 never converts to m3", convertFactor("m2", "m3") === null);
check("sqm == m2", convertFactor("sqm", "m2") === 1);
check("nr == No.", convertFactor("No.", "nr") === 1);

const input = process.argv[2] ? JSON.parse(readFileSync(process.argv[2], "utf8")) : { rows: ROWS, candidates: CANDIDATES };

await connectAiDb();
const t0 = Date.now();
const out = await boqFill({ tenantId: "test-boq-fill", product: "quiv", ...input });
const ms = Date.now() - t0;

const r = out.result;
const byId = new Map(r.fills.map((f) => [f.rowId, f]));
for (const f of r.fills) {
  console.log(
    `${f.rowId.padEnd(3)} ${String(f.qty).padStart(9)} ${f.unit.padEnd(3)} conf ${f.confidence.toFixed(2)}  <- ${f.sources
      .map((s) => `${s.candidateId}(${s.level || "-"})`)
      .join(" + ")}  ${f.reason}`,
  );
}
for (const u of r.unmatched) console.log(`${u.rowId.padEnd(3)} unmatched: ${u.reason}`);
if (r.sharedCandidates.length) console.log("shared:", JSON.stringify(r.sharedCandidates));
console.log(`model ${out.audit?.model || "-"}  cached ${out.cached}  ${ms} ms`);

if (!process.argv[2]) {
  const qty = (id) => byId.get(id)?.qty;
  check("slab = both floors (82.6)", qty("A") === 82.6);
  check("beams = every beam size and floor (30.5)", qty("B") === 30.5);
  check("ditto in columns resolves to column concrete (15.8)", qty("C") === 15.8);
  check("beam rebar kg -> t (4.76)", qty("D") === 4.76);
  check("225 blockwork excludes 150 (1195)", qty("E") === 1195);
  check("150 ditto in partitions (220)", qty("F") === 220);
  check("WC suite not forced", !byId.has("G"));
  check("formwork m2 = both floors (356)", qty("H") === 356);
  check("every fill sum equals its sources", r.fills.every((f) => Math.abs(f.qty - f.sources.reduce((s, x) => s + x.qtyInRowUnit, 0)) < 1e-6));
}

let failed = 0;
for (const [name, ok] of checks) {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
}
await mongoose.disconnect();
process.exit(failed ? 1 : 0);
