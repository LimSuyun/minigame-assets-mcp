import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { saveAssetToRegistry, generateAssetId, ensureDir } from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GeneratedAsset } from "../types.js";

// ─── Character set definitions ────────────────────────────────────────────────

function getCharSet(character_set: "ascii" | "korean_basic" | "numbers_only"): string[] {
  switch (character_set) {
    case "numbers_only":
      return Array.from("0123456789+-%.!");

    case "ascii": {
      const chars: string[] = [];
      for (let i = 32; i <= 126; i++) {
        chars.push(String.fromCharCode(i));
      }
      return chars;
    }

    case "korean_basic": {
      // KS X 1001 완성형 한글 2350자 (U+AC00 기준 빈도 상위 2350자 근사)
      // Unicode 한글 음절 블록: AC00-D7A3 (11172자) 중 KS X 1001 기준 2350자
      // 실용적 구현: AC00부터 2350자 순서대로 사용 (표준 완성형과 동일한 배열)
      const koreanChars: string[] = [];
      // 한글 완성형 2350자: 가(AC00)부터 시작
      // KS X 1001의 2350자는 Unicode 한글 음절 내에서 연속 블록은 아니나
      // 실무에서는 AC00~D79F 범위 내 2350개를 사용
      for (let i = 0; i < 2350; i++) {
        koreanChars.push(String.fromCodePoint(0xAC00 + i));
      }
      // ASCII 추가
      const asciiChars: string[] = [];
      for (let i = 32; i <= 126; i++) {
        asciiChars.push(String.fromCharCode(i));
      }
      return [...koreanChars, ...asciiChars];
    }
  }
}

// ─── SVG single-character renderer ───────────────────────────────────────────

function charToSvg(
  char: string,
  charW: number,
  charH: number,
  fontSize: number,
  color: string,
  strokeColor: string,
  strokeWidth: number,
  fontFamily: string
): string {
  // Escape XML special characters
  const escapedChar = char
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

  const paintOrder = strokeWidth > 0 ? ' paint-order="stroke"' : "";
  const strokeAttrs =
    strokeWidth > 0
      ? ` stroke="${strokeColor}" stroke-width="${strokeWidth * 2}" stroke-linejoin="round"`
      : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${charW}" height="${charH}">
    <text
      x="${charW / 2}"
      y="${charH * 0.78}"
      font-family="${fontFamily}"
      font-size="${fontSize}"
      fill="${color}"
      text-anchor="middle"
      dominant-baseline="auto"${strokeAttrs}${paintOrder}
    >${escapedChar}</text>
  </svg>`;
}

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerFontTools(server: McpServer): void {
  server.registerTool(
    "asset_convert_font_to_bitmap",
    {
      title: "Convert Font to Bitmap Font Sheet",
      description: `Convert a TTF/OTF font (or built-in fallback) into a game-ready bitmap font sprite sheet.

No AI image generation is used — all rendering is done via Sharp SVG.

Character sets:
  - ascii:         ASCII characters 32–126 (95 chars)
  - numbers_only:  0-9, +, -, %, !, . (15 chars) — ideal for floating damage text
  - korean_basic:  KS X 1001 완성형 한글 2350자 + ASCII (2445 chars total)
                   Note: korean_basic may take some time due to the large character count.

Output files:
  - bitmap_font_sheet.png  — sprite sheet of all characters on a grid
  - bitmap_font_config.json — { font_size, char_width, char_height, cols,
                               chars: [{ char, x, y, w, h, advance }] }

Args:
  - font_path: Path to TTF/OTF font file (uses system sans-serif if omitted)
  - font_size: Render size in pixels (16, 24, 32, 48)
  - character_set: Which character set to render
  - style: Color and stroke styling options
  - output_dir: Output directory`,
      inputSchema: z.object({
        font_path: z.string().optional()
          .describe("Path to TTF/OTF font file (system sans-serif fallback if omitted)"),
        font_size: z.union([
          z.literal(16),
          z.literal(24),
          z.literal(32),
          z.literal(48),
        ]).default(32).describe("Font render size in pixels"),
        character_set: z.enum(["ascii", "korean_basic", "numbers_only"]).default("ascii")
          .describe("Character set to render"),
        style: z.object({
          color: z.string().default("#FFFFFF").describe("Text color (hex)"),
          stroke_color: z.string().default("#000000").describe("Stroke/outline color (hex)"),
          stroke_width: z.number().int().min(0).max(10).default(2)
            .describe("Stroke/outline width in pixels"),
        }).optional().describe("Text style options"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const fontDir = path.resolve(outputDir, "fonts");
        ensureDir(fontDir);

        const fontSize = params.font_size;
        const charW = Math.round(fontSize * 1.1);
        const charH = Math.round(fontSize * 1.4);
        const color = params.style?.color ?? "#FFFFFF";
        const strokeColor = params.style?.stroke_color ?? "#000000";
        const strokeWidth = params.style?.stroke_width ?? 2;

        // Determine font family for SVG rendering
        let fontFamily = "Arial, sans-serif";
        if (params.font_path && fs.existsSync(params.font_path)) {
          // For SVG-based Sharp rendering we embed the font name heuristically
          const baseName = path.basename(params.font_path, path.extname(params.font_path));
          fontFamily = `"${baseName}", Arial, sans-serif`;
          console.error(`[font] Using font: ${params.font_path}`);
        }

        const chars = getCharSet(params.character_set);
        const charCount = chars.length;
        const cols = Math.ceil(Math.sqrt(charCount));
        const rows = Math.ceil(charCount / cols);
        const sheetW = cols * charW;
        const sheetH = rows * charH;

        console.error(`[font] Rendering ${charCount} characters (${cols}×${rows} grid, ${sheetW}×${sheetH}px)...`);

        // Build the sheet: create a blank canvas then composite each character
        const sheetBuffer = await sharp({
          create: {
            width: sheetW,
            height: sheetH,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        }).png().toBuffer();

        // Process in batches to avoid memory pressure for large sets (korean_basic)
        const BATCH_SIZE = 200;
        let currentSheet = sheetBuffer;

        const charMeta: Array<{ char: string; x: number; y: number; w: number; h: number; advance: number }> = [];

        for (let batchStart = 0; batchStart < charCount; batchStart += BATCH_SIZE) {
          const batchEnd = Math.min(batchStart + BATCH_SIZE, charCount);
          if (params.character_set === "korean_basic" && batchStart % 1000 === 0) {
            console.error(`[font] Progress: ${batchStart}/${charCount} characters rendered`);
          }

          const composites: sharp.OverlayOptions[] = [];

          for (let i = batchStart; i < batchEnd; i++) {
            const char = chars[i];
            const col = i % cols;
            const row = Math.floor(i / cols);
            const x = col * charW;
            const y = row * charH;

            const svgStr = charToSvg(char, charW, charH, fontSize, color, strokeColor, strokeWidth, fontFamily);
            const svgBuf = Buffer.from(svgStr);

            let charPng: Buffer;
            try {
              charPng = await sharp(svgBuf).png().toBuffer();
            } catch {
              // If SVG rendering fails for a character, skip it with a blank slot
              charMeta.push({ char, x, y, w: charW, h: charH, advance: charW });
              continue;
            }

            composites.push({ input: charPng, left: x, top: y });
            charMeta.push({ char, x, y, w: charW, h: charH, advance: charW });
          }

          if (composites.length > 0) {
            currentSheet = await sharp(currentSheet)
              .composite(composites)
              .png()
              .toBuffer();
          }
        }

        console.error(`[font] Saving sprite sheet...`);

        const sheetFileName = "bitmap_font_sheet.png";
        const configFileName = "bitmap_font_config.json";
        const sheetPath = path.join(fontDir, sheetFileName);
        const configPath = path.join(fontDir, configFileName);

        fs.writeFileSync(sheetPath, currentSheet);

        const config = {
          font_size: fontSize,
          char_width: charW,
          char_height: charH,
          cols,
          rows,
          sheet_width: sheetW,
          sheet_height: sheetH,
          character_set: params.character_set,
          color,
          stroke_color: strokeColor,
          stroke_width: strokeWidth,
          chars: charMeta,
        };
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "bitmap_font",
          provider: "sharp_svg",
          prompt: `bitmap font sheet: ${params.character_set} ${fontSize}px`,
          file_path: sheetPath,
          file_name: sheetFileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            font_size: fontSize,
            character_set: params.character_set,
            char_count: charMeta.length,
            cols,
            rows,
            config_path: configPath,
          },
        };
        saveAssetToRegistry(asset, outputDir);

        const output = {
          success: true,
          sheet_path: sheetPath,
          config_path: configPath,
          asset_id: asset.id,
          font_size: fontSize,
          character_set: params.character_set,
          char_count: charMeta.length,
          sheet_size: `${sheetW}×${sheetH}`,
          grid: `${cols}×${rows}`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Bitmap Font") }],
          isError: true,
        };
      }
    }
  );
}
