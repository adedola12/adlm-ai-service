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
  // typesByModule is what makes "separate all wall types" answerable. Without it the
  // model has no type names to split by and can only ever emit type "All", which is
  // exactly what a floor-by-floor, type-by-type request came back as.
  const rawTypes = context?.typesByModule || {};
  const typesByModule = {};
  for (const key of Object.keys(rawTypes).slice(0, 60)) {
    const list = (rawTypes[key] || []).filter((t) => typeof t === "string" && t.trim()).slice(0, 80);
    if (list.length) typesByModule[key] = list;
  }

  const ctx = {
    modules: (context?.modules || []).slice(0, 60),
    levels: (context?.levels || []).slice(0, 120),
    automatable: (context?.automatable || []).slice(0, 60),
    typesByModule,
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
          // Raised for expansion: a floor-by-floor, type-by-type request on a six-level
          // model with five wall types is 30 actions, which does not fit in 1200 and would
          // be silently truncated into a partial takeoff.
          maxTokens: 8000,
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
        // Types are validated the same way levels always were. A hallucinated type name
        // would drive the module's dropdown to something that does not exist, and the
        // plugin would measure nothing while reporting success.
        const known = ctx.typesByModule[a.module];
        const okType =
          !a.type ||
          a.type === "All" ||
          !known ||
          known.some((t) => t.toLowerCase() === String(a.type).toLowerCase());
        if (!okModule || !okLevel || !okType) dropped.push(a);
        return okModule && okLevel && okType;
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
- "typesByModule": the ONLY valid element type names per module, e.g. {"WallQty":["100 WALL","230 WALL"]}.

Rules:
- Map the request onto modules, levels and types EXACTLY as spelled in the lists. Never invent a module, level or type.
- "first floor" style phrases must be matched to the closest real level name from "levels" (e.g. "First Floor", "1st Floor Level"). If nothing matches, use "All Floors" and mention it in reply.
- If the user asks for something outside the module list, put a short human label for it in "unsupported".
- saveTo: include "takeoff" and/or "budget" per the request; default both.
- reply: one or two friendly sentences summarising what will happen, written to a QS.

EXPANSION. One action measures ONE module at ONE level for ONE type. When the user asks
for a breakdown, emit the full cross-product instead of collapsing it:
- "floor by floor", "per floor", "each level", "level by level", "separate the floors"
  -> one action PER real level name in "levels". Do NOT use "All Floors" for these.
- "separate all wall types", "by type", "each type", "split the types"
  -> one action PER type name in typesByModule for that module. Do NOT use "All" for these.
- Both together -> one action for every level and type combination, so five levels and
  three wall types is fifteen actions.
- Only when the user does NOT ask for a breakdown do you use "All Floors" and "All".
- Emit the actions even when there are many; do not summarise or truncate the list.

SCOPE. Measure exactly the elements the user named and nothing else. If they ask for
walls, doors and windows, do not add beams, columns, slabs, roofs or finishes. Extra
modules cost the user time and put work on their bill that they did not ask for.

Return JSON. This example shows an expanded request ("walls floor by floor, separate the types"):
{"actions":[{"module":"WallQty","level":"01 GROUND FLOOR","type":"100 WALL"},{"module":"WallQty","level":"01 GROUND FLOOR","type":"230 WALL"},{"module":"WallQty","level":"02 FIRST FLOOR","type":"100 WALL"},{"module":"WallQty","level":"02 FIRST FLOOR","type":"230 WALL"}],"saveTo":["takeoff","budget"],"unsupported":[],"reply":"...","confidence":0.0}

An unexpanded request ("total wall quantity") is a single action:
{"actions":[{"module":"WallQty","level":"All Floors","type":"All"}],"saveTo":["takeoff","budget"],"unsupported":[],"reply":"...","confidence":0.0}`;
