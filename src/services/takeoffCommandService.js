import { invokeJson } from "../clients/bedrock.js";
import { pickModel } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";

// Natural-language takeoff commands for QUIV ("generate the entire beam and
// slab quantity for first floor"). The model only PARSES INTENT — it maps the
// prompt onto the caller-supplied module keys and level names. All measuring
// is done by the plugin against real Revit geometry; the AI never invents a
// quantity.
//
// context: { modules: ["BeamQty","SlabQty",...], levels: ["Ground Floor",...],
//            automatable: ["BeamQty","SlabQty"] }
export async function takeoffCommand({ tenantId, product, prompt, context }) {
  const ctx = {
    modules: (context?.modules || []).slice(0, 60),
    levels: (context?.levels || []).slice(0, 120),
    automatable: (context?.automatable || []).slice(0, 60),
  };

  return runFeature({
    tenantId,
    product,
    feature: "takeoffCommand",
    input: { prompt: prompt.trim().toLowerCase(), ctx },
    compute: async () => {
      const { modelId } = pickModel("classification");
      const { json } = await invokeJson(
        { tenantId, product, feature: "takeoffCommand", operation: "parse" },
        {
          modelId,
          maxTokens: 1200,
          system: SYSTEM_PROMPT,
          user: JSON.stringify({ prompt, ...ctx }),
        }
      );

      // Hard validation: every module/level the model returns must exist in
      // the context it was given. Anything else is dropped and reported.
      const dropped = [];
      const actions = (json.actions || []).filter((a) => {
        const okModule = ctx.modules.includes(a.module);
        const okLevel = !a.level || a.level === "All Floors" || ctx.levels.includes(a.level);
        if (!okModule || !okLevel) dropped.push(a);
        return okModule && okLevel;
      });

      return {
        model: modelId,
        confidence: json.confidence ?? 0.7,
        result: {
          actions: actions.map((a) => ({
            module: a.module,
            level: a.level || "All Floors",
            type: a.type || "All",
            automatable: ctx.automatable.includes(a.module),
          })),
          saveTo: Array.isArray(json.saveTo) && json.saveTo.length ? json.saveTo : ["takeoff", "budget"],
          reply: json.reply || "",
          unsupported: [...(json.unsupported || []), ...dropped.map((d) => `${d.module || "?"} (${d.level || "?"})`)],
        },
      };
    },
  });
}

const SYSTEM_PROMPT = `You parse a quantity surveyor's natural-language request into structured takeoff commands for QUIV, a Revit quantity-takeoff plugin.

You are given:
- "modules": the ONLY valid module keys (e.g. BeamQty, SlabQty, ColumnQty, WallQty...).
- "levels": the ONLY valid level names in the open Revit model.
- "automatable": modules the assistant can run end-to-end today.

Rules:
- Map the request onto modules and levels EXACTLY as spelled in the lists. Never invent a module or level.
- "first floor" style phrases must be matched to the closest real level name from "levels" (e.g. "First Floor", "1st Floor Level"). If nothing matches, use "All Floors" and mention it in reply.
- A request covering a whole element class maps type to "All".
- If the user asks for something outside the module list, put a short human label for it in "unsupported".
- saveTo: include "takeoff" and/or "budget" per the request; default both.
- reply: one or two friendly sentences summarising what will happen, written to a QS.

Return JSON:
{"actions":[{"module":"BeamQty","level":"<exact level or All Floors>","type":"All"}],"saveTo":["takeoff","budget"],"unsupported":[],"reply":"...","confidence":0.0}`;
