import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkBuildup,
  findProRatingViolations,
  findSanityViolations,
  provisionalBuild,
} from "./rateBuildupChecks.js";

// The build-up that motivated these gates: "Build rate for concrete grade 40",
// returned with confidence 0.95. Cement at 24 bag/m3 (grade 40 needs 8-9),
// mason and headman priced per day at quantity 2 and 1, total N460,397/m3 —
// against N186,045 for the stronger grade 50 mix.
const GRADE_40 = {
  unit: "m3",
  rateNgn: 460397.6,
  components: [
    { name: "Cement", kind: "material", quantity: 24, unit: "bag/m3", unitPriceNgn: 10200, totalNgn: 244800 },
    { name: "Sand", kind: "material", quantity: 0.21, unit: "m3/m3", unitPriceNgn: 12500, totalNgn: 2625 },
    { name: "Mason", kind: "labour", quantity: 2, unit: "day", unitPriceNgn: 14000, totalNgn: 28000 },
    { name: "Headman", kind: "labour", quantity: 1, unit: "day", unitPriceNgn: 12000, totalNgn: 12000 },
  ],
};

const CANDIDATES = [
  { description: "Concrete grade 25 in foundations", unit: "m3", totalCost: 150000, matchScore: 0.72 },
  { description: "Blockwork 225mm", unit: "m2", totalCost: 12000, matchScore: 0.4 },
];

test("pro-rating: flags a bare per-day line with quantity 1 or more", () => {
  const v = findProRatingViolations(GRADE_40.components);
  assert.equal(v.length, 2);
  assert.match(v[0], /Mason/);
  assert.match(v[0], /not pro-rated/);
  assert.match(v[1], /Headman/);
});

test("pro-rating: accepts a unit that already carries the division", () => {
  // "hr/m3" is 0.24 hours per m3 — already pro-rated.
  const v = findProRatingViolations([
    { name: "Poker vibrator", quantity: 0.24, unit: "hr/m3" },
    { name: "Mixing crew", quantity: 0.126, unit: "day" },
  ]);
  assert.deepEqual(v, []);
});

test("pro-rating: accepts materials measured in bags or m3", () => {
  const v = findProRatingViolations([
    { name: "Cement", quantity: 9.2, unit: "bag" },
    { name: "Sand", quantity: 0.45, unit: "m3" },
  ]);
  assert.deepEqual(v, []);
});

test("sanity: flags a rate several times the closest library rate", () => {
  const v = findSanityViolations(GRADE_40, CANDIDATES);
  assert.ok(v.some((m) => /is 3\.1x the median of/.test(m)), v.join(" | "));
});

test("sanity: flags a single component dearer than the whole library rate", () => {
  const v = findSanityViolations(GRADE_40, CANDIDATES);
  assert.ok(v.some((m) => /"Cement" alone costs/.test(m)), v.join(" | "));
});

test("sanity: flags a suspiciously cheap rate too", () => {
  const v = findSanityViolations(
    { unit: "m3", rateNgn: 20000, components: [] },
    CANDIDATES,
  );
  assert.ok(v.some((m) => /only 13% of the median of/.test(m)), v.join(" | "));
});

test("sanity: passes a plausible rate", () => {
  const v = findSanityViolations(
    {
      unit: "m3",
      rateNgn: 186045,
      components: [{ name: "Cement", totalNgn: 93840 }],
    },
    CANDIDATES,
  );
  assert.deepEqual(v, []);
});

test("sanity: never compares across different units", () => {
  // An m3 rate must not be measured against an m2 candidate.
  const v = findSanityViolations(
    { unit: "m3", rateNgn: 460397, components: [] },
    [{ description: "Blockwork 225mm", unit: "m2", totalCost: 12000, matchScore: 0.9 }],
  );
  assert.deepEqual(v, []);
});

test("sanity: silent when the library offers nothing comparable", () => {
  assert.deepEqual(findSanityViolations(GRADE_40, []), []);
});

// The real candidate set for "concrete grade 40". Two rates tie on matchScore
// at 0.50 — a grade 30 water-logged repair at N707,670 and the actual grade 40
// at N413,957 — so picking the top scorer moved the yardstick by 70% on an
// arbitrary tie-break. The median is stable.
const REAL_CONCRETE_CANDIDATES = [
  { description: "Concrete (1:1:2) grade 30 for repair works in water logged area", unit: "m3", totalCost: 707670.68, matchScore: 0.5 },
  { description: "Concrete (1:1/4:1/2) grade 40 in foundation or slab.", unit: "m3", totalCost: 413957.6, matchScore: 0.5 },
  { description: "Concrete (1:4:8) grade 10 in foundation or slab.", unit: "m3", totalCost: 179183.27, matchScore: 0.33 },
  { description: "Concrete (1:2:4) grade 20 in column, wall or suspended floor", unit: "m3", totalCost: 177501.59, matchScore: 0.33 },
  { description: "Concrete (1:4:5) grade 35 in suspended slab or wall.", unit: "m3", totalCost: 128733.98, matchScore: 0.33 },
];

test("sanity: a real grade 40 rate passes against the real candidate set", () => {
  // N380,152 is what the service actually returned once pro-rating was right,
  // and the library's own grade 40 is N413,958. That must not be flagged.
  const v = findSanityViolations(
    { unit: "m3", rateNgn: 380151.81, components: [] },
    REAL_CONCRETE_CANDIDATES,
  );
  assert.deepEqual(v, []);
});

test("sanity: the yardstick ignores an outlier candidate", () => {
  // Median of the five is N179,183 — not the N707,670 repair-works outlier that
  // won the match-score tie-break.
  const v = findSanityViolations(
    { unit: "m3", rateNgn: 179183, components: [] },
    REAL_CONCRETE_CANDIDATES,
  );
  assert.deepEqual(v, []);
  assert.match(
    findSanityViolations({ unit: "m3", rateNgn: 5_000_000, components: [] }, REAL_CONCRETE_CANDIDATES)[0],
    /median of 5 comparable library rates/,
  );
});

test("provisionalBuild: derives the rate from the model's own numbers", () => {
  const b = provisionalBuild({
    unit: "m3",
    overheadPercent: 10,
    profitPercent: 25,
    components: [{ name: "Cement", quantity: 24, unit: "bag/m3", unitPriceNgn: 10200 }],
  });
  assert.equal(b.components[0].totalNgn, 244800);
  assert.equal(b.rateNgn, 244800 * 1.35);
});

test("checkBuildup: the grade 40 build-up fails, and would have escalated", () => {
  const failures = checkBuildup(GRADE_40, CANDIDATES);
  assert.ok(failures.length >= 3, failures.join(" | "));
});

test("checkBuildup: a clean build-up passes", () => {
  const clean = {
    unit: "m3",
    rateNgn: 186045,
    components: [
      { name: "Cement", quantity: 9.2, unit: "bag/m3", totalNgn: 93840 },
      { name: "Placing crew", quantity: 0.126, unit: "day", totalNgn: 2198 },
    ],
  };
  assert.deepEqual(checkBuildup(clean, CANDIDATES), []);
});
