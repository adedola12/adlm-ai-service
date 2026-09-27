// Round-trips a tenant QS profile through the real TenantQsProfile schema
// without a database: findOne and save are stubbed, but save still runs
// Mongoose validation, which is where "Cast to Map failed" was thrown.
//
//   npm test
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { TenantQsProfile } from "../src/models/index.js";
import { recordExamples, houseStyleBlock } from "../src/grounding/qsProfile.js";
import { billFeedback } from "../src/services/billFeedbackService.js";

const TENANT = "tenant-under-test";
let stored; // what "Mongo" holds, as a plain object

beforeEach(() => {
  stored = null;
  TenantQsProfile.findOne = async ({ tenantId }) =>
    stored && stored.tenantId === tenantId ? TenantQsProfile.hydrate(JSON.parse(JSON.stringify(stored))) : null;
  TenantQsProfile.prototype.save = async function () {
    await this.validate();
    stored = this.toObject({ flattenMaps: true });
    return this;
  };
});

const block = { source: "225 blockwork", accepted: "Blockwork in 225mm hollow sandcrete blocks", unit: "m2", origin: "aiAccepted" };
const concrete = { source: "conc", accepted: "Concrete grade C25 in beams", unit: "m3", origin: "specification" };

test("a new profile with an empty unitConventions saves", async () => {
  const saved = await recordExamples(TENANT, { sectionOrder: ["Substructure"] });
  assert.equal(saved.revision, 1);
  assert.deepEqual(stored.unitConventions, {});
  assert.deepEqual(stored.sectionOrder, ["Substructure"]);
});

test("an existing empty unitConventions survives a second save", async () => {
  await recordExamples(TENANT, { sectionOrder: ["Substructure"] });
  // Second write loads a hydrated doc whose unitConventions is an empty Mongoose Map.
  await recordExamples(TENANT, { sectionOrder: ["Frame"] });
  assert.deepEqual(stored.unitConventions, {});
  assert.equal(stored.revision, 2);
});

test("a non-empty unitConventions round-trips and keeps earlier entries", async () => {
  await recordExamples(TENANT, { examples: [block] });
  assert.deepEqual(stored.unitConventions, { blockwork: "m2" });

  // Loaded back as a Mongoose Map — the case that used to throw.
  const saved = await recordExamples(TENANT, { examples: [concrete] });
  assert.deepEqual(stored.unitConventions, { blockwork: "m2", concrete: "m3" });
  assert.equal(saved.revision, 2);
  assert.ok(!Object.keys(stored.unitConventions).some((k) => k.startsWith("$")));
});

test("houseStyleBlock lists units from both a lean and a hydrated profile", async () => {
  await recordExamples(TENANT, { examples: [block, concrete] });

  const lean = houseStyleBlock(stored);
  const hydrated = houseStyleBlock(await TenantQsProfile.findOne({ tenantId: TENANT }));
  for (const text of [lean, hydrated]) {
    assert.match(text, /- blockwork: m2/);
    assert.match(text, /- concrete: m3/);
    assert.doesNotMatch(text, /\$__/);
  }
});

test("bill feedback records against an existing profile instead of failing", async () => {
  await recordExamples(TENANT, { examples: [block] });
  const res = await billFeedback({
    tenantId: TENANT,
    decisions: [
      { kind: "description", proposed: "Concrete grade C25 in slabs", unit: "m3", accepted: true },
      { kind: "description", proposed: "Blockwork generally", accepted: false },
    ],
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.result, { recorded: 2, accepted: 1, rejected: 1, profileRevision: 2 });
  assert.deepEqual(stored.unitConventions, { blockwork: "m2", concrete: "m3" });
  assert.deepEqual(stored.rejectedPhrases, ["Blockwork generally"]);
});

test("bill feedback does not fail the caller when the profile write does", async () => {
  TenantQsProfile.prototype.save = async () => {
    throw new Error("write refused");
  };
  const res = await billFeedback({
    tenantId: TENANT,
    decisions: [{ kind: "description", proposed: "Anything", accepted: true }],
  });
  assert.equal(res.ok, true);
  assert.equal(res.result.recorded, 0);
});
