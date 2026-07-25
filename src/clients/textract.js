import {
  TextractClient,
  AnalyzeDocumentCommand,
} from "@aws-sdk/client-textract";
import { config } from "../config/index.js";
import { meterAiCall } from "../governance/meterAiCall.js";

const client = new TextractClient({ region: config.awsRegion });

// Metered synchronous table/form extraction for a single-page image or PDF page.
// meta: { tenantId, product, feature }. Returns { blocks, costUsd }.
export async function analyzePage(meta, { bytes }) {
  const { result, costUsd } = await meterAiCall(
    { ...meta, service: "textract", model: "analyze-document", operation: "AnalyzeDocument" },
    async () => {
      const out = await client.send(
        new AnalyzeDocumentCommand({
          Document: { Bytes: bytes },
          FeatureTypes: ["TABLES", "FORMS"],
        })
      );
      return { result: out.Blocks || [], units: { pages: 1 } };
    }
  );
  return { blocks: result, costUsd };
}

// Reduces Textract blocks to a compact text/table representation the model
// can classify cheaply, instead of shipping raw block JSON into the prompt.
export function blocksToTables(blocks) {
  const byId = new Map(blocks.map((b) => [b.Id, b]));
  const tables = [];
  for (const block of blocks) {
    if (block.BlockType !== "TABLE") continue;
    const cells = [];
    for (const rel of block.Relationships || []) {
      if (rel.Type !== "CHILD") continue;
      for (const id of rel.Ids) {
        const cell = byId.get(id);
        if (cell?.BlockType !== "CELL") continue;
        const words = [];
        for (const cRel of cell.Relationships || []) {
          if (cRel.Type !== "CHILD") continue;
          for (const wid of cRel.Ids) {
            const w = byId.get(wid);
            if (w?.BlockType === "WORD") words.push(w.Text);
          }
        }
        cells.push({ row: cell.RowIndex, col: cell.ColumnIndex, text: words.join(" ") });
      }
    }
    const rows = [];
    for (const c of cells) {
      rows[c.row - 1] = rows[c.row - 1] || [];
      rows[c.row - 1][c.col - 1] = c.text;
    }
    tables.push(rows);
  }
  const lines = blocks
    .filter((b) => b.BlockType === "LINE")
    .map((b) => b.Text)
    .join("\n");
  return { tables, lines };
}
