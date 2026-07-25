import { analyzePage, blocksToTables } from "../clients/textract.js";
import { invokeJson } from "../clients/bedrock.js";
import { pickModel } from "../governance/modelRouter.js";
import { runFeature } from "./featurePipeline.js";

// Supplier catalogue extraction and mapping. Generalises the Builders Konnect
// PoC: Textract extracts document structure (tables + lines), the cheap model
// tier classifies products and maps them to the caller-supplied taxonomy, and
// the response is rows ready for a bulk-upload template.
//
// Input: pages: [{ bytes (base64), mime }] — callers (incl. the BK PoC) send
// rasterized pages or single-page PDFs. taxonomy: array of category paths.
export async function catalogueExtract({ tenantId, product, pages, taxonomy, templateColumns }) {
  const pageList = (pages || []).slice(0, 25);

  return runFeature({
    tenantId,
    product,
    feature: "catalogueExtract",
    input: {
      pageHashes: pageList.map((p) => p.bytes.slice(0, 64)),
      taxonomy: taxonomy || [],
      templateColumns: templateColumns || [],
    },
    compute: async () => {
      // 1. Structure extraction — Textract, metered per page.
      const extracted = [];
      for (const page of pageList) {
        const bytes = Buffer.from(page.bytes, "base64");
        const { blocks } = await analyzePage({ tenantId, product, feature: "catalogueExtract" }, { bytes });
        extracted.push(blocksToTables(blocks));
      }

      // 2. Classification + taxonomy mapping — cheap tier, one call per page.
      const { modelId } = pickModel("catalogueMapping");
      const rows = [];
      for (const [i, pageContent] of extracted.entries()) {
        const { json } = await invokeJson(
          { tenantId, product, feature: "catalogueExtract", operation: "classify-map" },
          {
            modelId,
            maxTokens: 4000,
            system: mappingPrompt(taxonomy, templateColumns),
            user: JSON.stringify({ page: i + 1, tables: pageContent.tables, text: pageContent.lines.slice(0, 8000) }),
          }
        );
        for (const r of json.products || []) {
          rows.push({
            page: i + 1,
            name: r.name || "",
            code: r.code || "",
            brand: r.brand || "",
            taxonomyPath: r.taxonomyPath || "",
            taxonomyConfidence: clamp01(r.taxonomyConfidence ?? 0.5),
            priceNgn: r.priceNgn ?? null,
            unit: r.unit || "",
            attributes: r.attributes || {},
            templateRow: r.templateRow || {},
            disposition: clamp01(r.taxonomyConfidence ?? 0.5) >= 0.7 ? "PASS" : "REVIEW",
          });
        }
      }

      return {
        model: modelId,
        confidence: rows.length
          ? rows.reduce((s, r) => s + r.taxonomyConfidence, 0) / rows.length
          : 0.5,
        result: {
          pagesProcessed: pageList.length,
          productCount: rows.length,
          pass: rows.filter((r) => r.disposition === "PASS").length,
          review: rows.filter((r) => r.disposition === "REVIEW").length,
          products: rows,
        },
      };
    },
  });
}

function mappingPrompt(taxonomy, templateColumns) {
  return `You classify supplier catalogue content extracted by OCR into structured product records for a Nigerian construction-materials marketplace.

Target taxonomy paths (choose the closest; never invent a path):
${JSON.stringify(taxonomy || [])}

Bulk-upload template columns (fill templateRow keyed by these exact column names where the data supports it):
${JSON.stringify(templateColumns || [])}

Rules:
- One record per distinct product/variant found in the tables and text.
- Prices are NGN numbers without separators; null when absent. Never guess prices.
- taxonomyConfidence reflects how certain the taxonomy mapping is.

Return JSON:
{"products": [{"name": "", "code": "", "brand": "", "taxonomyPath": "", "taxonomyConfidence": 0.0, "priceNgn": null, "unit": "", "attributes": {}, "templateRow": {}}]}`;
}

const clamp01 = (n) => Math.max(0, Math.min(1, Number(n) || 0));
