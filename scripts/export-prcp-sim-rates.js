// READ ONLY. Pulls real MEP material and labour rates out of the RateGen master
// library so the NIQS PRCP simulation extract can be built from genuine numbers.
//
//   node scripts/export-prcp-sim-rates.js > ../../prcp-sim-rates.json
//
// There is no --apply. This script cannot write to the library.
//
// WHY: the simulation asks participants to find deliberately seeded defects in a
// rate extract. That only teaches anything if every rate they DO NOT flag is
// genuinely defensible. Inventing the whole sheet would mean the correct rates
// were as arbitrary as the wrong ones, and a sharp inductee would sense it.
// So the clean lines come from the library and only the seeded lines are edited.
//
// south_west only: the exercise is priced as Lagos, and the zone factors are a
// separate lesson that would muddy this one.
import "dotenv/config";
import { MongoClient } from "mongodb";
import { config } from "../src/config/index.js";

const client = new MongoClient(process.env.RATEGEN_MONGO_URI);
await client.connect();
const db = client.db(config.rategenMasterDb);

const mats = await db
  .collection(config.rategenMatCollection || "Materials")
  .find({ zone: "south_west" }, { projection: { _id: 0 } })
  .toArray();
const labs = await db
  .collection(config.rategenLabCollection || "labours")
  .find({ zone: "south_west" }, { projection: { _id: 0 } })
  .toArray();

// Anything plumbing, electrical or mechanical. Deliberately broad: it is easier
// to narrow a list by eye than to discover a category name was missed.
const WANT =
  /pipe|pvc|upvc|ppr|conduit|cable|wire|socket|switch|bend|tee|elbow|coupler|union|valve|gully|trap|cistern|closet|basin|sink|shower|tank|pump|air.?cond|split|fan|camera|cctv|db |distribution board|breaker|mcb|light|lamp|fitting|solvent|tangit|clip|bracket|hanger|insulat/i;

const pick = (rows, nameKey, priceKey, unitKey, catKey) =>
  rows
    .filter((r) => WANT.test(String(r[nameKey] || "")) && Number(r[priceKey]) > 0)
    .map((r) => ({
      name: String(r[nameKey]).trim(),
      unit: String(r[unitKey] || "").trim(),
      price: Number(r[priceKey]),
      category: String(r[catKey] || "").trim(),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

const out = {
  source: `${config.rategenMasterDb} (south_west)`,
  materials: pick(mats, "MaterialName", "MaterialPrice", "MaterialUnit", "MaterialCategory"),
  labours: pick(labs, "LabourName", "LabourPrice", "LabourUnit", "LabourCategory"),
  counts: { materialsTotal: mats.length, laboursTotal: labs.length },
};
out.counts.materialsMatched = out.materials.length;
out.counts.laboursMatched = out.labours.length;

console.log(JSON.stringify(out, null, 1));
await client.close();
