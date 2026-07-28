import { recordExamples } from "../grounding/qsProfile.js";

// Records what a QS did with the suggestions they were shown, so the next review
// reflects their judgement rather than repeating it back at them.
//
// Not a runFeature feature, deliberately:
//   - it calls no model, so there is nothing to meter, cache or escalate
//   - it must not consume quota. Charging a user for telling us we were wrong
//     is the wrong incentive, and it would make the honest ones pay most
//   - it must not fail the user's Apply. The bill edit already happened
//     client-side; a profile write that errors is our problem, not theirs
//
// decisions: [{ kind, source, proposed, unit, section, accepted }]
const MAX_DECISIONS = 200;

export async function billFeedback({ tenantId, decisions }) {
  const list = (Array.isArray(decisions) ? decisions : []).slice(0, MAX_DECISIONS);

  const examples = list
    .map((d) => {
      const proposed = String(d.proposed || "").trim();
      if (!proposed) return null;

      // Only wording decisions teach house style. A rate flag being accepted
      // says the rate needed a look, not that this is how the firm writes.
      const kind = String(d.kind || "").toLowerCase();
      if (!["description", "unit"].includes(kind)) return null;

      return {
        source: String(d.source || "").trim(),
        accepted: proposed,
        unit: String(d.unit || "").trim(),
        section: String(d.section || "").trim(),
        origin: d.accepted ? "aiAccepted" : "aiRejected",
      };
    })
    .filter(Boolean);

  // Same { ok, result } envelope as every other feature, so one client-side
  // unwrap works for all of them.
  if (!examples.length) {
    return { ok: true, result: { recorded: 0, accepted: 0, rejected: 0, profileRevision: 0 } };
  }

  const profile = await recordExamples(tenantId, { examples });

  return {
    ok: true,
    result: {
      recorded: examples.length,
      accepted: examples.filter((e) => e.origin === "aiAccepted").length,
      rejected: examples.filter((e) => e.origin === "aiRejected").length,
      profileRevision: profile ? profile.revision : 0,
    },
  };
}
