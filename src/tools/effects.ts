/**
 * effects.ts
 *
 * 이펙트 관련 에셋 생성 도구 모음.
 *
 * 도구 분류:
 *   - asset_generate_effect_sheet       : 이펙트 애니메이션 스프라이트 시트 (gpt-image-1)
 *   - asset_generate_floating_text      : 플로팅 텍스트 스타일 PNG 세트 (Sharp SVG, AI 미사용)
 *   - asset_generate_status_effect_icons: 상태이상 아이콘 세트 (gpt-image-1)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR, NO_TEXT_IN_IMAGE, NO_SHADOW_IN_IMAGE } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { generateImageGemini } from "../services/gemini.js";
import {
  buildAssetPath,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GeneratedAsset } from "../types.js";

// ─── 이펙트 Atlas JSON 타입 ────────────────────────────────────────────────────

interface EffectFrame {
  x: number;
  y: number;
  w: number;
  h: number;
  duration_ms: number;
}

interface EffectAtlas {
  effect_id: string;
  frame_size: number;
  cols: number;
  rows: number;
  frames: EffectFrame[];
}

// ─── 플로팅 텍스트 스타일 타입 ────────────────────────────────────────────────

type FloatingTextType = "damage" | "heal" | "critical" | "miss" | "gold" | "exp" | "combo";

interface FloatingTextStyleDef {
  type: FloatingTextType;
  color: string;
  fontSize: number;
  fontWeight: string;
  fontStyle: string;
  strokeColor: string;
  strokeWidth: number;
  opacity: number;
  scale: number;
  glowColor?: string;
}

const FLOATING_TEXT_STYLES: Record<FloatingTextType, FloatingTextStyleDef> = {
  damage: {
    type: "damage",
    color: "#FF4444",
    fontSize: 48,
    fontWeight: "bold",
    fontStyle: "normal",
    strokeColor: "#FFFFFF",
    strokeWidth: 3,
    opacity: 1,
    scale: 1,
  },
  heal: {
    type: "heal",
    color: "#44FF88",
    fontSize: 48,
    fontWeight: "bold",
    fontStyle: "normal",
    strokeColor: "#44FF88",
    strokeWidth: 2,
    opacity: 1,
    scale: 1,
    glowColor: "#44FF88",
  },
  critical: {
    type: "critical",
    color: "#FF9900",
    fontSize: 48,
    fontWeight: "bold",
    fontStyle: "normal",
    strokeColor: "#FFFF00",
    strokeWidth: 3,
    opacity: 1,
    scale: 1.4,
  },
  miss: {
    type: "miss",
    color: "#888888",
    fontSize: 48,
    fontWeight: "normal",
    fontStyle: "italic",
    strokeColor: "#888888",
    strokeWidth: 0,
    opacity: 0.7,
    scale: 1,
  },
  gold: {
    type: "gold",
    color: "#FFD700",
    fontSize: 48,
    fontWeight: "bold",
    fontStyle: "normal",
    strokeColor: "#7A5800",
    strokeWidth: 3,
    opacity: 1,
    scale: 1,
  },
  exp: {
    type: "exp",
    color: "#4499FF",
    fontSize: 48,
    fontWeight: "normal",
    fontStyle: "normal",
    strokeColor: "#FFFFFF",
    strokeWidth: 2,
    opacity: 1,
    scale: 1,
  },
  combo: {
    type: "combo",
    color: "#AA44FF",
    fontSize: 48,
    fontWeight: "bold",
    fontStyle: "normal",
    strokeColor: "#FFFFFF",
    strokeWidth: 3,
    opacity: 1,
    scale: 1.3,
  },
};

// ─── SVG 텍스트 이미지 생성 헬퍼 ──────────────────────────────────────────────

function buildFloatingTextSvg(
  text: string,
  style: FloatingTextStyleDef,
  canvasWidth: number = 256,
  canvasHeight: number = 128
): string {
  const effectiveFontSize = Math.round(style.fontSize * style.scale);
  const x = canvasWidth / 2;
  const y = canvasHeight / 2 + effectiveFontSize * 0.35;

  const paintOrder = style.strokeWidth > 0 ? `paint-order="stroke fill"` : "";
  const strokeAttrs =
    style.strokeWidth > 0
      ? `stroke="${style.strokeColor}" stroke-width="${style.strokeWidth}" stroke-linejoin="round"`
      : "";

  const glowFilter =
    style.glowColor
      ? `<filter id="glow" x="-50%" y="-50%" width="200%" height="200%">
           <feGaussianBlur in="SourceGraphic" stdDeviation="3" result="blur"/>
           <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
         </filter>`
      : "";

  const filterAttr = style.glowColor ? `filter="url(#glow)"` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
  <defs>${glowFilter}</defs>
  <text
    x="${x}" y="${y}"
    text-anchor="middle"
    font-family="Arial, Helvetica, sans-serif"
    font-size="${effectiveFontSize}"
    font-weight="${style.fontWeight}"
    font-style="${style.fontStyle}"
    fill="${style.color}"
    opacity="${style.opacity}"
    ${strokeAttrs}
    ${paintOrder}
    ${filterAttr}
  >${text}</text>
</svg>`;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerEffectTools(server: McpServer): void {
  // ── 1. 이펙트 스프라이트 시트 ──────────────────────────────────────────────
  server.registerTool(
    "asset_generate_effect_sheet",
    {
      title: "Generate Effect Animation Sprite Sheet",
      description: `Generate an effect animation sprite sheet with atlas JSON for use in game engines.

Each frame is individually generated using gpt-image-1 on a pure black (#000000) background,
designed for additive blending in game engines (black = transparent in additive mode).

Frames are composed into a grid layout, and an atlas JSON is generated with frame coordinates
and animation timing data.

Args:
  - effect_id (string): Unique identifier for the effect (used in file names)
  - effect_type (string): Type of effect — attack | explosion | magic | hit | pickup | levelup | status | environment
  - frame_count (string): Number of frames — "4" | "6" | "8" | "9" | "12"
  - frame_size (number, optional): Size of each frame in pixels (64 | 128 | 256, default: 128)
  - style_description (string): Visual style description of the effect
  - color_palette (string[], optional): Hex color list for the effect palette
  - output_dir (string, optional): Output directory

Returns:
  - {effect_id}_sheet.png — sprite sheet on pure black background (for additive blending)
  - {effect_id}_atlas.json — frame coordinates + animation timing`,
      inputSchema: z.object({
        effect_id: z.string().min(1).max(100).describe("Unique effect identifier (e.g. fire_explosion, magic_hit)"),
        effect_type: z.enum(["attack", "explosion", "magic", "hit", "pickup", "levelup", "status", "environment"])
          .describe("Type of effect animation"),
        frame_count: z.enum(["4", "6", "8", "9", "12"]).describe("Number of animation frames"),
        frame_size: z.union([z.literal(64), z.literal(128), z.literal(256)]).default(128)
          .describe("Size of each frame in pixels (default: 128)"),
        style_description: z.string().min(5).max(2000).describe("Visual style description of the effect"),
        color_palette: z.array(z.string()).optional().describe("Hex color list for the effect (e.g. ['#FF4400', '#FFAA00'])"),
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
        const frameCount = parseInt(params.frame_count, 10);
        const frameSize = params.frame_size;

        // Grid layout: cols = ceil(sqrt(N)), rows = ceil(N / cols)
        const cols = Math.ceil(Math.sqrt(frameCount));
        const rows = Math.ceil(frameCount / cols);

        const safeEffectId = params.effect_id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const effectDir = buildAssetPath(outputDir, "effects", "");

        const paletteHint =
          params.color_palette && params.color_palette.length > 0
            ? ` Color palette: ${params.color_palette.join(", ")}.`
            : "";

        // Generate each frame individually
        const frameBuffers: Buffer[] = [];
        for (let i = 0; i < frameCount; i++) {
          const prompt =
            `Single frame of ${params.style_description}, frame ${i + 1}/${frameCount}, ` +
            `pure black (#000000) background, bright vivid colors for additive blending in game engine, ` +
            `centered in frame, isolated effect particle or sprite, no UI, ` +
            `${params.effect_type} effect style.${paletteHint} ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

          const result = await generateImageOpenAI({
            prompt,
            size: "1024x1024",
            quality: "medium",
            background: "opaque",
          });

          // Resize frame to target frame_size
          const rawBuffer = Buffer.from(result.base64, "base64");
          const resized = await sharp(rawBuffer)
            .resize(frameSize, frameSize, { fit: "fill" })
            .png()
            .toBuffer();

          frameBuffers.push(resized);
        }

        // Compose grid sheet
        const sheetWidth = cols * frameSize;
        const sheetHeight = rows * frameSize;

        // Start with pure black background
        const compositeOps: sharp.OverlayOptions[] = frameBuffers.map((buf, idx) => {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          return {
            input: buf,
            left: col * frameSize,
            top: row * frameSize,
          };
        });

        const sheetBuffer = await sharp({
          create: {
            width: sheetWidth,
            height: sheetHeight,
            channels: 3,
            background: { r: 0, g: 0, b: 0 },
          },
        })
          .composite(compositeOps)
          .png()
          .toBuffer();

        const sheetFileName = `${safeEffectId}_sheet.png`;
        const sheetFilePath = path.join(path.resolve(outputDir, "effects"), sheetFileName);
        ensureDir(path.dirname(sheetFilePath));
        fs.writeFileSync(sheetFilePath, sheetBuffer);

        // Generate atlas JSON
        const DEFAULT_FRAME_DURATION_MS = 80;
        const frames: EffectFrame[] = [];
        for (let idx = 0; idx < frameCount; idx++) {
          const col = idx % cols;
          const row = Math.floor(idx / cols);
          frames.push({
            x: col * frameSize,
            y: row * frameSize,
            w: frameSize,
            h: frameSize,
            duration_ms: DEFAULT_FRAME_DURATION_MS,
          });
        }

        const atlas: EffectAtlas = {
          effect_id: params.effect_id,
          frame_size: frameSize,
          cols,
          rows,
          frames,
        };

        const atlasFileName = `${safeEffectId}_atlas.json`;
        const atlasFilePath = path.join(path.resolve(outputDir, "effects"), atlasFileName);
        fs.writeFileSync(atlasFilePath, JSON.stringify(atlas, null, 2));

        // Register sheet as asset
        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "effect",
          provider: "openai",
          prompt: params.style_description,
          file_path: sheetFilePath,
          file_name: sheetFileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            effect_id: params.effect_id,
            effect_type: params.effect_type,
            frame_count: frameCount,
            frame_size: frameSize,
            cols,
            rows,
            atlas_path: atlasFilePath,
          },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  effect_id: params.effect_id,
                  sheet_path: sheetFilePath,
                  atlas_path: atlasFilePath,
                  frame_count: frameCount,
                  frame_size: frameSize,
                  cols,
                  rows,
                  note: "Sheet uses pure black background — use additive blending in game engine (black = transparent).",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Effect Sheet") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. 플로팅 텍스트 PNG 세트 ─────────────────────────────────────────────
  server.registerTool(
    "asset_generate_floating_text",
    {
      title: "Generate Floating Text Style PNG Set",
      description: `Generate floating text (damage/heal/etc.) style PNG images using Sharp SVG rendering (no AI).

Each text type is rendered with its pre-defined style:
  - damage:   Red (#FF4444), bold, white stroke 3px
  - heal:     Green (#44FF88), bold, green glow
  - critical: Orange (#FF9900), large (1.4x), yellow stroke 3px
  - miss:     Gray (#888888), italic, semi-transparent (0.7)
  - gold:     Yellow (#FFD700), bold, dark stroke
  - exp:      Blue (#4499FF), normal, white stroke
  - combo:    Purple (#AA44FF), bold, large (1.3x), white stroke

Args:
  - text_types (string[]): Array of text types to generate
  - sample_values (string[], optional): Sample text values (default: ["123", "456", "MISS", "CRIT!"])
  - output_dir (string, optional): Output directory

Returns:
  - {type}_sample.png for each type (transparent PNG, 256×128)
  - floating_text_styles.json with all style definitions`,
      inputSchema: z.object({
        text_types: z
          .array(z.enum(["damage", "heal", "critical", "miss", "gold", "exp", "combo"]))
          .min(1)
          .describe("Text types to generate"),
        sample_values: z
          .array(z.string())
          .optional()
          .describe("Sample text values (default: ['123', '456', 'MISS', 'CRIT!'])"),
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
        const sampleValues = params.sample_values ?? ["123", "456", "MISS", "CRIT!"];
        const textDir = path.resolve(outputDir, "effects/floating_text");
        ensureDir(textDir);

        const generatedFiles: string[] = [];
        const styleDefinitions: Record<string, FloatingTextStyleDef> = {};

        for (const textType of params.text_types) {
          const style = FLOATING_TEXT_STYLES[textType];
          styleDefinitions[textType] = style;

          // Use first matching sample value based on type, or first sample
          let sampleText: string;
          if (textType === "miss" && sampleValues.some((v) => v.toUpperCase() === "MISS")) {
            sampleText = "MISS";
          } else if (textType === "critical" && sampleValues.some((v) => v.toUpperCase().includes("CRIT"))) {
            sampleText = sampleValues.find((v) => v.toUpperCase().includes("CRIT")) ?? sampleValues[0];
          } else {
            sampleText = sampleValues.find((v) => /^\d+$/.test(v)) ?? sampleValues[0];
          }

          const svgText = buildFloatingTextSvg(sampleText, style, 256, 128);
          const pngBuffer = await sharp(Buffer.from(svgText))
            .png()
            .toBuffer();

          const fileName = `${textType}_sample.png`;
          const filePath = path.join(textDir, fileName);
          fs.writeFileSync(filePath, pngBuffer);
          generatedFiles.push(filePath);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "ui_element",
            provider: "sharp-svg",
            prompt: `Floating text style: ${textType}`,
            file_path: filePath,
            file_name: fileName,
            mime_type: "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              text_type: textType,
              sample_value: sampleText,
              style,
            },
          };
          saveAssetToRegistry(asset, outputDir);
        }

        // Save styles JSON
        const stylesFilePath = path.join(textDir, "floating_text_styles.json");
        fs.writeFileSync(stylesFilePath, JSON.stringify(styleDefinitions, null, 2));
        generatedFiles.push(stylesFilePath);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  text_types: params.text_types,
                  generated_files: generatedFiles,
                  styles_json: stylesFilePath,
                  note: "All PNGs use transparent background. Import floating_text_styles.json for runtime text rendering parameters.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Floating Text") }],
          isError: true,
        };
      }
    }
  );

  // ── 3. 상태이상 아이콘 세트 ────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_status_effect_icons",
    {
      title: "Generate Status Effect Icon Set",
      description: `Generate status effect icons (buff/debuff) as transparent PNG images using gpt-image-1.

Default status effects include: poison, burn, freeze, stun, slow, buff_atk, buff_def, debuff.
You can pass custom effects with id, name, type, and description.

Args:
  - effects (array): List of status effects to generate icons for.
      Each: { id, name, type: "buff"|"debuff"|"neutral", description }
  - icon_size (number, optional): Icon size in pixels (32 | 48 | 64, default: 64)
  - style_description (string, optional): Visual art style for all icons
  - output_dir (string, optional): Output directory

Returns:
  - {id}_icon.png for each effect (transparent PNG)`,
      inputSchema: z.object({
        effects: z
          .array(
            z.object({
              id: z.string().min(1).max(100).describe("Effect identifier for file naming"),
              name: z.string().min(1).max(100).describe("Display name of the effect"),
              type: z.enum(["debuff", "buff", "neutral"]).describe("Effect type"),
              description: z.string().min(1).max(500).describe("Visual description of the icon"),
            })
          )
          .min(1)
          .max(20)
          .describe("Status effects to generate icons for"),
        icon_size: z.union([z.literal(32), z.literal(48), z.literal(64)]).default(64)
          .describe("Icon size in pixels (default: 64)"),
        style_description: z.string().max(500).optional()
          .describe("Art style for all icons (e.g. 'pixel art 64x64 game icon')"),
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
        const iconSize = params.icon_size;
        const styleHint = params.style_description
          ? ` Art style: ${params.style_description}.`
          : " Clean game icon style, bold shapes, clear silhouette.";

        const iconDir = path.resolve(outputDir, "effects/status_icons");
        ensureDir(iconDir);

        const results: Array<{
          id: string;
          name: string;
          type: string;
          success: boolean;
          file_path?: string;
          error?: string;
        }> = [];

        for (const effect of params.effects) {
          try {
            const typeHint =
              effect.type === "buff"
                ? "positive buff effect icon, glowing warm colors"
                : effect.type === "debuff"
                ? "negative debuff effect icon, dark ominous colors"
                : "neutral status effect icon";

            const prompt =
              `A single game status effect icon for "${effect.name}": ${effect.description}. ` +
              `${typeHint}. ${styleHint} ` +
              `Transparent background, centered icon, ${iconSize}x${iconSize} pixel icon style, ` +
              `clear and readable at small size, no border frame. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

            const result = await generateImageOpenAI({
              prompt,
              size: "1024x1024",
              quality: "medium",
              background: "transparent",
            });

            // Resize to target icon size
            const rawBuffer = Buffer.from(result.base64, "base64");
            const resized = await sharp(rawBuffer)
              .resize(iconSize, iconSize, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .png()
              .toBuffer();

            const safeId = effect.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            const fileName = `${safeId}_icon.png`;
            const filePath = path.join(iconDir, fileName);
            fs.writeFileSync(filePath, resized);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "icon",
              provider: "openai",
              prompt,
              file_path: filePath,
              file_name: fileName,
              mime_type: "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                effect_id: effect.id,
                effect_name: effect.name,
                effect_type: effect.type,
                icon_size: iconSize,
              },
            };
            saveAssetToRegistry(asset, outputDir);

            results.push({
              id: effect.id,
              name: effect.name,
              type: effect.type,
              success: true,
              file_path: filePath,
            });
          } catch (err) {
            results.push({
              id: effect.id,
              name: effect.name,
              type: effect.type,
              success: false,
              error: handleApiError(err, `Status Icon: ${effect.id}`),
            });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: succeeded > 0,
                  icon_dir: iconDir,
                  icon_size: iconSize,
                  total: results.length,
                  succeeded,
                  failed: results.length - succeeded,
                  results,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Status Effect Icons") }],
          isError: true,
        };
      }
    }
  );
}
