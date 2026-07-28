import mongoose from "mongoose";
import { MongoClient } from "mongodb";
import { config } from "../config/index.js";

// ── AI service database (read-write) ─────────────────────────────────────────
// Own logical database on the shared cluster. Zero shared collections with
// ADLM Cloud: entitlements are verified via licence JWT / ADLM Cloud API,
// never by joining adlmWeb collections.
let connected = false;
export async function connectAiDb() {
  if (connected) return mongoose.connection;
  await mongoose.connect(config.mongoUri, {
    dbName: config.aiDb,
    serverSelectionTimeoutMS: 10000,
  });
  connected = true;
  return mongoose.connection;
}

// ── Grounding data (read-only) ───────────────────────────────────────────────
// Raw driver clients for the RateGen library. Reads only — the AI service
// must never write to adlmWeb or ADLMRateDB.
//
// The zone-priced master library lives on the RateGen ADMIN cluster
// (RATEGEN_MONGO_URI — same value the website's /rategen/master routes use).
// When unset, falls back to the main cluster.
let client = null;
async function groundingClient() {
  if (!client) {
    client = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 10000 });
    await client.connect();
  }
  return client;
}

let rategenClient = null;
async function rategenMasterClient() {
  if (!config.rategenMongoUri) return groundingClient();
  if (!rategenClient) {
    rategenClient = new MongoClient(config.rategenMongoUri, { serverSelectionTimeoutMS: 10000 });
    await rategenClient.connect();
  }
  return rategenClient;
}

export async function groundingDb() {
  return (await groundingClient()).db(config.groundingDb);
}

export async function rategenMasterDb() {
  return (await rategenMasterClient()).db(config.rategenMasterDb);
}
