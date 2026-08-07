// Deterministic guards on a rate build-up.
//
// SYSTEM_PROMPT already states both of these rules. A grade 40 concrete
// build-up broke them anyway — 24 bags of cement per m3 (physically impossible;
// grade 40 needs 8-9), mason and headman priced per DAY at quantity 2 and 1
// with no pro-rating, and a total of N460,397/m3 against N186,045 for the
// stronger grade 50 mix — and still reported confidence 0.95, so the escalation
// gate never fired. A model instruction is not a control; these are checks.

const CURRENCY = new Intl.NumberFormat("en-NG", { maximumFractionDigits: 0 });
const money = (n) => `N${CURRENCY.format(Math.round(Number(n) || 0))}`;

// A bare time unit means the line is priced for a whole gang-day or gang-hour,
// so the quantity must be a fraction (1 / daily output). "hr/m3" or "day/m2"
// already carry the division and are fine.
const BARE_TIME_UNIT = /^\s*(day|days|hr|hrs|hour|hours|shift|shifts|week|weeks|wk|wks)\s*$/i;

/** Lines priced per day/hour that were never divided by a daily output. */
export function findProRatingViolations(components) {
  const violations = [];

  for (const c of components || []) {
    const unit = String(c?.unit ?? "").trim();
    const quantity = Number(c?.quantity) || 0;

    if (BARE_TIME_UNIT.test(unit) && quantity >= 1) {
      violations.push(
        `"${c?.name ?? "unnamed"}" is priced per ${unit} but carries quantity ` +
          `${quantity} — it was not pro-rated to one unit of work.`,
      );
    }
  }

  return violations;
}

/**
 * The library yardstick: the MEDIAN of comparable rates, not the top-scoring
 * one.
 *
 * Picking by match score alone is too fragile to hang a gate on. For "concrete
 * grade 40" the library returns "grade 30 for repair works in water logged
 * area" at N707,670 and "grade 40 in foundation or slab" at N413,957 — both
 * scoring 0.50, so the tie broke arbitrarily and the yardstick moved by 70%
 * depending on which won. The median of the comparable set is stable and one
 * unusual rate cannot drag it.
 */
function referenceRate(buildUnit, candidates) {
  const unit = String(buildUnit ?? "").trim().toLowerCase();

  const comparable = (candidates || [])
    // Comparing an m2 rate against an m3 one is meaningless, so only measure
    // against candidates measured in the same unit.
    .filter((c) => Number(c?.totalCost) > 0)
    .filter((c) => !unit || String(c?.unit ?? "").trim().toLowerCase() === unit)
    .sort((a, b) => Number(a.totalCost) - Number(b.totalCost));

  if (!comparable.length) return null;

  const mid = Math.floor(comparable.length / 2);
  const median =
    comparable.length % 2
      ? Number(comparable[mid].totalCost)
      : (Number(comparable[mid - 1].totalCost) + Number(comparable[mid].totalCost)) / 2;

  return {
    totalCost: median,
    count: comparable.length,
    // Named for the message: the closest-priced comparable, so the QS can see
    // which library item the number is being measured against.
    description: comparable.reduce((best, c) =>
      Math.abs(Number(c.totalCost) - median) < Math.abs(Number(best.totalCost) - median) ? c : best,
    ).description,
  };
}

/**
 * Totals that are wildly out against the closest comparable library rate, and
 * single components that dominate the whole rate.
 */
export function findSanityViolations(build, candidates, { factor = 2.5 } = {}) {
  const violations = [];
  const rate = Number(build?.rateNgn) || 0;
  if (rate <= 0) return violations;

  const ref = referenceRate(build?.unit, candidates);
  if (!ref) return violations;

  const ratio = rate / ref.totalCost;

  const yardstick =
    `the median of ${ref.count} comparable library rate${ref.count === 1 ? "" : "s"} ` +
    `(${money(ref.totalCost)}, e.g. "${ref.description}")`;

  if (ratio > factor) {
    violations.push(
      `Rate ${money(rate)} is ${ratio.toFixed(1)}x ${yardstick} — likely a ` +
        `units or pro-rating error.`,
    );
  } else if (ratio < 1 / factor) {
    violations.push(
      `Rate ${money(rate)} is only ${(ratio * 100).toFixed(0)}% of ${yardstick} — ` +
        `likely a missing component.`,
    );
  }

  // One line carrying more than a whole comparable rate is the shape a
  // quantity blunder takes — the grade 40 build-up put 24 bags of cement in a
  // cubic metre (grade 40 needs 8-9), which no total-level check would catch
  // once overhead and profit had blurred it.
  for (const c of build?.components || []) {
    const total = Number(c?.totalNgn) || 0;
    if (total > ref.totalCost) {
      violations.push(
        `"${c?.name ?? "unnamed"}" alone costs ${money(total)}, more than a whole ` +
          `comparable library rate (${money(ref.totalCost)}) — check its quantity.`,
      );
    }
  }

  return violations;
}

/** Both gates. Returns [] when the build-up is plausible. */
export function checkBuildup(build, candidates, options) {
  return [
    ...findProRatingViolations(build?.components),
    ...findSanityViolations(build, candidates, options),
  ];
}

/**
 * Rate implied by the model's own numbers, before library repricing. Lets the
 * sanity gate run while there is still an escalation left to spend.
 */
export function provisionalBuild(json) {
  const components = (json?.components || []).map((c) => ({
    ...c,
    totalNgn: (Number(c?.quantity) || 0) * (Number(c?.unitPriceNgn) || 0),
  }));

  const net = components.reduce((sum, c) => sum + c.totalNgn, 0);
  const overhead = (net * (Number(json?.overheadPercent) || 0)) / 100;
  const profit = (net * (Number(json?.profitPercent) || 0)) / 100;

  return { unit: json?.unit, components, rateNgn: net + overhead + profit };
}
