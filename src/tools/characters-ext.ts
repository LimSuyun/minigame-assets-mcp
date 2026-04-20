/**
 * characters-ext.ts
 *
 * 캐릭터 확장 에셋 생성 도구 모음.
 *
 * 도구 분류:
 *   - asset_generate_character_portrait : 고화질 초상화 (Canon 파생, gpt-image-1 edit)
 *   - asset_generate_character_card     : 캐릭터 선택 카드 UI (Sharp 합성, AI 재생성 없음)
 *   - asset_generate_avatar_parts       : 아바타 커스터마이징 파츠 세트 (gpt-image-1)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR, NO_TEXT_IN_IMAGE } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { generateImageGemini } from "../services/gemini.js";
import { editImageOpenAI } from "../services/openai.js";
import {
  buildAssetPath,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { loadCanonRegistry } from "../utils/canon.js";
import { DEFAULT_ASSET_SIZE_SPEC_FILE } from "../constants.js";
import type { GeneratedAsset } from "../types.js";
import type { AssetSizeSpecFile, CanonEntry } from "../types.js";

// ─── 레어리티 색상 ────────────────────────────────────────────────────────────

const RARITY_COLORS: Record<string, string> = {
  S: "#FFD700",
  A: "#AA44FF",
  B: "#4488FF",
  C: "#44AA44",
  D: "#888888",
};

const RARITY_DARK_COLORS: Record<string, string> = {
  S: "#7A5800",
  A: "#550099",
  B: "#002288",
  C: "#115511",
  D: "#444444",
};

// ─── 카드 SVG 배경 생성 헬퍼 ──────────────────────────────────────────────────

function buildCardBackgroundSvg(
  width: number,
  height: number,
  rarityColor: string,
  darkColor: string
): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <defs>
    <linearGradient id="cardBg" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" style="stop-color:#1a1a2e;stop-opacity:1"/>
      <stop offset="100%" style="stop-color:#0d0d1a;stop-opacity:1"/>
    </linearGradient>
    <linearGradient id="borderGlow" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:${rarityColor};stop-opacity:1"/>
      <stop offset="50%" style="stop-color:${darkColor};stop-opacity:1"/>
      <stop offset="100%" style="stop-color:${rarityColor};stop-opacity:1"/>
    </linearGradient>
  </defs>
  <!-- Card background -->
  <rect width="${width}" height="${height}" rx="16" ry="16" fill="url(#cardBg)"/>
  <!-- Border -->
  <rect x="3" y="3" width="${width - 6}" height="${height - 6}" rx="14" ry="14"
    fill="none" stroke="url(#borderGlow)" stroke-width="4"/>
  <!-- Inner border -->
  <rect x="8" y="8" width="${width - 16}" height="${height - 16}" rx="10" ry="10"
    fill="none" stroke="${rarityColor}" stroke-width="1" opacity="0.4"/>
  <!-- Portrait area divider -->
  <line x1="12" y1="${Math.round(height * 0.65)}" x2="${width - 12}" y2="${Math.round(height * 0.65)}"
    stroke="${rarityColor}" stroke-width="1" opacity="0.5"/>
</svg>`;
}

function buildLockedOverlaySvg(width: number, height: number): string {
  const cx = width / 2;
  const cy = height / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <!-- Dark overlay -->
  <rect width="${width}" height="${height}" rx="16" ry="16" fill="rgba(0,0,0,0.7)"/>
  <!-- Lock body -->
  <rect x="${cx - 20}" y="${cy - 5}" width="40" height="30" rx="5" ry="5"
    fill="#CCCCCC" stroke="#888888" stroke-width="2"/>
  <!-- Lock shackle -->
  <path d="M${cx - 14} ${cy - 5} L${cx - 14} ${cy - 22} Q${cx - 14} ${cy - 35} ${cx} ${cy - 35} Q${cx + 14} ${cy - 35} ${cx + 14} ${cy - 22} L${cx + 14} ${cy - 5}"
    fill="none" stroke="#CCCCCC" stroke-width="6" stroke-linecap="round"/>
  <!-- Keyhole -->
  <circle cx="${cx}" cy="${cy + 8}" r="6" fill="#888888"/>
  <rect x="${cx - 3}" y="${cy + 8}" width="6" height="10" fill="#888888"/>
</svg>`;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerCharacterExtTools(server: McpServer): void {
  // ── 1. 캐릭터 초상화 (Portrait) ────────────────────────────────────────────
  server.registerTool(
    "asset_generate_character_portrait",
    {
      title: "Generate Character Portrait (Canon-derived)",
      description: `Generate a high-quality character portrait for selection/profile screens, derived from a Canon base image.

Uses gpt-image-1 image edit to maintain visual consistency with the canon base character.
Automatically generates three sizes: full (1024×1024), bust (512×512), and thumb (128×128).

Args:
  - character_id (string): Character identifier for file naming
  - canon_base_path (string): Path to the Canon base character image (reference image)
  - pose (string, optional): Portrait pose — "idle" | "battle" | "victory" | "defeat" | "thinking" (default: "idle")
  - background_style (string, optional): Background style — "transparent" | "gradient" | "themed" (default: "transparent")
  - output_dir (string, optional): Output directory

Returns:
  - portrait_full.png    (1024×1024 — gpt-image-1 edit from canon base)
  - portrait_bust.png    (512×512 — Sharp resize from full)
  - portrait_thumb.png   (128×128 — Sharp resize from full)`,
      inputSchema: z.object({
        character_id: z.string().min(1).max(100).describe("Character identifier for file naming"),
        canon_base_path: z.string().min(1).describe("Path to the Canon base character image"),
        pose: z.enum(["idle", "battle", "victory", "defeat", "thinking"]).default("idle")
          .describe("Portrait pose (default: idle)"),
        background_style: z.enum(["transparent", "gradient", "themed"]).default("transparent")
          .describe("Background style for the portrait"),
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
        const safeCharId = params.character_id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const portraitDir = buildAssetPath(outputDir, `portraits/${safeCharId}`, "");

        // Validate canon base path
        const resolvedBase = path.resolve(params.canon_base_path);
        if (!fs.existsSync(resolvedBase)) {
          throw new Error(`Canon base image not found: ${resolvedBase}`);
        }

        // Build pose-specific prompt
        const POSE_PROMPTS: Record<string, string> = {
          idle: "standing in a relaxed, confident idle pose, looking slightly toward the viewer, neutral expression",
          battle: "in a dynamic battle-ready stance, weapon raised or fists up, fierce determined expression",
          victory: "victory celebration pose, arms raised triumphantly, joyful or proud expression",
          defeat: "defeated pose, head bowed or body slumped, exhausted or sad expression",
          thinking: "thoughtful pose, hand near chin or chin tilted, contemplative expression",
        };

        const bgPrompt =
          params.background_style === "transparent"
            ? "transparent background"
            : params.background_style === "gradient"
            ? "soft gradient background matching the character's color palette"
            : "thematic background that fits the character's setting and style";

        const prompt =
          `Redraw this exact character as a high-quality portrait. ` +
          `Pose: ${POSE_PROMPTS[params.pose]}. ` +
          `Preserve every visual detail — same face, outfit, colors, accessories, and art style as the reference. ` +
          `Portrait framing: full body visible from head to feet, centered in frame. ` +
          `${bgPrompt}. ` +
          `High quality game character portrait, clean illustration style. ` +
          `${NO_TEXT_IN_IMAGE}`;

        // Generate full portrait via gpt-image-1 image edit
        const fullResult = await editImageOpenAI({
          imagePath: resolvedBase,
          prompt,
          model: "gpt-image-1",
          size: "1024x1024",
        });

        const fullBuffer = Buffer.from(fullResult.base64, "base64");

        // Generate bust and thumb via Sharp resize
        const bustBuffer = await sharp(fullBuffer)
          .resize(512, 512, { fit: "cover", position: "top" })
          .png()
          .toBuffer();

        const thumbBuffer = await sharp(fullBuffer)
          .resize(128, 128, { fit: "cover", position: "top" })
          .png()
          .toBuffer();

        // Save all three sizes
        const fullFileName = `${safeCharId}_portrait_full.png`;
        const bustFileName = `${safeCharId}_portrait_bust.png`;
        const thumbFileName = `${safeCharId}_portrait_thumb.png`;

        const portraitDirResolved = path.resolve(outputDir, `portraits/${safeCharId}`);
        ensureDir(portraitDirResolved);

        const fullFilePath = path.join(portraitDirResolved, fullFileName);
        const bustFilePath = path.join(portraitDirResolved, bustFileName);
        const thumbFilePath = path.join(portraitDirResolved, thumbFileName);

        fs.writeFileSync(fullFilePath, fullBuffer);
        fs.writeFileSync(bustFilePath, bustBuffer);
        fs.writeFileSync(thumbFilePath, thumbBuffer);

        // Register all three as assets
        const baseAssetData = {
          type: "image" as const,
          asset_type: "character",
          provider: "openai",
          prompt,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
        };

        const assets: GeneratedAsset[] = [
          {
            ...baseAssetData,
            id: generateAssetId(),
            file_path: fullFilePath,
            file_name: fullFileName,
            metadata: { character_id: params.character_id, pose: params.pose, size: "full", canon_base: resolvedBase },
          },
          {
            ...baseAssetData,
            id: generateAssetId(),
            file_path: bustFilePath,
            file_name: bustFileName,
            metadata: { character_id: params.character_id, pose: params.pose, size: "bust", derived_from: fullFilePath },
          },
          {
            ...baseAssetData,
            id: generateAssetId(),
            file_path: thumbFilePath,
            file_name: thumbFileName,
            metadata: { character_id: params.character_id, pose: params.pose, size: "thumb", derived_from: fullFilePath },
          },
        ];

        for (const asset of assets) {
          saveAssetToRegistry(asset, outputDir);
        }

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  character_id: params.character_id,
                  pose: params.pose,
                  portrait_dir: portraitDirResolved,
                  files: {
                    full: fullFilePath,
                    bust: bustFilePath,
                    thumb: thumbFilePath,
                  },
                  note: "bust and thumb are Sharp-resized crops from portrait_full.",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Portrait") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. 캐릭터 카드 UI ─────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_character_card",
    {
      title: "Generate Character Selection Card (Sharp Composite)",
      description: `Generate character selection screen card UI by compositing portrait and card frame using Sharp (no AI regeneration).

Produces two versions:
  - Unlocked card: portrait + rarity frame + character name + stats
  - Locked card: same but with a dark overlay and lock icon

Rarity colors:
  - S: Gold (#FFD700), A: Purple (#AA44FF), B: Blue (#4488FF), C: Green (#44AA44), D: Gray (#888888)

Args:
  - portrait_bust_path (string): Path to the bust portrait PNG (512×512 recommended)
  - rarity (string): Card rarity tier — "S" | "A" | "B" | "C" | "D"
  - character_name (string): Character display name
  - character_id (string): Character identifier for file naming
  - stats (object, optional): { hp?, atk?, def?, spd? } stat values
  - is_locked (boolean, optional): Generate locked variant (default: false — always generates both)
  - output_dir (string, optional): Output directory

Returns:
  - {character_id}_card_unlocked.png (384×576)
  - {character_id}_card_locked.png   (384×576)`,
      inputSchema: z.object({
        portrait_bust_path: z.string().min(1).describe("Path to the bust portrait PNG"),
        rarity: z.enum(["S", "A", "B", "C", "D"]).describe("Card rarity tier"),
        character_name: z.string().min(1).max(100).describe("Character display name"),
        character_id: z.string().min(1).max(100).describe("Character identifier for file naming"),
        stats: z
          .object({
            hp: z.number().optional(),
            atk: z.number().optional(),
            def: z.number().optional(),
            spd: z.number().optional(),
          })
          .optional()
          .describe("Character stats to display on the card"),
        is_locked: z.boolean().default(false).describe("Whether the card is in locked state (both versions always generated)"),
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
        const safeCharId = params.character_id.replace(/[^a-zA-Z0-9_-]/g, "_");

        const CARD_WIDTH = 384;
        const CARD_HEIGHT = 576;
        const PORTRAIT_AREA_HEIGHT = Math.round(CARD_HEIGHT * 0.65);
        const INFO_AREA_Y = PORTRAIT_AREA_HEIGHT;
        const INFO_AREA_HEIGHT = CARD_HEIGHT - PORTRAIT_AREA_HEIGHT;

        const resolvedPortrait = path.resolve(params.portrait_bust_path);
        if (!fs.existsSync(resolvedPortrait)) {
          throw new Error(`Portrait bust image not found: ${resolvedPortrait}`);
        }

        const rarityColor = RARITY_COLORS[params.rarity] ?? "#888888";
        const rarityDarkColor = RARITY_DARK_COLORS[params.rarity] ?? "#444444";

        // 1. Card background SVG
        const cardBgSvg = buildCardBackgroundSvg(CARD_WIDTH, CARD_HEIGHT, rarityColor, rarityDarkColor);
        const cardBgBuffer = await sharp(Buffer.from(cardBgSvg)).png().toBuffer();

        // 2. Resize portrait to fit portrait area (leaving margins)
        const portraitFitWidth = CARD_WIDTH - 24;
        const portraitFitHeight = PORTRAIT_AREA_HEIGHT - 16;
        const portraitResized = await sharp(resolvedPortrait)
          .resize(portraitFitWidth, portraitFitHeight, {
            fit: "contain",
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          })
          .png()
          .toBuffer();

        // 3. Info area SVG (name + rarity + stats)
        const statsLines: string[] = [];
        if (params.stats) {
          const s = params.stats;
          const parts: string[] = [];
          if (s.hp != null) parts.push(`HP:${s.hp}`);
          if (s.atk != null) parts.push(`ATK:${s.atk}`);
          if (s.def != null) parts.push(`DEF:${s.def}`);
          if (s.spd != null) parts.push(`SPD:${s.spd}`);
          if (parts.length > 0) statsLines.push(parts.join("  "));
        }

        const statsY = INFO_AREA_Y + 70;
        const statsSvgText = statsLines.length > 0
          ? `<text x="${CARD_WIDTH / 2}" y="${statsY}"
               text-anchor="middle"
               font-family="Arial, Helvetica, sans-serif"
               font-size="14"
               fill="#CCCCCC"
             >${statsLines[0]}</text>`
          : "";

        const infoSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CARD_WIDTH}" height="${CARD_HEIGHT}">
  <!-- Character name -->
  <text x="${CARD_WIDTH / 2}" y="${INFO_AREA_Y + 32}"
    text-anchor="middle"
    font-family="Arial Black, Arial, Helvetica, sans-serif"
    font-size="22"
    font-weight="bold"
    fill="${rarityColor}"
    stroke="#000000"
    stroke-width="1"
    paint-order="stroke fill"
  >${params.character_name}</text>
  <!-- Rarity badge -->
  <rect x="${CARD_WIDTH / 2 - 20}" y="${INFO_AREA_Y + 40}" width="40" height="20" rx="4" ry="4"
    fill="${rarityColor}" opacity="0.9"/>
  <text x="${CARD_WIDTH / 2}" y="${INFO_AREA_Y + 55}"
    text-anchor="middle"
    font-family="Arial Black, Arial, Helvetica, sans-serif"
    font-size="13"
    font-weight="bold"
    fill="#000000"
  >${params.rarity}</text>
  ${statsSvgText}
</svg>`;

        const infoBuffer = await sharp(Buffer.from(infoSvg)).png().toBuffer();

        // 4. Composite: background + portrait + info
        const unlockedBuffer = await sharp(cardBgBuffer)
          .composite([
            { input: portraitResized, left: 12, top: 8 },
            { input: infoBuffer, left: 0, top: 0 },
          ])
          .png()
          .toBuffer();

        // 5. Locked version: dark overlay + lock icon
        const lockedOverlaySvg = buildLockedOverlaySvg(CARD_WIDTH, CARD_HEIGHT);
        const lockedOverlayBuffer = await sharp(Buffer.from(lockedOverlaySvg)).png().toBuffer();

        const lockedBuffer = await sharp(unlockedBuffer)
          .composite([{ input: lockedOverlayBuffer, left: 0, top: 0 }])
          .png()
          .toBuffer();

        // Save files
        const cardDir = path.resolve(outputDir, `ui/cards`);
        ensureDir(cardDir);

        const unlockedFileName = `${safeCharId}_card_unlocked.png`;
        const lockedFileName = `${safeCharId}_card_locked.png`;
        const unlockedFilePath = path.join(cardDir, unlockedFileName);
        const lockedFilePath = path.join(cardDir, lockedFileName);

        fs.writeFileSync(unlockedFilePath, unlockedBuffer);
        fs.writeFileSync(lockedFilePath, lockedBuffer);

        const baseAsset = {
          type: "image" as const,
          asset_type: "ui_element",
          provider: "sharp-composite",
          prompt: `Character card for ${params.character_name} (${params.rarity})`,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
        };

        const assetUnlocked: GeneratedAsset = {
          ...baseAsset,
          id: generateAssetId(),
          file_path: unlockedFilePath,
          file_name: unlockedFileName,
          metadata: {
            character_id: params.character_id,
            character_name: params.character_name,
            rarity: params.rarity,
            locked: false,
            stats: params.stats,
          },
        };

        const assetLocked: GeneratedAsset = {
          ...baseAsset,
          id: generateAssetId(),
          file_path: lockedFilePath,
          file_name: lockedFileName,
          metadata: {
            character_id: params.character_id,
            character_name: params.character_name,
            rarity: params.rarity,
            locked: true,
            stats: params.stats,
          },
        };

        saveAssetToRegistry(assetUnlocked, outputDir);
        saveAssetToRegistry(assetLocked, outputDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  character_id: params.character_id,
                  character_name: params.character_name,
                  rarity: params.rarity,
                  card_size: `${CARD_WIDTH}x${CARD_HEIGHT}`,
                  files: {
                    unlocked: unlockedFilePath,
                    locked: lockedFilePath,
                  },
                  note: "Both unlocked and locked card variants generated using Sharp composite (no AI calls).",
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Card") }],
          isError: true,
        };
      }
    }
  );

  // ── 3. 아바타 커스터마이징 파츠 ────────────────────────────────────────────
  server.registerTool(
    "asset_generate_avatar_parts",
    {
      title: "Generate Avatar Customization Parts",
      description: `Generate avatar customization part set images using gpt-image-1.

All parts are generated at 1024×1024 with transparent backgrounds, matching the canvas size
of the base character for anchor-point-based compositing in game engines.

Supported categories: hair, outfit_top, outfit_bottom, shoes, accessory, weapon_skin

Args:
  - character_base_path (string): Path to the base character image (for style reference)
  - category (string): Part category — hair | outfit_top | outfit_bottom | shoes | accessory | weapon_skin
  - items (array): List of parts to generate. Each: { id, name, description }
  - style_description (string, optional): Visual art style for all parts
  - output_dir (string, optional): Output directory

Returns:
  - {id}_part.png for each item (transparent PNG, 1024×1024)
  ★ All parts use the same 1024×1024 canvas as the base character for coordinate-aligned compositing.`,
      inputSchema: z.object({
        character_base_path: z.string().min(1).describe("Path to the base character image (style reference)"),
        category: z
          .enum(["hair", "outfit_top", "outfit_bottom", "shoes", "accessory", "weapon_skin"])
          .describe("Part category"),
        items: z
          .array(
            z.object({
              id: z.string().min(1).max(100).describe("Part identifier for file naming"),
              name: z.string().min(1).max(100).describe("Display name of the part"),
              description: z.string().min(1).max(500).describe("Visual description of the part"),
            })
          )
          .min(1)
          .max(20)
          .describe("Parts to generate"),
        style_description: z.string().max(500).optional()
          .describe("Art style for all parts (should match the base character's style)"),
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
        const CANVAS_SIZE = 1024;

        // Validate base character path
        const resolvedBase = path.resolve(params.character_base_path);
        if (!fs.existsSync(resolvedBase)) {
          throw new Error(`Base character image not found: ${resolvedBase}`);
        }

        const styleHint = params.style_description
          ? ` Art style: ${params.style_description}.`
          : " Clean 2D game character art style matching the base character.";

        const CATEGORY_HINTS: Record<string, string> = {
          hair: "hairstyle only, positioned at the top of a 1024x1024 canvas where the character's head would be",
          outfit_top: "upper body clothing/armor only, positioned on the upper torso area of a 1024x1024 canvas",
          outfit_bottom: "lower body clothing/pants only, positioned on the lower body area of a 1024x1024 canvas",
          shoes: "footwear/shoes only, positioned at the bottom of a 1024x1024 canvas where feet would be",
          accessory: "accessory item only (jewelry, bag, hat, etc.), positioned appropriately on a 1024x1024 canvas",
          weapon_skin: "weapon visual skin/decoration overlay, centered on a 1024x1024 canvas",
        };

        const categoryHint = CATEGORY_HINTS[params.category] ?? "part item only";
        const partsDir = path.resolve(outputDir, `avatars/parts/${params.category}`);
        ensureDir(partsDir);

        const results: Array<{
          id: string;
          name: string;
          success: boolean;
          file_path?: string;
          error?: string;
        }> = [];

        for (const item of params.items) {
          try {
            const prompt =
              `A single avatar customization part: "${item.name}" — ${item.description}. ` +
              `Category: ${categoryHint}. ` +
              `CRITICAL: The part must be drawn on a 1024×1024 canvas at the exact position where it would ` +
              `appear on the character's body. The character body itself is NOT drawn — only this part. ` +
              `Transparent background. No other body parts, no character body, just the ${params.category} part. ` +
              `${styleHint} Transparent PNG, isolated part only. ` +
              `${NO_TEXT_IN_IMAGE}`;

            const result = await generateImageOpenAI({
              prompt,
              model: "gpt-image-1",
              size: "1024x1024",
              quality: "medium",
              background: "transparent",
            });

            const rawBuffer = Buffer.from(result.base64, "base64");

            // Ensure exact 1024×1024 canvas (no resize — preserve position)
            const finalBuffer = await sharp(rawBuffer)
              .resize(CANVAS_SIZE, CANVAS_SIZE, {
                fit: "contain",
                background: { r: 0, g: 0, b: 0, alpha: 0 },
              })
              .png()
              .toBuffer();

            const safeId = item.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            const fileName = `${safeId}_part.png`;
            const filePath = path.join(partsDir, fileName);
            fs.writeFileSync(filePath, finalBuffer);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "other",
              provider: "openai",
              prompt,
              file_path: filePath,
              file_name: fileName,
              mime_type: "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                part_id: item.id,
                part_name: item.name,
                category: params.category,
                canvas_size: CANVAS_SIZE,
                character_base_path: resolvedBase,
              },
            };
            saveAssetToRegistry(asset, outputDir);

            results.push({ id: item.id, name: item.name, success: true, file_path: filePath });
          } catch (err) {
            results.push({
              id: item.id,
              name: item.name,
              success: false,
              error: handleApiError(err, `Avatar Part: ${item.id}`),
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
                  category: params.category,
                  parts_dir: partsDir,
                  canvas_size: `${CANVAS_SIZE}x${CANVAS_SIZE}`,
                  total: results.length,
                  succeeded,
                  failed: results.length - succeeded,
                  results,
                  note: `All parts use ${CANVAS_SIZE}x${CANVAS_SIZE} canvas matching base character. Use anchor-point compositing in your game engine.`,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Avatar Parts") }],
          isError: true,
        };
      }
    }
  );
}
