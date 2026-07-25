// Seeds the PricingRate store with starting unit prices. Prices are CONFIG,
// never code — verify against the current Bedrock/Textract price pages and
// adjust via PATCH /api/ai/admin/pricing-rates/:id.
import "dotenv/config";
import mongoose from "mongoose";
import { config } from "../src/config/index.js";
import { PricingRate, CreditAccount } from "../src/models/index.js";

const SEED = [
  // Anthropic on Bedrock — verify against https://aws.amazon.com/bedrock/pricing/
  { service: "bedrock", model: config.models.cheap, unit: "input_mtok", priceUsd: 1.0 },
  { service: "bedrock", model: config.models.cheap, unit: "output_mtok", priceUsd: 5.0 },
  { service: "bedrock", model: config.models.strong, unit: "input_mtok", priceUsd: 3.0 },
  { service: "bedrock", model: config.models.strong, unit: "output_mtok", priceUsd: 15.0 },
  // Textract AnalyzeDocument with TABLES+FORMS — verify against AWS pricing
  { service: "textract", model: "analyze-document", unit: "page", priceUsd: 0.065 },
];

await mongoose.connect(config.mongoUri, { dbName: config.aiDb });

for (const row of SEED) {
  await PricingRate.updateOne(
    { service: row.service, model: row.model, unit: row.unit },
    { $setOnInsert: { ...row, updatedAt: new Date() } },
    { upsert: true }
  );
}
console.log(`Seeded ${SEED.length} pricing rates (existing rows untouched).`);

await CreditAccount.updateOne(
  { provider: "aws-activate" },
  {
    $setOnInsert: {
      totalUsd: config.credit.totalUsd,
      startDate: new Date(config.credit.startDate),
      expiryDate: new Date(config.credit.expiryDate),
      guardThreshold: config.credit.guardThreshold,
      updatedAt: new Date(),
    },
  },
  { upsert: true }
);
console.log("Credit account ensured.");

await mongoose.disconnect();
