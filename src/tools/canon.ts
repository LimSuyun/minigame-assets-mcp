/**
 * canon.ts
 *
 * Canon 에셋 관리 도구 모음.
 * Canon = 한 번만 생성되는 마스터 레퍼런스 에셋.
 * 모든 파생 에셋은 Canon 이미지를 기준으로 스타일/색상 일관성을 유지해야 함.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, NO_TEXT_IN_IMAGE, NO_SHADOW_IN_IMAGE, CHIBI_STYLE_DEFAULT } from "../constants.js";
import { editImageGemini, analyzeImageGemini } from "../services/gemini.js";
import {
  loadCanonRegistry,
  registerCanonEntry,
  getCanonEntry,
  findCanonByType,
  removeCanonEntry,
  generateCanonId,
  getCanonDir,
} from "../utils/canon.js";
import { getJob, listJobs } from "../utils/jobs.js";
import { extractPalette, comparePalettes } from "../utils/palette.js";
import {
  removeBackground,
  compositeOntoSolidBg,
} from "../utils/image-process.js";
import {
  buildAssetPath,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { CanonEntry, GeneratedAsset } from "../types.js";

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

function readImageAsBase64(filePath: string): { base64: string; mimeType: string } {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`이미지 파일을 찾을 수 없습니다: ${resolved}`);
  }
  const data = fs.readFileSync(resolved);
  const ext = path.extname(resolved).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    ext === ".webp" ? "image/webp" :
    "image/png";
  return { base64: data.toString("base64"), mimeType };
}

/** ΔE 거리를 0.0-1.0 점수로 변환 (낮은 ΔE = 높은 점수) */
function deltaEToScore(deltaE: number, maxDeltaE = 50): number {
  return Math.max(0, Math.min(1, 1 - deltaE / maxDeltaE));
}

/** 0.0-1.0 점수를 권고 문자열로 변환 (플랜 임계값: 0.7 기준) */
function scoreToRecommendation(score: number): string {
  if (score >= 0.8) return "통과";
  if (score >= 0.7) return "경미한 편집 권장";
  return "재생성 권장";
}

// ─── CANON_TYPE 공통 ENUM ─────────────────────────────────────────────────────

const CANON_TYPE_ENUM = ["character", "background", "ui", "prop", "effect", "weapon", "logo", "other"] as const;
type CanonType = typeof CANON_TYPE_ENUM[number];

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerCanonTools(server: McpServer): void {

  // ── 1. Canon 등록 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_register_canon",
    {
      title: "Register Canon Asset",
      description: `Register an image as a Canon (master reference) asset.
Canon assets are the single source of truth for style, color, and design.
All derivative assets should reference Canon to maintain visual consistency.

Once registered, Canon entries can be used as reference images in:
- asset_generate_with_reference (style/character reference)
- asset_validate_consistency (comparison baseline)
- asset_generate_style_reference_sheet (visual overview)

Args:
  - file_path (string): Path to the image file to register as Canon
  - name (string): Human-readable Canon name (e.g., "Hero Character", "Forest Background")
  - type (string): Canon category — character | background | ui | prop | effect | weapon | logo | other
  - description (string): Detailed description of what this Canon asset represents
  - art_style (string, optional): Art style descriptor
  - tags (string[], optional): Search tags
  - extract_palette (boolean, optional): Auto-extract color palette (default: true)
  - output_dir (string, optional): Output directory

Returns:
  Canon entry ID + registry summary`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Path to the image to register as Canon"),
        name: z.string().min(1).max(200).describe("Canon asset name"),
        type: z.enum(CANON_TYPE_ENUM).describe("Canon asset category"),
        description: z.string().min(5).max(2000).describe("Detailed description of this Canon asset"),
        art_style: z.string().max(500).optional().describe("Art style descriptor"),
        tags: z.array(z.string()).max(20).optional().describe("Search tags"),
        extract_palette: z.boolean().default(true).describe("Auto-extract color palette from image"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const resolved = path.resolve(params.file_path);

        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: "text" as const, text: `Error: 파일을 찾을 수 없습니다: ${resolved}` }],
            isError: true,
          };
        }

        let colorPalette: string[] | undefined;
        if (params.extract_palette) {
          try {
            const imageBuffer = fs.readFileSync(resolved);
            const palette = await extractPalette(imageBuffer, 6);
            colorPalette = palette.map((c) => c.hex);
          } catch (e) {
            console.warn("[canon] 팔레트 추출 실패:", e);
          }
        }

        const canonId = generateCanonId(params.type, params.name);

        const entry: CanonEntry = {
          id: canonId,
          name: params.name,
          type: params.type as CanonType,
          file_path: resolved,
          file_name: path.basename(resolved),
          description: params.description,
          art_style: params.art_style,
          color_palette: colorPalette,
          tags: params.tags,
          created_at: new Date().toISOString(),
          derived_assets: [],
          metadata: {},
        };

        const registry = registerCanonEntry(entry, outputDir);

        const output = {
          success: true,
          canon_id: canonId,
          name: params.name,
          type: params.type,
          file_path: resolved,
          color_palette: colorPalette,
          total_canon_entries: registry.entries.length,
          registry_path: path.join(getCanonDir(outputDir), "canon_registry.json"),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Register Canon") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. Canon 조회 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_get_canon",
    {
      title: "Get Canon Asset Info",
      description: `Get details about a registered Canon asset by ID.

Args:
  - canon_id (string): Canon entry ID (from asset_register_canon)
  - output_dir (string, optional): Output directory

Returns:
  Canon entry details including file path, description, color palette, tags`,
      inputSchema: z.object({
        canon_id: z.string().min(1).describe("Canon entry ID"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const entry = getCanonEntry(params.canon_id, outputDir);

      if (!entry) {
        return {
          content: [{ type: "text" as const, text: `Canon 엔트리를 찾을 수 없습니다: ${params.canon_id}` }],
          isError: true,
        };
      }

      const exists = fs.existsSync(entry.file_path);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ ...entry, file_exists: exists }, null, 2) }],
      };
    }
  );

  // ── 3. Canon 목록 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_list_canon",
    {
      title: "List Canon Assets",
      description: `List all registered Canon assets, optionally filtered by type.

Args:
  - type (string, optional): Filter by type — character | background | ui | prop | effect | weapon | logo | other
  - output_dir (string, optional): Output directory

Returns:
  Array of Canon entries with IDs, names, types, and file paths`,
      inputSchema: z.object({
        type: z.enum(CANON_TYPE_ENUM).optional().describe("Filter by Canon type"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const registry = loadCanonRegistry(outputDir);
      const entries = params.type
        ? registry.entries.filter((e) => e.type === params.type)
        : registry.entries;

      const output = {
        total: entries.length,
        registry_path: path.join(getCanonDir(outputDir), "canon_registry.json"),
        entries: entries.map((e) => ({
          id: e.id,
          name: e.name,
          type: e.type,
          file_path: e.file_path,
          description: e.description.slice(0, 100) + (e.description.length > 100 ? "..." : ""),
          color_palette: e.color_palette,
          tags: e.tags,
          created_at: e.created_at,
          derived_assets_count: e.derived_assets?.length ?? 0,
        })),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 4. Canon 레퍼런스로 이미지 생성 ────────────────────────────────────────
  server.registerTool(
    "asset_generate_with_reference",
    {
      title: "Generate Asset with Canon Reference",
      description: `Generate a new game asset using a Canon image as a style/character reference.
Uses Gemini 2.5 Flash Image editing with the Canon image as visual context.

Best for:
- Generating derivative assets that match a Canon character's style
- Creating background variants that match a Canon background's art style
- Producing UI elements that match a Canon UI component

Args:
  - canon_id (string): Canon entry to use as reference
  - prompt (string): Description of the new asset to generate
  - asset_type (string): Type of the new asset
  - asset_name (string): Name for the output file
  - register_as_derived (boolean, optional): Register this output as a derived asset of the Canon (default: false)
  - output_dir (string, optional): Output directory

Returns:
  File path of the generated asset`,
      inputSchema: z.object({
        canon_id: z.string().min(1).describe("Canon entry ID to use as visual reference"),
        prompt: z.string().min(10).max(3000).describe("Description of the new asset to generate"),
        asset_type: z.string().default("sprite").describe("Asset type category"),
        asset_name: z.string().min(1).max(200).describe("Output file name (without extension)"),
        edit_model: z.string().default("gemini-2.5-flash-image")
          .describe("Gemini model for generation"),
        register_as_derived: z.boolean().default(false)
          .describe("Register generated asset as derived from this Canon"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const canon = getCanonEntry(params.canon_id, outputDir);

        if (!canon) {
          return {
            content: [{ type: "text" as const, text: `Canon 엔트리를 찾을 수 없습니다: ${params.canon_id}` }],
            isError: true,
          };
        }

        if (!fs.existsSync(canon.file_path)) {
          return {
            content: [{ type: "text" as const, text: `Canon 파일을 찾을 수 없습니다: ${canon.file_path}` }],
            isError: true,
          };
        }

        let inputBase64: string;
        try {
          const compositedBuffer = await compositeOntoSolidBg(canon.file_path, [255, 255, 255]);
          inputBase64 = compositedBuffer.toString("base64");
        } catch {
          const { base64 } = readImageAsBase64(canon.file_path);
          inputBase64 = base64;
        }

        const result = await editImageGemini({
          imageBase64: inputBase64,
          imageMimeType: "image/png",
          editPrompt: params.prompt,
          model: params.edit_model,
        });

        const safeAssetName = params.asset_name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `${safeAssetName}.png`;
        const filePath = buildAssetPath(outputDir, params.asset_type, fileName);
        ensureDir(path.dirname(filePath));
        saveBase64File(result.base64, filePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: params.asset_type,
          provider: "gemini-edit",
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: { canon_reference: params.canon_id },
        };
        saveAssetToRegistry(asset, outputDir);

        // derived_assets 등록
        if (params.register_as_derived) {
          const registry = loadCanonRegistry(outputDir);
          const entry = registry.entries.find((e) => e.id === params.canon_id);
          if (entry) {
            if (!entry.derived_assets) entry.derived_assets = [];
            if (!entry.derived_assets.includes(filePath)) {
              entry.derived_assets.push(filePath);
            }
            const { saveCanonRegistry } = await import("../utils/canon.js");
            saveCanonRegistry(registry, outputDir);
          }
        }

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            file_path: filePath,
            asset_id: asset.id,
            canon_reference: params.canon_id,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Generate With Reference") }],
          isError: true,
        };
      }
    }
  );

  // ── 5. 팔레트 추출 ────────────────────────────────────────────────────────
  server.registerTool(
    "asset_extract_palette",
    {
      title: "Extract Color Palette from Image",
      description: `Extract the dominant color palette from a game asset image using k-means clustering.
Useful for ensuring visual consistency across assets.

Args:
  - file_path (string): Path to the image file
  - color_count (number, optional): Number of colors to extract (default: 8, max: 16)
  - output_path (string, optional): If provided, save palette.json to this path
    Format: { "colors": ["#RRGGBB", ...], "dominant": "#RRGGBB" }

Returns:
  Array of dominant colors with hex codes, percentages, and CIE Lab values`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Path to the image file"),
        color_count: z.number().int().min(2).max(16).default(8)
          .describe("Number of dominant colors to extract"),
        output_path: z.string().optional()
          .describe("Save palette.json to this path"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const resolved = path.resolve(params.file_path);
        if (!fs.existsSync(resolved)) {
          return {
            content: [{ type: "text" as const, text: `파일을 찾을 수 없습니다: ${resolved}` }],
            isError: true,
          };
        }

        const imageBuffer = fs.readFileSync(resolved);
        const palette = await extractPalette(imageBuffer, params.color_count);

        const hexList = palette.map((c) => c.hex);
        const dominant = hexList[0] || "#000000";

        // palette.json 저장
        if (params.output_path) {
          const outputResolved = path.resolve(params.output_path);
          ensureDir(path.dirname(outputResolved));
          fs.writeFileSync(outputResolved, JSON.stringify({
            source_image: resolved,
            colors: hexList,
            dominant,
            generated_at: new Date().toISOString(),
          }, null, 2), "utf-8");
        }

        const output = {
          file_path: resolved,
          color_count: palette.length,
          dominant,
          palette: palette.map((c) => ({
            hex: c.hex,
            rgb: { r: c.rgb[0], g: c.rgb[1], b: c.rgb[2] },
            percentage: c.percentage,
          })),
          hex_list: hexList,
          palette_json_path: params.output_path ? path.resolve(params.output_path) : null,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Extract Palette") }],
          isError: true,
        };
      }
    }
  );

  // ── 6. 투명도 정제 (고급 배경 제거) ────────────────────────────────────────
  server.registerTool(
    "asset_refine_transparency",
    {
      title: "Refine Image Transparency (Advanced Background Removal)",
      description: `Remove background from an image using advanced chromakey or brightness-based removal.

Modes:
1. chromakey (recommended for sprites): Removes a specific solid-color background (magenta #FF00FF default).
2. brightness: Removes white/bright backgrounds based on pixel brightness threshold.

Args:
  - input_path (string): Path to the source image
  - output_path (string, optional): Output path. Default: replaces extension with _transparent.png
  - mode (string): "chromakey" or "brightness" (default: "chromakey")
  - chroma_color (string, optional): "magenta" | "lime" | "cyan" | "blue" (default: "magenta")
  - threshold (number, optional): Removal sensitivity (default: chromakey=35, brightness=240)
  - crop_to_content (boolean, optional): Crop to non-transparent content (default: true)

Returns:
  Output file path of the processed transparent PNG`,
      inputSchema: z.object({
        input_path: z.string().min(1).describe("Path to input image"),
        output_path: z.string().optional().describe("Output path for transparent PNG"),
        mode: z.enum(["chromakey", "brightness"]).default("chromakey").describe("Background removal mode"),
        chroma_color: z.enum(["magenta", "lime", "cyan", "blue"]).default("magenta")
          .describe("Chromakey background color to remove"),
        threshold: z.number().int().min(0).max(255).optional()
          .describe("Removal threshold"),
        crop_to_content: z.boolean().default(true).describe("Crop to non-transparent content"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const inputResolved = path.resolve(params.input_path);
        if (!fs.existsSync(inputResolved)) {
          return {
            content: [{ type: "text" as const, text: `입력 파일을 찾을 수 없습니다: ${inputResolved}` }],
            isError: true,
          };
        }

        const outputPath = params.output_path
          ? path.resolve(params.output_path)
          : inputResolved.replace(/\.[^.]+$/, "_transparent.png");

        ensureDir(path.dirname(outputPath));

        const CHROMA_COLORS: Record<string, [number, number, number]> = {
          magenta: [255, 0, 255],
          lime: [0, 255, 0],
          cyan: [0, 255, 255],
          blue: [0, 0, 255],
        };

        const chromaKeyColor = params.mode === "chromakey"
          ? CHROMA_COLORS[params.chroma_color]
          : undefined;

        const defaultThreshold = params.mode === "chromakey" ? 35 : 240;
        const threshold = params.threshold ?? defaultThreshold;

        await removeBackground(inputResolved, outputPath, {
          chromaKeyColor,
          threshold,
          cropToContent: params.crop_to_content,
        });

        const stat = fs.statSync(outputPath);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            output_path: outputPath,
            mode: params.mode,
            threshold,
            file_size_bytes: stat.size,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Refine Transparency") }],
          isError: true,
        };
      }
    }
  );

  // ── 7. 이미지 합성 ────────────────────────────────────────────────────────
  server.registerTool(
    "asset_composite",
    {
      title: "Composite Images",
      description: `Composite (layer) multiple images onto a base background using Sharp.

Args:
  - base_path (string, optional): Path to the base/background image.
      If omitted, canvas must be specified to create a new blank canvas.
  - canvas (object, optional): Create a blank canvas when base_path is not provided.
      - width (number): Canvas width
      - height (number): Canvas height
      - background_color (string): Hex color (default: "#FFFFFF") or "transparent"
  - layers (array): Layers to composite (bottom to top). Each layer:
      - file_path (string): Path to overlay image
      - left (number, optional): X offset (default: 0)
      - top (number, optional): Y offset (default: 0)
      - blend_mode (string, optional): "over" | "multiply" | "screen" | "add" | "overlay" | "darken" | "lighten" (default: "over")
      - opacity (number, optional): Layer opacity 0.0-1.0 (default: 1.0)
  - output_path (string): Path to save the composited image
  - output_width (number, optional): Resize output width
  - output_height (number, optional): Resize output height

Returns:
  Output file path`,
      inputSchema: z.object({
        base_path: z.string().optional().describe("Path to base/background image"),
        canvas: z.object({
          width: z.number().int().min(1).max(8192).describe("Canvas width"),
          height: z.number().int().min(1).max(8192).describe("Canvas height"),
          background_color: z.string().default("#FFFFFF").describe("Background hex color or 'transparent'"),
        }).optional().describe("Create blank canvas (used when base_path is omitted)"),
        layers: z.array(z.object({
          file_path: z.string().min(1).describe("Path to overlay image"),
          left: z.number().int().default(0).describe("X offset"),
          top: z.number().int().default(0).describe("Y offset"),
          blend_mode: z.enum(["over", "multiply", "screen", "add", "overlay", "darken", "lighten"])
            .default("over").describe("Blend mode"),
          opacity: z.number().min(0).max(1).default(1.0).describe("Layer opacity"),
        })).min(1).max(20).describe("Layers to composite"),
        output_path: z.string().min(1).describe("Output path for composited image"),
        output_width: z.number().int().min(1).optional().describe("Resize output width"),
        output_height: z.number().int().min(1).optional().describe("Resize output height"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const sharpLib = (await import("sharp")).default;

        if (!params.base_path && !params.canvas) {
          return {
            content: [{ type: "text" as const, text: "base_path 또는 canvas 중 하나를 지정하세요." }],
            isError: true,
          };
        }

        type SharpBlend = "over" | "multiply" | "screen" | "add" | "overlay" | "darken" | "lighten";

        const compositeInputs: Array<{
          input: Buffer | string;
          left: number;
          top: number;
          blend: SharpBlend;
        }> = [];

        for (const layer of params.layers) {
          const layerResolved = path.resolve(layer.file_path);
          if (!fs.existsSync(layerResolved)) {
            return {
              content: [{ type: "text" as const, text: `레이어 파일을 찾을 수 없습니다: ${layerResolved}` }],
              isError: true,
            };
          }

          // opacity 처리: Sharp는 직접 opacity를 지원하지 않으므로, 알파 채널 조정
          let layerInput: Buffer | string = layerResolved;
          if (layer.opacity < 1.0) {
            const alpha = Math.round(layer.opacity * 255);
            layerInput = await sharpLib(layerResolved)
              .ensureAlpha()
              .linear(1, 0)
              .composite([{
                input: await sharpLib(layerResolved)
                  .ensureAlpha()
                  .toBuffer()
                  .then(async (buf) => {
                    const { data, info } = await sharpLib(buf).raw().toBuffer({ resolveWithObject: true });
                    const pixels = new Uint8Array(data);
                    for (let i = 3; i < pixels.length; i += 4) {
                      pixels[i] = Math.round(pixels[i] * layer.opacity);
                    }
                    return sharpLib(Buffer.from(pixels), { raw: { width: info.width, height: info.height, channels: 4 } })
                      .png().toBuffer();
                  }),
                blend: "over" as SharpBlend,
              }])
              .toBuffer()
              .catch(() => fs.readFileSync(layerResolved)); // fallback
            // 더 단순한 방법: 직접 알파 채널 조작
            try {
              const { data, info } = await sharpLib(layerResolved)
                .ensureAlpha()
                .raw()
                .toBuffer({ resolveWithObject: true });
              const pixels = new Uint8Array(data);
              for (let i = 3; i < pixels.length; i += 4) {
                pixels[i] = Math.round(pixels[i] * layer.opacity);
              }
              layerInput = await sharpLib(Buffer.from(pixels), {
                raw: { width: info.width, height: info.height, channels: 4 },
              }).png().toBuffer();
            } catch {
              layerInput = layerResolved;
            }
          }

          compositeInputs.push({
            input: layerInput,
            left: layer.left,
            top: layer.top,
            blend: (layer.blend_mode as SharpBlend) || "over",
          });
        }

        const outputPath = path.resolve(params.output_path);
        ensureDir(path.dirname(outputPath));

        let pipeline;
        if (params.base_path) {
          const baseResolved = path.resolve(params.base_path);
          if (!fs.existsSync(baseResolved)) {
            return {
              content: [{ type: "text" as const, text: `기반 이미지를 찾을 수 없습니다: ${baseResolved}` }],
              isError: true,
            };
          }
          pipeline = sharpLib(baseResolved).composite(compositeInputs);
        } else if (params.canvas) {
          const { width, height, background_color } = params.canvas;
          const isTransparent = background_color === "transparent";
          const bgColor = isTransparent
            ? { r: 0, g: 0, b: 0, alpha: 0 }
            : (() => {
                const hex = background_color.replace("#", "");
                return {
                  r: parseInt(hex.slice(0, 2), 16),
                  g: parseInt(hex.slice(2, 4), 16),
                  b: parseInt(hex.slice(4, 6), 16),
                  alpha: 255,
                };
              })();

          pipeline = sharpLib({
            create: {
              width,
              height,
              channels: isTransparent ? 4 : 3,
              background: bgColor,
            },
          }).composite(compositeInputs);
        } else {
          throw new Error("base_path 또는 canvas 필요");
        }

        if (params.output_width || params.output_height) {
          pipeline = pipeline.resize(params.output_width, params.output_height);
        }

        await pipeline.png().toFile(outputPath);

        const stat = fs.statSync(outputPath);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            output_path: outputPath,
            layers_composited: params.layers.length,
            file_size_bytes: stat.size,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Composite") }],
          isError: true,
        };
      }
    }
  );

  // ── 8. 일관성 검증 (점수 기반) ───────────────────────────────────────────
  server.registerTool(
    "asset_validate_consistency",
    {
      title: "Validate Asset Visual Consistency",
      description: `Validate visual consistency of game assets against Canon reference assets.
Returns an overall_score (0.0-1.0) with per-item breakdown and recommendation.

Scoring System (weighted):
  - color_palette  ×0.4 — CIE76 ΔE color distance check
  - art_style      ×0.3 — Gemini Vision art style analysis
  - char_identity  ×0.2 — Character identity preservation (Gemini Vision)
  - proportion     ×0.1 — Proportion correctness (Gemini Vision)

Recommendation thresholds (플랜 기준: 0.7 경계):
  - overall_score ≥ 0.8: "통과"
  - overall_score ≥ 0.7: "경미한 편집 권장"
  - overall_score < 0.7: "재생성 권장"

Args:
  - target_paths (string[]): Image files to validate (up to 10)
  - canon_id (string, optional): Canon entry to compare against
  - check_color_palette (boolean, optional): Run CIE76 ΔE color check (default: true)
  - check_visual_style (boolean, optional): Run Gemini Vision multi-item check (default: false)
  - color_threshold (number, optional): Max acceptable ΔE for pass (default: 25)
  - output_dir (string, optional): Output directory

Returns:
  Per-asset scores with overall_score, item_scores, and recommendation`,
      inputSchema: z.object({
        target_paths: z.array(z.string()).min(1).max(10).describe("Image files to validate"),
        canon_id: z.string().optional().describe("Canon entry to compare against"),
        check_color_palette: z.boolean().default(true).describe("Run CIE76 ΔE color check"),
        check_visual_style: z.boolean().default(false).describe("Run Gemini Vision multi-item check (uses API)"),
        color_threshold: z.number().min(0).max(100).default(25)
          .describe("Max acceptable ΔE distance for color palette (default: 25)"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

        let canonEntry: CanonEntry | null = null;
        let canonPalette: string[] = [];
        if (params.canon_id) {
          canonEntry = getCanonEntry(params.canon_id, outputDir);
          if (!canonEntry) {
            return {
              content: [{ type: "text" as const, text: `Canon 엔트리를 찾을 수 없습니다: ${params.canon_id}` }],
              isError: true,
            };
          }
          if (canonEntry.color_palette) {
            canonPalette = canonEntry.color_palette;
          } else if (fs.existsSync(canonEntry.file_path)) {
            const buf = fs.readFileSync(canonEntry.file_path);
            const extracted = await extractPalette(buf, 6);
            canonPalette = extracted.map((c) => c.hex);
          }
        }

        const results: Array<{
          file_path: string;
          overall_score: number;
          item_scores: {
            color_palette: number;
            art_style: number;
            character_identity: number;
            proportion: number;
          };
          recommendation: string;
          passed: boolean;
          color_check?: { delta_e: number; threshold: number; score: number };
          vision_check?: {
            color_palette: number;
            art_style: number;
            character_identity: number;
            proportion: number;
            issues: string[];
          };
          issues: string[];
        }> = [];

        for (const targetPath of params.target_paths) {
          const resolved = path.resolve(targetPath);
          const issues: string[] = [];

          // 기본 점수 (체크 없을 때)
          let colorPaletteScore = 1.0;
          let artStyleScore = 1.0;
          let charIdentityScore = 1.0;
          let proportionScore = 1.0;

          let colorCheck = undefined;
          let visionCheck = undefined;

          if (!fs.existsSync(resolved)) {
            results.push({
              file_path: targetPath,
              overall_score: 0,
              item_scores: { color_palette: 0, art_style: 0, character_identity: 0, proportion: 0 },
              recommendation: "재생성 권장",
              passed: false,
              issues: [`파일 없음: ${resolved}`],
            });
            continue;
          }

          // 1) 색상 팔레트 CIE76 ΔE 검사 → 점수 산출
          if (params.check_color_palette && canonPalette.length > 0) {
            const buf = fs.readFileSync(resolved);
            const palette = await extractPalette(buf, 6);
            const targetHexList = palette.map((c) => c.hex);
            const deltaE = comparePalettes(canonPalette, targetHexList);
            colorPaletteScore = deltaEToScore(deltaE, params.color_threshold * 2);
            colorCheck = {
              delta_e: Math.round(deltaE * 10) / 10,
              threshold: params.color_threshold,
              score: Math.round(colorPaletteScore * 100) / 100,
            };
            if (deltaE > params.color_threshold) {
              issues.push(`색상 팔레트 불일치: ΔE=${deltaE.toFixed(1)} (임계값: ${params.color_threshold})`);
            }
          }

          // 2) Gemini Vision 다항목 검사 → 개별 점수 산출
          if (params.check_visual_style) {
            const { base64, mimeType } = readImageAsBase64(resolved);
            const canonDesc = canonEntry
              ? `Canon: ${canonEntry.name}. Style: ${canonEntry.art_style || canonEntry.description.slice(0, 200)}`
              : "";

            const stylePrompt = `You are a game art consistency checker. Analyze this game asset image.
${canonDesc ? `Compare against this Canon reference: ${canonDesc}` : ""}

Rate each aspect 0.0-1.0 (1.0 = perfect, 0.0 = completely wrong):
1. color_palette: Does the color palette match the Canon reference?
2. art_style: Is the art style consistent? (line weight, shading, coloring technique)
3. character_identity: Is the character identity preserved? (features, proportions, silhouette)
4. proportion: Are the proportions correct for the game's art style?

Also list any specific issues found.

Reply ONLY with valid JSON (no extra text):
{"color_palette": 0.9, "art_style": 0.85, "character_identity": 0.8, "proportion": 0.95, "issues": []}`;

            try {
              const text = await analyzeImageGemini({
                imageBase64: base64,
                imageMimeType: mimeType,
                prompt: stylePrompt,
                model: "gemini-2.5-flash",
                maxOutputTokens: 400,
              });
              const match = text.match(/\{[\s\S]*\}/);
              if (match) {
                const parsed = JSON.parse(match[0]) as {
                  color_palette?: number;
                  art_style?: number;
                  character_identity?: number;
                  proportion?: number;
                  issues?: string[];
                };
                artStyleScore = parsed.art_style ?? 1.0;
                charIdentityScore = parsed.character_identity ?? 1.0;
                proportionScore = parsed.proportion ?? 1.0;
                // 비전 결과로 색상 점수도 갱신 (색상 체크가 없었던 경우)
                if (!params.check_color_palette || canonPalette.length === 0) {
                  colorPaletteScore = parsed.color_palette ?? 1.0;
                }
                visionCheck = {
                  color_palette: parsed.color_palette ?? colorPaletteScore,
                  art_style: artStyleScore,
                  character_identity: charIdentityScore,
                  proportion: proportionScore,
                  issues: parsed.issues ?? [],
                };
                if (parsed.issues?.length) {
                  issues.push(...parsed.issues);
                }
              }
            } catch (e) {
              console.warn("[validate] Gemini Vision 검사 실패:", e);
            }
          }

          // 가중 평균 점수 계산
          // color_palette×0.4, art_style×0.3, character_identity×0.2, proportion×0.1
          const overallScore = Math.round(
            (colorPaletteScore * 0.4 + artStyleScore * 0.3 + charIdentityScore * 0.2 + proportionScore * 0.1) * 100
          ) / 100;

          results.push({
            file_path: targetPath,
            overall_score: overallScore,
            item_scores: {
              color_palette: Math.round(colorPaletteScore * 100) / 100,
              art_style: Math.round(artStyleScore * 100) / 100,
              character_identity: Math.round(charIdentityScore * 100) / 100,
              proportion: Math.round(proportionScore * 100) / 100,
            },
            recommendation: scoreToRecommendation(overallScore),
            passed: overallScore >= 0.7,
            ...(colorCheck ? { color_check: colorCheck } : {}),
            ...(visionCheck ? { vision_check: visionCheck } : {}),
            issues,
          });
        }

        const passed = results.filter((r) => r.passed).length;
        const avgScore = results.length > 0
          ? Math.round(results.reduce((s, r) => s + r.overall_score, 0) / results.length * 100) / 100
          : 0;

        const output = {
          total: results.length,
          passed,
          failed: results.length - passed,
          avg_overall_score: avgScore,
          canon_reference: params.canon_id || null,
          results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Validate Consistency") }],
          isError: true,
        };
      }
    }
  );

  // ── 9. 비동기 Job 결과 조회 ────────────────────────────────────────────────
  server.registerTool(
    "asset_get_job_result",
    {
      title: "Get Async Job Result",
      description: `Get the status and result of an asynchronous asset generation job.
Poll this tool until status is "done" or "failed".

Args:
  - request_id (string): Job request ID (returned by the async tool)
  - list_recent (boolean, optional): If true, list the 10 most recent jobs instead
  - output_dir (string, optional): Output directory

Returns:
  Job status, progress (0-100), output_paths, and result data when complete`,
      inputSchema: z.object({
        request_id: z.string().optional().describe("Job request ID to check"),
        list_recent: z.boolean().default(false).describe("List 10 most recent jobs"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

      if (params.list_recent) {
        const jobs = listJobs(outputDir).slice(0, 10);
        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            recent_jobs: jobs.map((j) => ({
              request_id: j.request_id,
              tool: j.tool,
              status: j.status,
              progress: j.progress,
              eta_sec: j.eta_sec,
              message: j.message,
              created_at: j.created_at,
            })),
          }, null, 2) }],
        };
      }

      if (!params.request_id) {
        return {
          content: [{ type: "text" as const, text: "request_id 또는 list_recent=true 중 하나를 지정하세요." }],
          isError: true,
        };
      }

      const job = getJob(params.request_id, outputDir);
      if (!job) {
        return {
          content: [{ type: "text" as const, text: `Job을 찾을 수 없습니다: ${params.request_id}` }],
          isError: true,
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(job, null, 2) }],
        structuredContent: job as unknown as Record<string, unknown>,
      };
    }
  );

  // ── 10. 스타일 레퍼런스 시트 생성 ──────────────────────────────────────────
  server.registerTool(
    "asset_generate_style_reference_sheet",
    {
      title: "Generate Style Reference Sheet",
      description: `Generate a visual style reference sheet from all registered Canon assets.
Places Canon thumbnails in a grid layout with labels for easy visual overview.
Saved to canon/style_reference_sheet.png and registered as a Canon entry.

This is a mandatory Stage 0 step that should be run after registering key Canon assets
(logo, main characters, weapons, backgrounds) to create a consistent visual guide.

Args:
  - output_dir (string, optional): Output directory
  - thumb_size (number, optional): Thumbnail size per asset in pixels (default: 128)
  - cols (number, optional): Number of columns in the grid (default: 4)
  - label_font_size (number, optional): Label font size (default: 14)
  - background_color (string, optional): Sheet background hex color (default: "#FFFFFF")

Returns:
  File path of the generated style reference sheet`,
      inputSchema: z.object({
        output_dir: z.string().optional().describe("Output directory"),
        thumb_size: z.number().int().min(64).max(512).default(128).describe("Thumbnail size per asset"),
        cols: z.number().int().min(1).max(8).default(4).describe("Grid columns"),
        label_font_size: z.number().int().min(8).max(32).default(14).describe("Label font size"),
        background_color: z.string().default("#FFFFFF").describe("Sheet background hex color"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const sharpLib = (await import("sharp")).default;
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const registry = loadCanonRegistry(outputDir);

        if (registry.entries.length === 0) {
          return {
            content: [{ type: "text" as const, text: "등록된 Canon 에셋이 없습니다. 먼저 asset_register_canon으로 Canon 에셋을 등록하세요." }],
            isError: true,
          };
        }

        const THUMB = params.thumb_size;
        const LABEL_H = 24;
        const CELL_H = THUMB + LABEL_H + 8;
        const CELL_W = THUMB + 16;
        const COLS = params.cols;
        const PADDING = 20;
        const HEADER_H = 50;

        // 유효한 파일만 필터링
        const validEntries = registry.entries.filter((e) => fs.existsSync(e.file_path));

        const rows = Math.ceil(validEntries.length / COLS);
        const sheetW = COLS * CELL_W + PADDING * 2;
        const sheetH = rows * CELL_H + PADDING * 2 + HEADER_H;

        // 배경색 파싱
        const bgHex = params.background_color.replace("#", "");
        const bgR = parseInt(bgHex.slice(0, 2), 16);
        const bgG = parseInt(bgHex.slice(2, 4), 16);
        const bgB = parseInt(bgHex.slice(4, 6), 16);

        // 헤더 SVG
        const headerSvg = `<svg width="${sheetW}" height="${HEADER_H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${sheetW}" height="${HEADER_H}" fill="none"/>
  <text x="${sheetW / 2}" y="32" font-family="Arial,sans-serif" font-size="20" font-weight="bold"
    fill="#333333" text-anchor="middle">Style Reference Sheet (${validEntries.length} Canon Assets)</text>
</svg>`;

        // 각 썸네일 + 라벨을 합성 입력으로 준비
        const compositeInputs: Array<{ input: Buffer; left: number; top: number }> = [];

        // 헤더 추가
        compositeInputs.push({
          input: await sharpLib(Buffer.from(headerSvg)).png().toBuffer(),
          left: 0,
          top: PADDING,
        });

        for (let i = 0; i < validEntries.length; i++) {
          const entry = validEntries[i];
          const col = i % COLS;
          const row = Math.floor(i / COLS);
          const cellX = PADDING + col * CELL_W;
          const cellY = PADDING + HEADER_H + row * CELL_H;

          // 썸네일 리사이즈
          try {
            const thumb = await sharpLib(entry.file_path)
              .resize(THUMB, THUMB, { fit: "contain", background: { r: 230, g: 230, b: 230, alpha: 255 } })
              .png()
              .toBuffer();

            compositeInputs.push({ input: thumb, left: cellX + 8, top: cellY });

            // 라벨 SVG (이름 + 타입)
            const safeName = entry.name.length > 14 ? entry.name.slice(0, 13) + "…" : entry.name;
            const labelSvg = `<svg width="${CELL_W}" height="${LABEL_H + 4}" xmlns="http://www.w3.org/2000/svg">
  <text x="${CELL_W / 2}" y="12" font-family="Arial,sans-serif" font-size="${params.label_font_size}"
    fill="#333333" text-anchor="middle">${safeName}</text>
  <text x="${CELL_W / 2}" y="26" font-family="Arial,sans-serif" font-size="10"
    fill="#888888" text-anchor="middle">[${entry.type}]</text>
</svg>`;

            compositeInputs.push({
              input: await sharpLib(Buffer.from(labelSvg)).png().toBuffer(),
              left: cellX,
              top: cellY + THUMB + 2,
            });
          } catch (e) {
            console.warn(`[style_reference_sheet] 썸네일 생성 실패: ${entry.file_path}`, e);
          }
        }

        // 시트 합성
        const sheetBuffer = await sharpLib({
          create: {
            width: sheetW,
            height: sheetH,
            channels: 3,
            background: { r: bgR, g: bgG, b: bgB },
          },
        })
          .composite(compositeInputs)
          .png()
          .toBuffer();

        // 저장
        const canonDirPath = getCanonDir(outputDir);
        ensureDir(canonDirPath);
        const outputPath = path.join(canonDirPath, "style_reference_sheet.png");
        fs.writeFileSync(outputPath, sheetBuffer);

        // Canon 레지스트리에 등록
        const sheetEntry: CanonEntry = {
          id: "canon_other_style_reference_sheet",
          name: "Style Reference Sheet",
          type: "other",
          file_path: outputPath,
          file_name: "style_reference_sheet.png",
          description: `All Canon assets overview: ${validEntries.map((e) => e.name).join(", ")}`,
          tags: ["reference", "style_guide", "overview"],
          created_at: new Date().toISOString(),
          metadata: {
            asset_count: validEntries.length,
            sheet_width: sheetW,
            sheet_height: sheetH,
          },
        };
        registerCanonEntry(sheetEntry, outputDir);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            output_path: outputPath,
            canon_count: validEntries.length,
            sheet_size: `${sheetW}×${sheetH}`,
            registered_as: sheetEntry.id,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Generate Style Reference Sheet") }],
          isError: true,
        };
      }
    }
  );

  // ── 11. 캐릭터 단일 포즈 생성 (Pose-First 패턴 Step 1) ─────────────────────
  server.registerTool(
    "asset_generate_character_pose",
    {
      title: "Generate Character Single Pose",
      description: `Generate a single character pose image for approval before generating full sprite sheets.
This is Step 1 of the Pose-First workflow:
  1. asset_generate_character_pose → review pose (magenta background PNG for easy review)
  2. (승인 후) asset_generate_sprite_sheet(pose_image=<file_path>) → 포즈 이미지 기준으로 전체 시트 생성

출력 이미지는 마젠타(#FF00FF) 배경 PNG입니다 (투명 아님).
pose_image로 직접 asset_generate_sprite_sheet에 전달하면 내부에서 배경을 처리합니다.
또는 먼저 asset_refine_transparency(method=chromakey)로 배경 제거 후 사용 가능.

Uses gpt-image-1 with magenta background for chroma key removal.

Args:
  - canon_id (string, optional): Canon character entry to use as style reference
  - character_description (string): Description of the character
  - pose (string): Pose to generate — "idle" | "walk" | "run" | "jump" | "attack" | "hurt" | "die" | "victory" | "custom"
  - pose_description (string, optional): Additional pose description (required when pose="custom")
  - direction (string, optional): "right" | "left" | "front" | "back" (default: "right")
  - art_style (string, optional): Art style description
  - output_dir (string, optional): Output directory

Returns:
  File path of the single pose PNG for review`,
      inputSchema: z.object({
        canon_id: z.string().optional().describe("Canon character entry ID as style reference"),
        character_description: z.string().min(5).max(2000).describe("Character description"),
        pose: z.enum(["idle", "walk", "run", "jump", "attack", "hurt", "die", "victory", "custom"])
          .default("idle").describe("Pose to generate"),
        pose_description: z.string().max(500).optional()
          .describe("Additional pose detail (required when pose='custom')"),
        direction: z.enum(["right", "left", "front", "back"]).default("right")
          .describe("Character facing direction"),
        art_style: z.string().max(500).optional().describe("Art style description"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { generateImageOpenAI } = await import("../services/openai.js");
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

        // Canon 참조 로드
        let styleContext = "";
        if (params.canon_id) {
          const canon = getCanonEntry(params.canon_id, outputDir);
          if (canon) {
            styleContext = canon.art_style || canon.description.slice(0, 200);
          }
        }

        const artStyle = params.art_style || styleContext || "2D game character, clear outlines";
        const poseDesc = params.pose === "custom"
          ? (params.pose_description || "standing neutral")
          : `${params.pose} pose`;
        const directionDesc = params.direction === "right" ? "facing right"
          : params.direction === "left" ? "facing left"
          : params.direction === "front" ? "facing forward"
          : "viewed from behind";

        const prompt = [
          `Game character: ${params.character_description}.`,
          `${CHIBI_STYLE_DEFAULT}`,
          `Art style override if specified: ${artStyle}.`,
          `Pose: ${poseDesc}, ${directionDesc}.`,
          "Magenta (#FF00FF) solid background — uniform flat color, no gradients.",
          "ENTIRE full body completely visible from very top of head to very tips of feet — NEVER clip or cut off any body part.",
          "Character must NOT exceed 65% of image height. Leave at least 15% margin at top and 20% at bottom.",
          "Single character only. No UI elements.",
          NO_SHADOW_IN_IMAGE,
          NO_TEXT_IN_IMAGE,
        ].join(" ");

        const result = await generateImageOpenAI({
          prompt,
          size: "1024x1024",
          quality: "high",
          background: "opaque",
        });

        const poseSafe = params.pose.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `char_pose_${poseSafe}_${params.direction}.png`;
        const filePath = buildAssetPath(outputDir, "characters/poses", fileName);
        ensureDir(path.dirname(filePath));
        saveBase64File(result.base64, filePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "character_pose",
          provider: "openai",
          prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            pose: params.pose,
            direction: params.direction,
            canon_reference: params.canon_id,
            chroma_key: "#FF00FF",
            workflow_step: "pose_first_step1",
          },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            file_path: filePath,
            asset_id: asset.id,
            pose: params.pose,
            direction: params.direction,
            chroma_key: "#FF00FF",
            next_step: "포즈 검토 후 승인 시 → asset_generate_sprite_sheet(pose_image=<이 파일 경로>)로 전체 시트 생성. pose_image 파라미터에 이 file_path를 전달하세요.",
            tip: "마젠타 배경을 먼저 제거하려면: asset_refine_transparency(method='chromakey', chroma_color='#FF00FF'). 제거 없이도 asset_generate_sprite_sheet의 pose_image로 직접 사용 가능.",
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Generate Character Pose") }],
          isError: true,
        };
      }
    }
  );

  // ── asset_generate_character_views: 4방향 베이스 일괄 생성 ────────────────
  server.registerTool(
    "asset_generate_character_views",
    {
      title: "Generate Character 4-Direction Base Views",
      description: `Generate front / left / right / back base views of a character in one call.

Each direction is generated sequentially using gpt-image-1 with a magenta (#FF00FF) chroma-key
background so backgrounds can be removed cleanly afterward.

Typical workflow:
  1. asset_generate_character_views   ← this tool (generates 4 base views)
  2. asset_generate_sprite_sheet      ← pass each view's file_path as pose_image

Args:
  - character_description (string): Full character description
  - canon_id (string, optional): Canon entry to use as style reference
  - directions (string[], optional): Subset of directions to generate (default: all 4)
  - pose (string, optional): Base pose for all views — "idle" | "walk" | "run" | "attack" | "custom" (default: "idle")
  - pose_description (string, optional): Required when pose="custom"
  - art_style (string, optional): Art style override
  - output_dir (string, optional): Output directory

Returns:
  Object with file_path for each generated direction, plus failed list if any errors.`,
      inputSchema: z.object({
        character_description: z.string().min(5).max(2000).describe("Character description"),
        canon_id: z.string().optional().describe("Canon entry ID for style reference"),
        directions: z.array(z.enum(["front", "left", "right", "back"]))
          .default(["front", "left", "right", "back"])
          .describe("Directions to generate (default: all 4)"),
        pose: z.enum(["idle", "walk", "run", "attack", "custom"]).default("idle")
          .describe("Base pose for all views"),
        pose_description: z.string().max(500).optional()
          .describe("Pose detail when pose='custom'"),
        art_style: z.string().max(500).optional().describe("Art style override"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { generateImageOpenAI } = await import("../services/openai.js");
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

        // Canon 스타일 참조 로드
        let styleContext = "";
        if (params.canon_id) {
          const canon = getCanonEntry(params.canon_id, outputDir);
          if (canon) {
            styleContext = canon.art_style || canon.description.slice(0, 200);
          }
        }
        const artStyle = params.art_style || styleContext || "2D game character, clear outlines, clean cartoon style";

        const poseDesc = params.pose === "custom"
          ? (params.pose_description || "standing neutral")
          : `${params.pose} pose`;

        const DIRECTION_LABELS: Record<string, string> = {
          front: "facing directly forward toward the viewer, full front view",
          left:  "facing directly left (side profile), full left side view",
          right: "facing directly right (side profile), full right side view",
          back:  "viewed from directly behind, full back view",
        };

        const results: Record<string, {
          success: boolean;
          file_path?: string;
          asset_id?: string;
          error?: string;
        }> = {};

        for (const direction of params.directions) {
          try {
            const directionDesc = DIRECTION_LABELS[direction];
            const prompt = [
              `Game character: ${params.character_description}.`,
              `${CHIBI_STYLE_DEFAULT}`,
              `Art style override if specified: ${artStyle}.`,
              `Pose: ${poseDesc}, ${directionDesc}.`,
              "ENTIRE full body completely visible from very top of head to very tips of feet — NEVER clip or cut off any body part.",
              "Character must NOT exceed 65% of image height. Leave at least 15% margin at top and 20% at bottom.",
              "Magenta (#FF00FF) solid background — uniform flat color, no gradients.",
              "Single character only. Clean 2D game sprite style.",
              NO_SHADOW_IN_IMAGE,
              NO_TEXT_IN_IMAGE,
            ].join(" ");

            const result = await generateImageOpenAI({
              prompt,
              size: "1024x1024",
              quality: "high",
              background: "opaque",
            });

            const poseSafe = params.pose.replace(/[^a-zA-Z0-9_-]/g, "_");
            const fileName = `char_base_${poseSafe}_${direction}.png`;
            const filePath = buildAssetPath(outputDir, "characters/views", fileName);
            ensureDir(path.dirname(filePath));
            saveBase64File(result.base64, filePath);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "character_pose",
              provider: "openai",
              prompt,
              file_path: filePath,
              file_name: fileName,
              mime_type: "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                pose: params.pose,
                direction,
                canon_reference: params.canon_id,
                chroma_key: "#FF00FF",
                workflow: "4-direction-base",
              },
            };
            saveAssetToRegistry(asset, outputDir);

            results[direction] = { success: true, file_path: filePath, asset_id: asset.id };
          } catch (dirErr) {
            results[direction] = {
              success: false,
              error: dirErr instanceof Error ? dirErr.message : String(dirErr),
            };
          }
        }

        const succeeded = Object.values(results).filter(r => r.success).length;
        const failed = Object.values(results).filter(r => !r.success).length;

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: succeeded > 0,
            total: params.directions.length,
            succeeded,
            failed,
            views: results,
            chroma_key: "#FF00FF",
            next_steps: Object.entries(results)
              .filter(([, r]) => r.success)
              .map(([dir, r]) => ({
                direction: dir,
                file_path: r.file_path,
                next: `asset_generate_sprite_sheet(base_character_path=<base>, pose_image="${r.file_path}")`,
              })),
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Generate Character Views") }],
          isError: true,
        };
      }
    }
  );
}
