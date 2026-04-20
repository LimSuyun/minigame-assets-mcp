import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, NO_TEXT_IN_IMAGE, NO_SHADOW_IN_IMAGE, CHIBI_STYLE_DEFAULT } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { generateImageGemini, editImageGemini } from "../services/gemini.js";
import {
  buildAssetPath,
  generateFileName,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import {
  composeSpritSheet,
  exportPhaserAtlas,
  exportCocosPlist,
  exportUnityJson,
  type FrameInfo,
} from "../utils/spritesheet-composer.js";
import { handleApiError } from "../utils/errors.js";
import { processFrameBase64, removeBackground, compositeOntoSolidBg, processFrameBase64AI, processFrameBase64Chroma } from "../utils/image-process.js";
import { checkSpriteFrameQuality } from "../services/claude-vision.js";
import { editImageOpenAI } from "../services/openai.js";
import type { GameConcept, GeneratedAsset } from "../types.js";

// ─── 기본 액션 세트 ──────────────────────────────────────────────────────────

export const DEFAULT_ACTIONS = [
  "idle",
  "walk",
  "run",
  "jump",
  "attack",
  "hurt",
  "die",
] as const;

export type DefaultAction = (typeof DEFAULT_ACTIONS)[number];

// 각 액션별 포즈 설명 (buildActionEditPrompt에서 사용)
export const ACTION_PROMPTS: Record<DefaultAction, string> = {
  idle: "neutral idle standing pose, body relaxed, subtle weight shift to one side",
  walk: "mid-walk pose, one leg stepping forward, arms naturally swinging in opposition",
  run: "running pose, body leaning slightly forward, legs in a full running stride",
  jump: "at the peak of a jump, body slightly curled, legs bent upward",
  attack: "attack pose — arm or weapon raised and thrusting forward with force",
  hurt: "hurt/damaged reaction — leaning back slightly, grimacing expression, arms up defensively",
  die: "falling or knocked-down pose, body going limp toward the ground",
};

/**
 * 일관성 유지 특화 편집 프롬프트 생성.
 * gpt_image_gen_mcp 방식: "Redraw this exact character..." 패턴.
 * 투명 배경 지시어 포함 (Gemini가 캐릭터 내부 흰색은 보존하고 배경만 제거).
 */
// 순백 배경 방식 — 배경은 순백(#FFFFFF), 캐릭터 내 순백 사용 금지
const WHITE_BG_COLOR: [number, number, number] = [255, 255, 255];
// flood-fill 제거 임계값: R,G,B 모두 이 값 초과 픽셀만 배경으로 제거 (순백에 가까운 픽셀만 제거)
const WHITE_BG_THRESHOLD = 250;
const WHITE_BG_PROMPT =
  "pure white (#FFFFFF) background — perfectly uniform solid white, " +
  "absolutely no gradients, no shadows, no texture on the background. " +
  "CRITICAL: the character itself must NOT contain any pure white (#FFFFFF) pixels — " +
  "use off-white or light cream (at most rgb(220,220,220)) for any light-colored areas on the character";

function buildActionEditPrompt(poseDescription: string, characterHint?: string): string {
  return (
    `Redraw this exact character in the following pose or action: ${poseDescription}. ` +
    `Preserve every visual detail from the reference image exactly — ` +
    `same face, same body shape and proportions, same outfit and colors, same accessories and items. ` +
    `Only the pose or action changes. Nothing is added or removed. ` +
    (characterHint ? `Character description for reference: ${characterHint}. ` : "") +
    `CRITICAL — framing and body visibility: ` +
    `The ENTIRE body from the very top of the head to the very tips of the feet MUST be fully visible — NEVER clip or cut off any body part. ` +
    `If the action requires more space, make the character SMALLER to fit — do NOT crop. ` +
    `The character must NOT exceed 70% of the total image height. ` +
    `Leave at least 15% empty margin at the top and 15% at the bottom. ` +
    `Keep the same camera distance and framing as the reference. ` +
    `${WHITE_BG_PROMPT}. ` +
    `${NO_SHADOW_IN_IMAGE} ` +
    `${NO_TEXT_IN_IMAGE}`
  );
}

const TRANSPARENCY_SUFFIX = ` ${WHITE_BG_PROMPT}.`;

// 크로마키 색상 목록 (캐릭터에 사용되지 않을 색상 권장)
export const CHROMA_KEY_COLORS: Record<string, [number, number, number]> = {
  magenta:   [255,   0, 255],
  lime:      [  0, 255,   0],
  cyan:      [  0, 255, 255],
  blue:      [  0,   0, 255],
};

export const DEFAULT_CHROMA_KEY = "magenta";

function chromaKeyColorToName(color: [number, number, number]): string {
  const [r, g, b] = color;
  return `rgb(${r},${g},${b}) — solid flat color, no gradients, no shadows, no texture`;
}

// ─── 헬퍼 함수 ───────────────────────────────────────────────────────────────

function loadConceptHint(conceptFile: string): string {
  const resolved = path.resolve(conceptFile);
  if (!fs.existsSync(resolved)) return "";
  const concept = JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameConcept;
  return `Game: ${concept.game_name}. Style: ${concept.art_style}. Colors: ${concept.color_palette.join(", ")}.`;
}

function readImageAsBase64(filePath: string): { base64: string; mimeType: string } {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Character base image not found: ${resolved}`);
  }
  const data = fs.readFileSync(resolved);
  const base64 = data.toString("base64");
  const ext = path.extname(resolved).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    ext === ".webp" ? "image/webp" :
    "image/png";
  return { base64, mimeType };
}

function buildBaseCharacterPrompt(
  description: string,
  conceptHint: string,
  chromaKeyColor?: [number, number, number]
): string {
  const bgInstruction = chromaKeyColor
    ? `Solid flat ${chromaKeyColorToName(chromaKeyColor)} background — uniform single color, no gradients, no shadows on the background itself.`
    : `transparent background.`;

  return (
    `A single 2D game character sprite on a ${bgInstruction} ` +
    `${CHIBI_STYLE_DEFAULT} ` +
    `Character: ${description}. ` +
    `Neutral front-facing stance, body relaxed, arms at sides. ` +
    `ENTIRE full body visible — top of head to very tips of feet, all accessories included. ` +
    `Character must NOT exceed 65% of image height — leave at least 15% margin at top and 20% at bottom. ` +
    (conceptHint ? `Color palette reference: ${conceptHint} ` : "") +
    `${NO_SHADOW_IN_IMAGE} ` +
    `${NO_TEXT_IN_IMAGE}`
  );
}

// ─── 스프라이트 매니페스트 ────────────────────────────────────────────────────

interface SpriteFrame {
  name: string;
  file_path: string;
  file_name: string;
  action: string;
  frame_index: number;
}

interface SpriteSheetManifest {
  character_name: string;
  base_character_path: string;
  frames: SpriteFrame[];
  animations: Record<string, string[]>;
  created_at: string;
  provider: string;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerSpriteTools(server: McpServer): void {
  // ── 1. 기본 캐릭터 생성 ────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_character_base",
    {
      title: "Generate Base Character Sprite",
      description: `Generate the original base character sprite for a game.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 created_assets/prompts/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로를 읽고 추가 질문 없이 바로 생성을 진행하세요.

This creates the "master" character image that all action sprites will be derived from.
After generating, use asset_generate_action_sprite or asset_generate_sprite_sheet
to create action variants using Gemini image editing (preserving the original design).

Args:
  - character_name (string): Identifier for this character (used in file names)
  - description (string): Detailed character description (appearance, clothing, style, etc.)
  - provider (string): "openai" (DALL-E 3, default) or "gemini" (Imagen 4)
  - size (string, optional): For OpenAI — "1024x1024" (default), "1024x1792"
  - aspect_ratio (string, optional): For Gemini — "1:1" (default), "3:4"
  - bg_threshold (number, optional): White background removal threshold 0-255 (default: 240)
  - use_concept (boolean, optional): Inject game concept into prompt (default: true)
  - concept_file (string, optional): Path to game concept JSON
  - output_dir (string, optional): Output directory

Returns:
  File path of the saved base character image (transparent PNG) and asset metadata.
  Save the file_path — you will pass it to sprite generation tools.`,
      inputSchema: z.object({
        character_name: z.string().min(1).max(100).describe("Character identifier (e.g., hero, enemy_slime)"),
        description: z.string().min(10).max(3000).describe("Detailed character appearance description"),
        provider: z.enum(["openai", "gemini"]).default("openai").describe("AI provider"),
        model: z.string().optional().describe("Model override: gpt-image-1 (OpenAI, default) | imagen-4.0-generate-001 (Gemini)"),
        size: z.enum(["1024x1024", "1024x1792", "1536x1024", "1024x1536"]).default("1024x1024").describe("Image size (OpenAI only)"),
        aspect_ratio: z.enum(["1:1", "3:4"]).default("1:1").describe("Aspect ratio (Gemini only)"),
        bg_threshold: z.number().int().min(0).max(255).default(240).describe("White background removal threshold (0-255). Ignored when using gpt-image-1 or chroma_key_bg."),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("Chroma key background color. AI draws a solid flat background in this color; later removed precisely with asset_remove_background. Recommended: 'magenta'. Leave empty to use white (default) or gpt-image-1 transparent output."),
        use_concept: z.boolean().default(true).describe("Inject game concept into prompt"),
        concept_file: z.string().optional().describe("Path to game concept JSON"),
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
        const conceptFile = params.concept_file || DEFAULT_CONCEPT_FILE;
        const conceptHint = params.use_concept ? loadConceptHint(conceptFile) : "";

        const chromaKeyColor = params.chroma_key_bg
          ? CHROMA_KEY_COLORS[params.chroma_key_bg] as [number, number, number]
          : undefined;

        const prompt = buildBaseCharacterPrompt(
          `${params.description}. This is the BASE reference character — all details must be precise and consistent.`,
          conceptHint,
          chromaKeyColor
        );

        let base64: string;
        let mimeType: string;

        const effectiveModel = params.model ?? "gpt-image-1.5";
        const isGptImage1 = effectiveModel.startsWith("gpt-image-1") || !params.model;

        if (params.provider === "gemini") {
          const r = await generateImageGemini({
            prompt,
            model: effectiveModel as "imagen-4.0-generate-001" | "imagen-4.0-fast-generate-001" | "imagen-4.0-ultra-generate-001" | undefined,
            aspectRatio: params.aspect_ratio,
          });
          base64 = r.base64;
          mimeType = r.mimeType;
        } else {
          const r = await generateImageOpenAI({
            prompt,
            size: params.size,
            quality: "high",
            background: "transparent",
          });
          base64 = r.base64;
          mimeType = r.mimeType;
        }

        // gpt-image-1은 네이티브 투명 PNG 반환 → flood-fill 불필요
        let processedBuffer: Buffer;
        let processedBase64: string;
        if (isGptImage1) {
          processedBuffer = Buffer.from(base64, "base64");
          processedBase64 = base64;
        } else if (chromaKeyColor) {
          // 크로마키 모드: 임시 파일에 저장 후 색상 거리 기반 배경 제거
          const tmpIn = path.join(
            process.env["TMPDIR"] || "/tmp",
            `chroma_in_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
          );
          const tmpOut = tmpIn.replace("_in_", "_out_");
          try {
            fs.writeFileSync(tmpIn, Buffer.from(base64, "base64"));
            await removeBackground(tmpIn, tmpOut, {
              chromaKeyColor,
              cropToContent: true,
            });
            processedBuffer = fs.readFileSync(tmpOut);
            processedBase64 = processedBuffer.toString("base64");
          } finally {
            if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
            if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          }
        } else {
          processedBuffer = await processFrameBase64(base64, params.bg_threshold);
          processedBase64 = processedBuffer.toString("base64");
        }

        const safeCharName = params.character_name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `${safeCharName}_base.png`;
        const filePath = buildAssetPath(outputDir, `sprites/${safeCharName}`, fileName);
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, processedBuffer);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "character",
          provider: params.provider,
          prompt: params.description,
          file_path: filePath,
          file_name: fileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            character_name: params.character_name,
            is_base_character: true,
          },
        };

        saveAssetToRegistry(asset, outputDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                character_name: params.character_name,
                file_path: filePath,
                asset_id: asset.id,
                provider: params.provider,
                note: "Transparent PNG saved. Pass file_path to asset_generate_action_sprite or asset_generate_sprite_sheet.",
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Base") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. 단일 액션 스프라이트 (Gemini Edit 기반) ─────────────────────────────
  server.registerTool(
    "asset_generate_action_sprite",
    {
      title: "Generate Character Action Sprite (Gemini Edit)",
      description: `Generate a single action sprite by editing the base character image using Gemini.

Gemini's image editing preserves the original character's colors, style, and proportions
while only changing the pose/expression for the specified action.

**Background Removal Method:**
- chroma_key_bg = "magenta" (recommended): Composites on magenta (#FF00FF) before Gemini edit,
  then removes it with color-distance algorithm. Better edge quality, fewer artifacts.
- chroma_key_bg not set: Uses white background flood-fill (legacy, may damage light-colored edges).

Args:
  - base_character_path (string): File path to the base character image (from asset_generate_character_base)
  - action (string): Action name — use a preset ("idle","walk","run","jump","attack","hurt","die")
                     or a custom action name with custom_prompt
  - custom_prompt (string, optional): Custom editing instruction (overrides preset action prompt)
                    Example: "Show character charging a magic fireball, arms glowing"
  - chroma_key_bg (string, optional): Intermediate background color for Gemini edit. Recommended: "magenta".
                    Leave empty to use legacy white background flood-fill.
  - character_name (string, optional): Character identifier for file naming
  - frame_index (number, optional): Frame number within an animation (default: 0)
  - output_dir (string, optional): Output directory

Returns:
  File path of the saved action sprite, Gemini-edited to match the base character.`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("Path to base character image file"),
        action: z.string().min(1).max(100).describe("Action name (idle/walk/run/jump/attack/hurt/die or custom)"),
        custom_prompt: z.string().max(2000).optional().describe("Custom edit instruction (overrides preset)"),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("Intermediate background color for Gemini edit. Recommended: 'magenta'. Better edge quality than white flood-fill."),
        character_name: z.string().max(100).optional().describe("Character identifier for file naming"),
        frame_index: z.number().int().min(0).max(99).default(0).describe("Frame number in animation"),
        edit_model: z.string().default("gemini-2.5-flash-image").describe("Gemini model for image editing (gemini-2.5-flash-image supports image input/output)"),
        bg_threshold: z.number().int().min(0).max(255).default(240).describe("White background removal threshold (0-255). Used only when chroma_key_bg is not set."),
        frame_padding: z.number().int().min(0).max(300).default(20).describe("Padding pixels added around each sprite (prevents edge cropping). Default: 20"),
        quality_check: z.boolean().default(false).describe("Claude 비전으로 품질 검증 후 문제 시 OpenAI gpt-image-1로 자동 재생성. 기본: false"),
        character_hint: z.string().max(500).optional().describe("품질 검증에 사용할 캐릭터 설명 (예: 'green alien in black armor')"),
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

        // 원본 이미지 읽기
        const { base64: origBase64, mimeType: origMime } = readImageAsBase64(params.base_character_path);

        // 편집 프롬프트 결정 (buildActionEditPrompt 패턴 사용)
        const isPresetAction = DEFAULT_ACTIONS.includes(params.action as DefaultAction);
        const poseDescription = isPresetAction
          ? ACTION_PROMPTS[params.action as DefaultAction]
          : params.action;

        // 크로마키 배경 색상 결정 (마젠타 권장 — 캐릭터에 존재하지 않는 색상)
        const chromaKeyColor = params.chroma_key_bg
          ? CHROMA_KEY_COLORS[params.chroma_key_bg] as [number, number, number]
          : undefined;

        const finalEditPrompt = params.custom_prompt ?? buildActionEditPrompt(poseDescription);

        // Gemini는 투명 PNG를 받으면 체크 무늬로 렌더링함 → 단색 배경에 합성
        const bgColor = chromaKeyColor ?? WHITE_BG_COLOR;
        const compositedBuffer = await compositeOntoSolidBg(params.base_character_path, bgColor);
        const compositedBase64 = compositedBuffer.toString("base64");

        const result = await editImageGemini({
          imageBase64: compositedBase64,
          imageMimeType: "image/png",
          editPrompt: finalEditPrompt,
          model: params.edit_model,
        });

        // 배경 제거: 크로마키 모드 (색상 거리 기반) 또는 순백 flood-fill
        let processedBuffer: Buffer;
        if (chromaKeyColor) {
          // 마젠타 등 단색 배경 → 색상 거리 알고리즘으로 정밀 제거 (엣지 품질 우수)
          processedBuffer = await processFrameBase64Chroma(result.base64, chromaKeyColor);
        } else {
          // 레거시: 순백 배경 flood-fill (임계값 기반)
          processedBuffer = await processFrameBase64(result.base64, WHITE_BG_THRESHOLD);
        }
        if (params.frame_padding > 0) {
          const { addPaddingToBuffer } = await import("../utils/image-process.js");
          processedBuffer = await addPaddingToBuffer(processedBuffer, params.frame_padding);
        }
        let qualityIssues: string[] = [];
        let usedFallback = false;

        // ── Claude 품질 검증 + OpenAI fallback ──────────────────────────────
        if (params.quality_check) {
          const qc = await checkSpriteFrameQuality(
            processedBuffer.toString("base64"),
            params.character_hint
          );
          if (!qc.passed) {
            qualityIssues = qc.issues;
            console.warn(`[quality-check] 품질 미달 (${qc.issues.join(", ")}) → OpenAI fallback`);
            try {
              const fallbackPoseDesc = params.custom_prompt
                ?? `${poseDescription}. Full body visible, transparent background, single character, no clipping.`;
              const fallbackResult = await editImageOpenAI({
                imagePath: params.base_character_path,
                prompt: fallbackPoseDesc,
                size: "1024x1024",
              });
              processedBuffer = await processFrameBase64AI(fallbackResult.base64, params.frame_padding);
              usedFallback = true;
            } catch (fallbackErr) {
              console.warn("[quality-check] OpenAI fallback 실패:", fallbackErr);
            }
          }
        }

        const processedBase64 = processedBuffer.toString("base64");

        const charName = params.character_name ??
          path.basename(params.base_character_path).replace(/_base\.[^.]+$/, "");
        const safeCharName = charName.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeAction = params.action.replace(/[^a-zA-Z0-9_-]/g, "_");
        const fileName = `${safeCharName}_${safeAction}_f${String(params.frame_index).padStart(2, "0")}.png`;
        const filePath = buildAssetPath(outputDir, `sprites/${safeCharName}`, fileName);
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, processedBuffer);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "sprite",
          provider: "gemini-edit",
          prompt: finalEditPrompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            character_name: charName,
            action: params.action,
            frame_index: params.frame_index,
            base_character_path: params.base_character_path,
          },
        };

        saveAssetToRegistry(asset, outputDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                file_path: filePath,
                asset_id: asset.id,
                action: params.action,
                frame_index: params.frame_index,
                provider: usedFallback ? "openai-fallback" : "gemini-edit",
                quality_check: params.quality_check
                  ? { passed: qualityIssues.length === 0, issues: qualityIssues, fallback_used: usedFallback }
                  : undefined,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Gemini Image Edit") }],
          isError: true,
        };
      }
    }
  );

  // ── 3. 스프라이트 시트 (여러 액션 일괄 생성 + 엔진별 내보내기) ───────────
  server.registerTool(
    "asset_generate_sprite_sheet",
    {
      title: "Generate Full Sprite Sheet (Gemini Edit)",
      description: `Generate a complete sprite sheet by creating multiple action frame sprites
from a base character image using Gemini image editing, then export in game engine formats.

All action sprites are generated via Gemini image edit to preserve the original
character's colors, proportions, and art style.

**Pose-First Pattern (권장):**
  1. asset_generate_character_base → 베이스 캐릭터 생성
  2. (선택) asset_generate_character_pose → 포즈 승인 이미지 생성
  3. asset_generate_sprite_sheet (pose_image 파라미터) → 포즈 이미지 기준으로 시트 생성
  pose_image를 제공하면 Gemini 편집 기준 이미지가 base_character_path 대신 pose_image로 교체됩니다.
  base_character_path는 메타데이터/매니페스트 참조용으로만 사용됩니다.

Args:
  - base_character_path (string): File path to the base character image (메타데이터 참조용)
  - pose_image (string, optional): Pose-First 패턴용. 포즈 승인 이미지 경로.
      제공 시 Gemini 편집 기준 이미지로 사용 (base_character_path 대체).
      asset_generate_character_pose로 생성한 포즈 이미지를 넣으세요.
  - character_name (string): Character identifier for file naming and manifest
  - actions (string[], optional): Actions to generate.
      Presets: "idle", "walk", "run", "jump", "attack", "hurt", "die"
      Default: all 7 presets
  - frames_per_action (number, optional): Frames per action for animation (default: 1, max: 8)
  - custom_action_prompts (object, optional): Override edit prompts per action.
      Example: { "attack": "Character shooting a laser beam from their hand" }
  - export_formats (string[], optional): Engine-specific export formats to generate.
      "individual" — individual PNG files only (always included)
      "phaser"     — sprite sheet PNG + Phaser 3 texture atlas JSON
      "cocos"      — sprite sheet PNG + Cocos Creator .plist (Cocos2d format)
      "unity"      — sprite sheet PNG + Unity slice JSON (TexturePacker compatible)
      Default: ["individual"]
  - sheet_padding (number, optional): Pixel gap between frames in the sheet (default: 0)
  - output_dir (string, optional): Output directory

Returns:
  Individual frame files + composed sprite sheet(s) + engine-specific metadata files.
  Output: {output_dir}/sprites/{character_name}/`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("Path to base character image file (메타데이터/매니페스트 참조용. pose_image 제공 시 Gemini 편집에는 사용되지 않음)"),
        pose_image: z.string().optional().describe(
          "Pose-First 패턴: 포즈 승인 이미지 경로. 제공 시 Gemini 편집 기준 이미지로 사용 (base_character_path 대체). " +
          "asset_generate_character_pose 결과물을 여기에 넣으세요."
        ),
        character_name: z.string().min(1).max(100).describe("Character identifier"),
        prompt_file: z.string().optional().describe(
          "Path to sprite prompt JSON file. If provided, loads actions / custom_action_prompts / frames_per_action / edit_model from it. Explicit params take precedence."
        ),
        actions: z.array(z.string()).min(1).max(20)
          .default(["idle", "walk", "run", "jump", "attack", "hurt", "die"])
          .describe("Actions to generate (overrides prompt_file if set)"),
        frames_per_action: z.number().int().min(1).max(8).default(1)
          .describe("Frames per action (1=single, 2+=animation cycle)"),
        custom_action_prompts: z.record(z.string()).optional()
          .describe("Override edit prompts per action: { action_name: edit_prompt } (merges with prompt_file)"),
        edit_model: z.string().optional()
          .describe("Gemini model for image editing (default: gemini-2.5-flash-image). Can be set in prompt_file settings.edit_model."),
        export_formats: z.array(z.enum(["individual", "phaser", "cocos", "unity"]))
          .default(["individual"])
          .describe("Engine export formats: phaser / cocos / unity"),
        sheet_padding: z.number().int().min(0).max(64).default(0)
          .describe("Pixel padding between frames in the composed sheet"),
        frame_padding: z.number().int().min(0).max(300).default(20)
          .describe("Padding pixels added around each individual sprite frame (prevents edge cropping). Default: 20"),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("Intermediate background color for Gemini edit. Recommended: 'magenta'. Better edge quality than white flood-fill."),
        bg_threshold: z.number().int().min(0).max(255).default(240)
          .describe("White background removal threshold (0-255). Used only when chroma_key_bg is not set."),
        quality_check: z.boolean().default(false)
          .describe("각 프레임을 Claude 비전으로 품질 검증. 미달 시 OpenAI gpt-image-1로 자동 재생성. 기본: false"),
        character_hint: z.string().max(500).optional()
          .describe("품질 검증에 사용할 캐릭터 설명 (예: 'green alien soldier in black armor with baton')"),
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
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const safeCharName = params.character_name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const spriteDir = path.resolve(outputDir, `sprites/${safeCharName}`);
      ensureDir(spriteDir);

      // ── prompt_file에서 스프라이트 설정 로드 ─────────────────────────────────
      // actions 형식 두 가지 지원:
      //   배열 형식 (구): ["idle", "walk", "die"]
      //   객체 맵 형식 (신): { "idle": { "frames": 1, "prompt": "..." }, "walk": { "frames": 3, "prompt": "..." } }
      interface ActionConfig {
        frames?: number;
        prompt?: string;
      }
      interface SpritePromptFile {
        sprite?: {
          actions?: string[] | Record<string, ActionConfig>;
          frames_per_action?: number;  // 배열 형식일 때 전체 기본값
          custom_action_prompts?: Record<string, string>;
          export_formats?: Array<"individual" | "phaser" | "cocos" | "unity">;
          settings?: { edit_model?: string };
        };
        settings?: { edit_model?: string };
      }
      let fileConfig: SpritePromptFile = {};
      if (params.prompt_file) {
        try {
          const raw = fs.readFileSync(path.resolve(params.prompt_file), "utf-8");
          fileConfig = JSON.parse(raw) as SpritePromptFile;
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Error reading prompt_file: ${String(e)}` }],
            isError: true,
          };
        }
      }
      const spriteConfig = fileConfig.sprite ?? {};

      // actions 파싱 — 배열 vs 객체 맵 구분
      let fileActions: string[] | undefined;
      const perActionFrames: Record<string, number> = {};   // 액션별 프레임 수
      const fileActionPrompts: Record<string, string> = {}; // 객체 맵에서 추출한 프롬프트

      if (Array.isArray(spriteConfig.actions)) {
        fileActions = spriteConfig.actions;
      } else if (spriteConfig.actions && typeof spriteConfig.actions === "object") {
        fileActions = Object.keys(spriteConfig.actions);
        for (const [action, cfg] of Object.entries(spriteConfig.actions as Record<string, ActionConfig>)) {
          if (cfg.frames != null) perActionFrames[action] = cfg.frames;
          if (cfg.prompt)         fileActionPrompts[action] = cfg.prompt;
        }
      }

      // 명시적 파라미터 우선, 그 다음 prompt_file 값
      const defaultActions = ["idle","walk","run","jump","attack","hurt","die"];
      const effectiveActions: string[] =
        (params.actions && params.actions.join() !== defaultActions.join())
          ? params.actions
          : (fileActions ?? params.actions);

      const defaultFramesPerAction: number =
        params.frames_per_action !== 1
          ? params.frames_per_action
          : (spriteConfig.frames_per_action ?? 1);

      // 커스텀 프롬프트: 객체 맵 프롬프트 < custom_action_prompts < 파라미터
      const effectiveCustomPrompts: Record<string, string> = {
        ...fileActionPrompts,
        ...(spriteConfig.custom_action_prompts ?? {}),
        ...(params.custom_action_prompts ?? {}),
      };
      const effectiveEditModel: string =
        params.edit_model ??
        spriteConfig.settings?.edit_model ??
        fileConfig.settings?.edit_model ??
        "gemini-2.5-flash-image";

      // 원본 이미지 읽기 (메타데이터용)
      let origBase64: string;
      let origMime: string;
      try {
        const img = readImageAsBase64(params.base_character_path);
        origBase64 = img.base64;
        origMime = img.mimeType;
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "File Read") }],
          isError: true,
        };
      }

      // 크로마키 배경 결정 (마젠타 권장 — 엣지 품질 우수)
      const sheetChromaKeyColor = params.chroma_key_bg
        ? CHROMA_KEY_COLORS[params.chroma_key_bg] as [number, number, number]
        : undefined;

      // Pose-First 패턴: pose_image가 있으면 그걸 Gemini 편집 기준으로 사용
      // pose_image 없으면 base_character_path 사용 (기존 동작)
      const editSourcePath = params.pose_image ?? params.base_character_path;
      const poseFirstMode = !!params.pose_image;

      // Gemini 전송 전: 투명 PNG를 단색 배경 위에 합성 (체크무늬 방지)
      const sheetBgColor = sheetChromaKeyColor ?? WHITE_BG_COLOR;
      let compositedBase64 = origBase64;
      try {
        const compositedBuffer = await compositeOntoSolidBg(editSourcePath, sheetBgColor);
        compositedBase64 = compositedBuffer.toString("base64");
      } catch (_) {
        // 합성 실패 시 원본 그대로 사용 (base_character_path 폴백)
        if (poseFirstMode) {
          try {
            const fallbackBuffer = await compositeOntoSolidBg(params.base_character_path, sheetBgColor);
            compositedBase64 = fallbackBuffer.toString("base64");
          } catch (_2) {
            // base64 원본 그대로
          }
        }
      }

      const manifest: SpriteSheetManifest = {
        character_name: params.character_name,
        base_character_path: path.resolve(params.base_character_path),
        frames: [],
        animations: {},
        created_at: new Date().toISOString(),
        provider: "gemini-edit",
        ...(poseFirstMode ? { pose_image_path: path.resolve(editSourcePath) } : {}),
      } as SpriteSheetManifest & { pose_image_path?: string };

      const results: Array<{
        action: string;
        frame_index: number;
        success: boolean;
        file_path?: string;
        error?: string;
      }> = [];

      // 각 액션, 각 프레임 순서대로 생성
      for (const action of effectiveActions) {
        manifest.animations[action] = [];

        // 액션별 프레임 수: 객체 맵에 지정된 값 > 전체 기본값
        const actionFrameCount = perActionFrames[action] ?? defaultFramesPerAction;

        for (let frameIdx = 0; frameIdx < actionFrameCount; frameIdx++) {
          const isPreset = DEFAULT_ACTIONS.includes(action as DefaultAction);
          const poseDesc = isPreset
            ? ACTION_PROMPTS[action as DefaultAction]
            : action;

          let frameNote = "";
          if (actionFrameCount > 1) {
            const progress = frameIdx / (actionFrameCount - 1);
            frameNote = ` Frame ${frameIdx + 1}/${actionFrameCount} — pose at ${Math.round(progress * 100)}% through the motion.`;
          }

          const basePrompt =
            effectiveCustomPrompts?.[action] ??
            buildActionEditPrompt(poseDesc + frameNote);

          try {
            const result = await editImageGemini({
              imageBase64: compositedBase64,
              imageMimeType: "image/png",
              editPrompt: basePrompt,
              model: effectiveEditModel,
            });

            // 배경 제거: 크로마키 모드 또는 순백 flood-fill
            let processedBuffer: Buffer;
            if (sheetChromaKeyColor) {
              processedBuffer = await processFrameBase64Chroma(result.base64, sheetChromaKeyColor);
            } else {
              processedBuffer = await processFrameBase64(result.base64, WHITE_BG_THRESHOLD);
            }
            if (params.frame_padding > 0) {
              const { addPaddingToBuffer } = await import("../utils/image-process.js");
              processedBuffer = await addPaddingToBuffer(processedBuffer, params.frame_padding);
            }
            let frameQualityIssues: string[] = [];
            let frameFallbackUsed = false;

            // ── Claude 품질 검증 + OpenAI fallback ───────────────────────────
            if (params.quality_check) {
              const qc = await checkSpriteFrameQuality(
                processedBuffer.toString("base64"),
                params.character_hint
              );
              if (!qc.passed) {
                frameQualityIssues = qc.issues;
                console.warn(`[quality-check] ${params.character_name} ${action} f${frameIdx} 품질 미달 (${qc.issues.join(", ")}) → OpenAI fallback`);
                try {
                  const fallbackPrompt = effectiveCustomPrompts?.[action]
                    ?? `${poseDesc}${frameNote}. Full body fully visible with no clipping. Single character only. Clean transparent background.`;
                  const fallbackResult = await editImageOpenAI({
                    imagePath: params.base_character_path,
                    prompt: fallbackPrompt,
                    size: "1024x1024",
                  });
                  processedBuffer = await processFrameBase64AI(fallbackResult.base64, params.frame_padding);
                  frameFallbackUsed = true;
                } catch (fallbackErr) {
                  console.warn(`[quality-check] OpenAI fallback 실패:`, fallbackErr);
                }
              }
            }

            const safeAction = action.replace(/[^a-zA-Z0-9_-]/g, "_");
            const fileName = `${safeCharName}_${safeAction}_f${String(frameIdx).padStart(2, "0")}.png`;
            const filePath = path.join(spriteDir, fileName);
            fs.writeFileSync(filePath, processedBuffer);

            const frame: SpriteFrame = {
              name: `${action}_f${String(frameIdx).padStart(2, "0")}`,
              file_path: filePath,
              file_name: fileName,
              action,
              frame_index: frameIdx,
            };

            manifest.frames.push(frame);
            manifest.animations[action].push(frame.name);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "sprite",
              provider: "gemini-edit",
              prompt: basePrompt,
              file_path: filePath,
              file_name: fileName,
              mime_type: "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                character_name: params.character_name,
                action,
                frame_index: frameIdx,
                base_character_path: params.base_character_path,
              },
            };
            saveAssetToRegistry(asset, outputDir);

            results.push({
              action,
              frame_index: frameIdx,
              success: true,
              file_path: filePath,
              ...(params.quality_check ? {
                quality: {
                  passed: frameQualityIssues.length === 0,
                  issues: frameQualityIssues,
                  fallback_used: frameFallbackUsed,
                  provider: frameFallbackUsed ? "openai-fallback" : "gemini-edit",
                },
              } : {}),
            });
          } catch (error) {
            results.push({
              action,
              frame_index: frameIdx,
              success: false,
              error: handleApiError(error, "Gemini Edit"),
            });
          }
        }
      }

      // 매니페스트 저장
      const manifestPath = path.join(spriteDir, `${safeCharName}_manifest.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const succeeded = results.filter((r) => r.success).length;

      // ── 엔진별 스프라이트 시트 합성 & 내보내기 ────────────────────────────
      const exportedFiles: Record<string, string> = {};
      const exportErrors: Record<string, string> = {};
      const needsCompose = params.export_formats.some((f) => f !== "individual");

      if (needsCompose && succeeded > 0) {
        // 성공한 프레임만 수집
        const frameInfos: FrameInfo[] = manifest.frames
          .filter((f) => fs.existsSync(f.file_path))
          .map((f) => ({
            name: f.name,
            filePath: f.file_path,
            action: f.action,
            frameIndex: f.frame_index,
          }));

        if (frameInfos.length > 0) {
          try {
            const sheetPngPath = path.join(spriteDir, `${safeCharName}_sheet.png`);
            const sheet = await composeSpritSheet(
              frameInfos,
              sheetPngPath,
              params.sheet_padding
            );
            exportedFiles["sheet_png"] = sheetPngPath;

            if (params.export_formats.includes("phaser")) {
              const phaserPath = path.join(spriteDir, `${safeCharName}_phaser.json`);
              exportPhaserAtlas(sheet, phaserPath);
              exportedFiles["phaser_atlas_json"] = phaserPath;
            }

            if (params.export_formats.includes("cocos")) {
              const cocosPath = path.join(spriteDir, `${safeCharName}_cocos.plist`);
              exportCocosPlist(sheet, cocosPath);
              exportedFiles["cocos_plist"] = cocosPath;
            }

            if (params.export_formats.includes("unity")) {
              const unityPath = path.join(spriteDir, `${safeCharName}_unity.json`);
              exportUnityJson(sheet, params.character_name, unityPath);
              exportedFiles["unity_json"] = unityPath;
            }
          } catch (err) {
            exportErrors["compose"] = handleApiError(err, "SpriteSheet Compose");
          }
        }
      }

      const output = {
        success: succeeded > 0,
        character_name: params.character_name,
        sprite_dir: spriteDir,
        manifest_path: manifestPath,
        pose_first_mode: poseFirstMode,
        ...(poseFirstMode ? { pose_image_used: path.resolve(editSourcePath) } : {}),
        total_frames: results.length,
        succeeded,
        failed: results.length - succeeded,
        exported_files: exportedFiles,
        export_errors: Object.keys(exportErrors).length > 0 ? exportErrors : undefined,
        results,
        animations: Object.fromEntries(
          Object.entries(manifest.animations).map(([k, v]) => [k, v.length])
        ),
        engine_usage: {
          phaser: exportedFiles["phaser_atlas_json"]
            ? `Phaser.Loader.atlas('${params.character_name}', '${safeCharName}_sheet.png', '${safeCharName}_phaser.json')`
            : undefined,
          cocos: exportedFiles["cocos_plist"]
            ? `spriteFrameCache.addSpriteFramesWithFile('${safeCharName}_cocos.plist')`
            : undefined,
          unity: exportedFiles["unity_json"]
            ? `Import ${safeCharName}_sheet.png → Sprite Mode: Multiple → Slice by cell size (see unity_json for dimensions)`
            : undefined,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 4. 캐릭터 무기별 스프라이트 일괄 생성 ────────────────────────────────
  server.registerTool(
    "asset_generate_character_weapon_sprites",
    {
      title: "Generate Character Weapon Sprites (Structured 3-Frame Workflow)",
      description: `Generate a complete set of sprites for a character with multiple weapons.

For each weapon × action combination, generates exactly 3 animation frames:
  - Frame 0 (f00): Preparation pose — wind-up / ready stance
  - Frame 1 (f01): Peak action   — strike at full extension / peak of motion
  - Frame 2 (f02): Follow-through — recoil / settle / return

Supported actions: "idle" and "attack" (or custom)

Workflow:
  1. Prints a plan table before generating
  2. For each weapon, composes base image onto solid white (avoids Gemini checkerboard issue)
  3. Generates all 3 frames per action via Gemini image edit
  4. Strips white background → transparent PNG
  5. Returns structured manifest with all file paths

Args:
  - base_character_path (string): Original character image (any background — handled internally)
  - character_id (string): Character identifier for file naming (e.g. "male", "female")
  - weapons (array): List of weapons to generate sprites for. Each weapon:
      - id (string): weapon identifier, e.g. "exorcist-sword"
      - displayName (string): Human-readable name, e.g. "퇴마 장검"
      - idle_prompt (string): Describe how character holds/uses weapon in idle state
      - attack_f00_prompt (string): Frame 0 — preparation / wind-up pose description
      - attack_f01_prompt (string): Frame 1 — peak strike pose description
      - attack_f02_prompt (string): Frame 2 — follow-through / recoil pose description
  - actions (string[], optional): Which actions to generate. Default: ["idle", "attack"]
  - output_dir (string, optional): Root output directory

Returns:
  Plan table + manifest of all generated sprite file paths.`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("Path to base character image (any background)"),
        character_id: z.string().min(1).max(100).describe("Character identifier for file naming (e.g. 'male', 'female')"),
        weapons: z.array(z.object({
          id: z.string().min(1).describe("Weapon ID for file naming (e.g. 'exorcist-sword')"),
          displayName: z.string().min(1).describe("Human-readable weapon name (e.g. '퇴마 장검')"),
          idle_prompt: z.string().min(1).describe("How character holds/uses weapon in idle pose"),
          attack_f00_prompt: z.string().min(1).describe("Frame 0 attack: preparation/wind-up pose"),
          attack_f01_prompt: z.string().min(1).describe("Frame 1 attack: peak strike pose"),
          attack_f02_prompt: z.string().min(1).describe("Frame 2 attack: follow-through/recoil pose"),
        })).min(1).max(10).describe("List of weapons to generate sprites for"),
        actions: z.array(z.enum(["idle", "attack"])).default(["idle", "attack"])
          .describe("Actions to generate (default: both idle and attack)"),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("Intermediate background color for Gemini edit. Recommended: 'magenta'. Better edge quality than white flood-fill."),
        edit_model: z.string().default("gemini-2.5-flash-image")
          .describe("Gemini model for image editing"),
        output_dir: z.string().optional().describe("Root output directory"),
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
        const outputDir = params.output_dir ?? DEFAULT_OUTPUT_DIR;
        const safeCharId = params.character_id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const weaponChromaKeyColor = params.chroma_key_bg
          ? CHROMA_KEY_COLORS[params.chroma_key_bg] as [number, number, number]
          : undefined;
        const weaponBgColor = weaponChromaKeyColor ?? WHITE_BG_COLOR;

        // ── 계획 테이블 출력 ────────────────────────────────────────────────
        const planRows: Array<{ character: string; weapon: string; action: string; frame: string; description: string }> = [];
        for (const weapon of params.weapons) {
          if (params.actions.includes("idle")) {
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "idle", frame: "f00", description: "정자세 (기본 대기)" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "idle", frame: "f01", description: "살짝 위로 부유" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "idle", frame: "f02", description: "살짝 아래로 내려옴" });
          }
          if (params.actions.includes("attack")) {
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "attack", frame: "f00", description: "공격 준비/백스윙" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "attack", frame: "f01", description: "공격 정점 (최대 뻗음)" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "attack", frame: "f02", description: "공격 후 잔상/복귀" });
          }
        }

        const totalSprites = planRows.length;
        console.error(`[character-weapon-sprites] 생성 계획: ${totalSprites}개 스프라이트`);

        // ── 스프라이트 생성 ─────────────────────────────────────────────────
        const results: Array<{
          character: string; weapon_id: string; weapon_name: string;
          action: string; frame: number; file_path: string; success: boolean; error?: string;
        }> = [];

        // idle 공통 프레임 프롬프트 (f00/f01/f02 구분)
        const IDLE_FRAME_SUFFIX = [
          "standing in a relaxed neutral pose, weight evenly balanced, feet shoulder-width apart",
          "body floating slightly upward, 10-15px higher than neutral, light effortless feeling",
          "body floating slightly downward back to neutral, completing the idle float cycle",
        ];

        for (const weapon of params.weapons) {
          const safeWeaponId = weapon.id.replace(/[^a-zA-Z0-9_-]/g, "_");

          for (const action of params.actions) {
            const framePrompts =
              action === "idle"
                ? [
                    `${weapon.idle_prompt} ${IDLE_FRAME_SUFFIX[0]}`,
                    `${weapon.idle_prompt} ${IDLE_FRAME_SUFFIX[1]}`,
                    `${weapon.idle_prompt} ${IDLE_FRAME_SUFFIX[2]}`,
                  ]
                : [
                    weapon.attack_f00_prompt,
                    weapon.attack_f01_prompt,
                    weapon.attack_f02_prompt,
                  ];

            for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
              const poseDesc = framePrompts[frameIdx];
              const editPrompt = buildActionEditPrompt(poseDesc);

              try {
                // 투명 PNG → 단색 배경 합성 (Gemini 격자무늬 방지)
                const compositedBuffer = await compositeOntoSolidBg(params.base_character_path, weaponBgColor);
                const compositedBase64 = compositedBuffer.toString("base64");

                const editResult = await editImageGemini({
                  imageBase64: compositedBase64,
                  imageMimeType: "image/png",
                  editPrompt,
                  model: params.edit_model,
                });

                // 배경 제거: 크로마키 모드 또는 순백 flood-fill
                let processedBuffer: Buffer;
                if (weaponChromaKeyColor) {
                  processedBuffer = await processFrameBase64Chroma(editResult.base64, weaponChromaKeyColor);
                } else {
                  processedBuffer = await processFrameBase64(editResult.base64, WHITE_BG_THRESHOLD);
                }
                processedBuffer = await (async () => {
                  const { addPaddingToBuffer } = await import("../utils/image-process.js");
                  return addPaddingToBuffer(processedBuffer, 20);
                })();

                // 저장 경로: {output_dir}/sprites/{character_id}/{weapon_id}/{action}_f{frame}.png
                const fileName = `${safeCharId}_${safeWeaponId}_${action}_f${String(frameIdx).padStart(2, "0")}.png`;
                const filePath = buildAssetPath(outputDir, `sprites/${safeCharId}/${safeWeaponId}`, fileName);
                ensureDir(path.dirname(filePath));
                fs.writeFileSync(filePath, processedBuffer);

                const asset: GeneratedAsset = {
                  id: generateAssetId(),
                  type: "image",
                  asset_type: "sprite",
                  provider: "gemini-edit",
                  prompt: editPrompt,
                  file_path: filePath,
                  file_name: fileName,
                  mime_type: "image/png",
                  created_at: new Date().toISOString(),
                  metadata: { character_id: params.character_id, weapon_id: weapon.id, action, frame_index: frameIdx },
                };
                saveAssetToRegistry(asset, outputDir);

                results.push({ character: params.character_id, weapon_id: weapon.id, weapon_name: weapon.displayName, action, frame: frameIdx, file_path: filePath, success: true });
                console.error(`[character-weapon-sprites] ✅ ${fileName}`);
              } catch (err) {
                const errMsg = err instanceof Error ? err.message : String(err);
                results.push({ character: params.character_id, weapon_id: weapon.id, weapon_name: weapon.displayName, action, frame: frameIdx, file_path: "", success: false, error: errMsg });
                console.error(`[character-weapon-sprites] ❌ ${weapon.id}/${action}/f${frameIdx}: ${errMsg}`);
              }
            }
          }
        }

        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        const output = {
          plan: planRows,
          total: totalSprites,
          succeeded,
          failed,
          sprites: results,
          output_dir: `${outputDir}/sprites/${safeCharId}/`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Weapon Sprites") }],
          isError: true,
        };
      }
    }
  );
}
