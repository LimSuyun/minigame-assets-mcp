/**
 * design-sheet.ts — 디자인 시트 기반 세트 생성 도구
 *
 * 원리: 여러 아이템을 별도 호출로 만들면 일관성이 새지만, 한 장의 시트 안에서
 * 함께 생성하면 상호 비례·형태 언어·팔레트가 생성 시점에 통일된다.
 * (스프라이트 grid 모드, 캐릭터 3면도와 같은 메커니즘의 일반화)
 *
 * 흐름: canon 스타일 참조 → 시트 1회 생성(크로마 배경) → 연결 성분 검출
 *       → 개수 검증(불일치 시 1회 재생성) → 슬라이스 → 크로마 제거 → 개별 저장.
 *
 * 도구:
 *   - asset_generate_design_sheet
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { editImageOpenAI } from "../services/openai.js";
import { getCanonEntry, registerCanonEntry, generateCanonId } from "../utils/canon.js";
import { detectSheetComponents, sliceSheetComponents } from "../utils/sheet-slicer.js";
import { saveBase64File, buildAssetPath, ensureDir, saveAssetToRegistry, generateAssetId } from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GeneratedAsset } from "../types.js";

const CHROMA_MAGENTA: [number, number, number] = [255, 0, 255];

function buildSheetPrompt(params: {
  styleNote: string;
  items: Array<{ id: string; description: string }>;
  itemNoun: string;
  viewNote: string;
}): string {
  const n = params.items.length;
  const topCount = Math.ceil(n / 2);
  const layoutNote = n <= 4
    ? `arranged in ONE row of ${n}`
    : `arranged in a neat grid — ${topCount} in the top row, ${n - topCount} in the bottom row`;

  const itemLines = params.items
    .map((it, i) => `(${i + 1}) ${it.id.replace(/_/g, " ")} — ${it.description}`)
    .join("; ");

  return [
    `Using the exact art style of this reference image (${params.styleNote}):`,
    `a game asset CONCEPT DESIGN SHEET showing ${n} distinct ${params.itemNoun} ${layoutNote},`,
    `all at the SAME uniform scale, ${params.viewNote}, generous magenta spacing between them so no two items touch.`,
    `Items in order: ${itemLines}.`,
    `Each item fully isolated on solid flat magenta (#FF00FF) background,`,
    `strong readable silhouettes designed to stay recognizable at small game sizes,`,
    `consistent shared proportions and design language across all ${n} items.`,
    `No text, no labels, no numbers, no watermarks.`,
  ].join(" ");
}

export function registerDesignSheetTools(server: McpServer): void {
  server.registerTool(
    "asset_generate_design_sheet",
    {
      title: "Generate Design Sheet & Slice into Assets",
      description: `Generate ONE concept design sheet containing multiple items (buildings, icons, props, character views),
then auto-slice it into individual transparent assets.

Why: items generated together in a single image share proportions, silhouette language, and palette for free —
separate per-item calls drift. This is the same mechanism as sprite grid mode / character turnaround sheets, generalized.
Verified: 7-building set at 1/7th the cost of per-item generation, with better set consistency.

Flow: canon style reference → 1 edit-API sheet generation (magenta background) → connected-component detection
→ count validation (1 auto-retry on mismatch) → slice → chroma removal → save each item.

Args:
  - canon_id (string): Canon entry used as the style reference
  - sheet_name (string): Sheet file name (also used for canon registration)
  - items (array): 2-12 items, each { id, description }. Order = top-left → bottom-right on the sheet.
  - item_noun (string, optional): What the items are, plural (default: "game objects"; e.g. "Joseon village buildings", "resource icons", "full-body character views")
  - view_note (string, optional): Camera/view instruction (default: "same three-quarter top-down camera angle")
  - item_type (string, optional): Output asset category dir (default: "prop")
  - slice_max_size (number, optional): Max px of sliced assets (default: 256)
  - register_sheet_as_canon (boolean, optional): Register the sheet as a Canon entry (default: true)
  - edit_model (string, optional): OpenAI edit model (default: "gpt-image-2")
  - output_dir (string, optional): Output directory

Returns:
  Sheet path + per-item sliced file paths (+ retry/mismatch info).
  If component count still mismatches after retry, returns sliced=false with the sheet path so the caller can slice manually.`,
      inputSchema: z.object({
        canon_id: z.string().min(1).describe("Canon entry ID for style reference"),
        sheet_name: z.string().min(1).max(120).describe("Sheet name (file/canon name)"),
        items: z.array(z.object({
          id: z.string().min(1).max(80).describe("Item ID (output file name)"),
          description: z.string().min(3).max(500).describe("Visual description"),
        })).min(2).max(12).describe("Items to include, in sheet order"),
        item_noun: z.string().max(120).default("game objects").describe("Plural noun for the items"),
        view_note: z.string().max(200).default("same three-quarter top-down camera angle").describe("Camera/view instruction"),
        item_type: z.string().max(40).default("prop").describe("Asset category for outputs"),
        slice_max_size: z.number().int().min(64).max(1024).default(256).describe("Max px of sliced assets"),
        register_sheet_as_canon: z.boolean().default(true).describe("Register sheet as Canon"),
        edit_model: z.string().default("gpt-image-2").describe("OpenAI edit model"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const canon = getCanonEntry(params.canon_id, outputDir);
        if (!canon) {
          return { content: [{ type: "text" as const, text: `Canon 엔트리를 찾을 수 없습니다: ${params.canon_id}` }], isError: true };
        }
        if (!fs.existsSync(canon.file_path)) {
          return { content: [{ type: "text" as const, text: `Canon 파일을 찾을 수 없습니다: ${canon.file_path}` }], isError: true };
        }

        const prompt = buildSheetPrompt({
          styleNote: canon.art_style || "match the reference style exactly",
          items: params.items,
          itemNoun: params.item_noun,
          viewNote: params.view_note,
        });

        const safeSheetName = params.sheet_name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const sheetPath = buildAssetPath(outputDir, "concept", `${safeSheetName}.png`);
        ensureDir(path.dirname(sheetPath));

        // 시트 생성 + 성분 수 검증 (불일치 시 1회 재생성)
        let boxes: Awaited<ReturnType<typeof detectSheetComponents>> = [];
        let attempts = 0;
        let countMatched = false;
        while (attempts < 2) {
          attempts++;
          const result = await editImageOpenAI({
            imagePath: path.resolve(canon.file_path),
            prompt,
            model: params.edit_model as "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
          });
          saveBase64File(result.base64, sheetPath);
          boxes = await detectSheetComponents(sheetPath, {
            chromaColor: CHROMA_MAGENTA,
            expectedCount: params.items.length,
            minArea: 1000,
          });
          if (boxes.length === params.items.length) { countMatched = true; break; }
          console.warn(`[design-sheet] 성분 ${boxes.length}개 ≠ 요청 ${params.items.length}개 (시도 ${attempts})`);
        }

        // 시트 canon 등록
        let sheetCanonId: string | undefined;
        if (params.register_sheet_as_canon) {
          sheetCanonId = generateCanonId("other", safeSheetName);
          registerCanonEntry({
            id: sheetCanonId,
            name: params.sheet_name,
            type: "other",
            file_path: sheetPath,
            file_name: path.basename(sheetPath),
            description: `디자인 시트 (${params.items.length} items) — canon ${params.canon_id} 스타일 참조로 생성`,
            art_style: canon.art_style,
            tags: ["design_sheet", params.item_type],
            created_at: new Date().toISOString(),
            metadata: { source_canon: params.canon_id, items: params.items.map((i) => i.id) },
          }, outputDir);
        }

        if (!countMatched) {
          const output = {
            success: false,
            sliced: false,
            reason: `성분 수 불일치: ${boxes.length}개 검출 ≠ ${params.items.length}개 요청 (재생성 1회 포함). 시트는 저장됨 — 수동 슬라이스 또는 items 조정 후 재시도.`,
            sheet_path: sheetPath,
            detected_components: boxes.length,
            ...(sheetCanonId ? { sheet_canon_id: sheetCanonId } : {}),
          };
          return {
            content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
            structuredContent: output,
          };
        }

        // 슬라이스 → 개별 저장
        const sliced = await sliceSheetComponents(sheetPath, boxes, {
          chromaColor: CHROMA_MAGENTA,
          maxSize: params.slice_max_size,
        });

        const itemResults: Array<{ id: string; file_path: string; width: number; height: number }> = [];
        for (let i = 0; i < sliced.length; i++) {
          const item = params.items[i];
          const filePath = buildAssetPath(outputDir, params.item_type, `${item.id}.png`);
          ensureDir(path.dirname(filePath));
          fs.writeFileSync(filePath, sliced[i].buffer);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: params.item_type,
            provider: "openai/edit+sheet-slice",
            prompt: item.description,
            file_path: filePath,
            file_name: path.basename(filePath),
            mime_type: "image/png",
            created_at: new Date().toISOString(),
            metadata: { design_sheet: sheetPath, sheet_canon: sheetCanonId, slice_index: i },
          };
          saveAssetToRegistry(asset, outputDir);

          const b = sliced[i].box;
          itemResults.push({ id: item.id, file_path: filePath, width: b.x1 - b.x0, height: b.y1 - b.y0 });
        }

        const output = {
          success: true,
          sliced: true,
          sheet_path: sheetPath,
          ...(sheetCanonId ? { sheet_canon_id: sheetCanonId } : {}),
          generation_attempts: attempts,
          items: itemResults,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Design Sheet") }], isError: true };
      }
    },
  );
}
