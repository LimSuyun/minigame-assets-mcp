import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, ASSET_TYPES, MUSIC_TYPES } from "../constants.js";
import { editImageGemini } from "../services/gemini.js";
import { editImageOpenAI } from "../services/openai.js";
import { generateMusicLocal, generateMusicGradio } from "../services/local-music.js";
import {
  generateFileName,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { processCharacterSprite, removeBackground, removeBackgroundAI } from "../utils/image-process.js";
import type { GeneratedAsset } from "../types.js";
import { ACTION_PROMPTS, DEFAULT_ACTIONS } from "./sprite.js";
import type { DefaultAction } from "./sprite.js";

// ─── 이미지 파일 읽기 ─────────────────────────────────────────────────────────

function readImageBase64(filePath: string): { base64: string; mimeType: string } {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) throw new Error(`File not found: ${resolved}`);
  const ext = path.extname(resolved).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    ext === ".webp" ? "image/webp" : "image/png";
  return { base64: fs.readFileSync(resolved).toString("base64"), mimeType };
}

// ─── 스프라이트 매니페스트 파일 찾기 ─────────────────────────────────────────

interface SpriteFrameEntry {
  name: string;
  file_path: string;
  action: string;
  frame_index: number;
}

interface SpriteManifest {
  character_name: string;
  base_character_path: string;
  frames: SpriteFrameEntry[];
  animations: Record<string, string[]>;
}

function findManifestForBase(baseCharacterPath: string): SpriteManifest | null {
  // base 파일 기준으로 같은 폴더의 manifest 탐색
  const dir = path.dirname(path.resolve(baseCharacterPath));
  const files = fs.readdirSync(dir);
  const manifestFile = files.find((f) => f.endsWith("_manifest.json"));
  if (!manifestFile) return null;
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, manifestFile), "utf-8")) as SpriteManifest;
  } catch {
    return null;
  }
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerEditTools(server: McpServer): void {
  // ── 1. 일반 이미지 편집 ────────────────────────────────────────────────────
  server.registerTool(
    "asset_edit_image",
    {
      title: "Edit Existing Game Asset Image",
      description: `Edit an existing game asset image (background, UI element, sprite, etc.)
using Gemini or OpenAI image editing.

Use this to:
  - Change colors or color scheme of an asset
  - Adjust style (e.g., make darker, more vibrant, add glow effects)
  - Add or remove elements (e.g., add a crown to a character icon)
  - Restyle an asset to match a different aesthetic

Args:
  - file_path (string): Path to the existing image file to edit
  - instruction (string): Natural language description of what to change
      Examples:
        "Make the background darker and more ominous with fog"
        "Change the button color from blue to red, keep the same shape"
        "Add a magical glow effect around the sword"
  - provider (string): "gemini" (default) or "openai"
  - preserve_unchanged (boolean, optional): Adds "keep everything else exactly the same"
      to the prompt (default: true)
  - save_mode (string): "new_file" (default) saves as a new file, "overwrite" replaces original
  - output_dir (string, optional): Output directory for new files (save_mode: new_file only)

Returns:
  Path to the edited image file.`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Path to the existing image to edit"),
        instruction: z.string().min(5).max(2000).describe("What to change in the image"),
        provider: z.enum(["gemini", "openai"]).default("gemini").describe("AI provider"),
        preserve_unchanged: z.boolean().default(true).describe("Keep all other details identical"),
        save_mode: z.enum(["new_file", "overwrite"]).default("new_file").describe("Save as new file or overwrite"),
        output_dir: z.string().optional().describe("Output directory (new_file mode)"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { base64: origBase64, mimeType: origMime } = readImageBase64(params.file_path);

        const editPrompt = params.preserve_unchanged
          ? `${params.instruction}. Keep everything else in the image exactly the same — same composition, same style, same proportions, same other elements.`
          : params.instruction;

        let resultBase64: string;
        let resultMime: string;

        if (params.provider === "openai") {
          const r = await editImageOpenAI({ imagePath: path.resolve(params.file_path), prompt: editPrompt });
          resultBase64 = r.base64;
          resultMime = r.mimeType;
        } else {
          const r = await editImageGemini({ imageBase64: origBase64, imageMimeType: origMime, editPrompt });
          resultBase64 = r.base64;
          resultMime = r.mimeType;
        }

        let savePath: string;
        if (params.save_mode === "overwrite") {
          savePath = path.resolve(params.file_path);
        } else {
          const ext = resultMime.includes("jpeg") ? "jpg" : "png";
          const baseName = path.basename(params.file_path, path.extname(params.file_path));
          const outDir = params.output_dir || path.dirname(params.file_path);
          ensureDir(outDir);
          savePath = path.join(path.resolve(outDir), `${baseName}_edited_${Date.now()}.${ext}`);
        }

        saveBase64File(resultBase64, savePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "other",
          provider: `${params.provider}-edit`,
          prompt: params.instruction,
          file_path: savePath,
          file_name: path.basename(savePath),
          mime_type: resultMime,
          created_at: new Date().toISOString(),
          metadata: { original_file: params.file_path, save_mode: params.save_mode },
        };
        saveAssetToRegistry(asset, params.output_dir || DEFAULT_OUTPUT_DIR);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, file_path: savePath, provider: params.provider }, null, 2) },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Image Edit") }], isError: true };
      }
    }
  );

  // ── 2. 캐릭터 디자인 수정 (+ 스프라이트 cascade 재생성) ────────────────────
  server.registerTool(
    "asset_edit_character_design",
    {
      title: "Edit Character Design (+ Optional Sprite Cascade)",
      description: `Modify a base character's design while preserving their core identity,
then optionally regenerate all existing action sprites to match the new design.

Use this when you want to:
  - Change a character's outfit or equipment
  - Adjust color scheme (e.g., hero now wears blue instead of red)
  - Add accessories (wings, hat, weapon)
  - Change hair style or facial features
  - Adjust the overall style (e.g., make more cartoonish)

The edit prompt is automatically wrapped to emphasize character identity preservation.

Args:
  - base_character_path (string): Path to the base character image
  - instruction (string): What to change about the character design
      Examples:
        "Change the hero's outfit from blue to red armor"
        "Add a wizard hat and magical staff to the character"
        "Make the character look older with grey hair"
  - regenerate_sprites (boolean, optional): After editing base, re-generate all existing
      action sprites in the sprite sheet to match the new design (default: false)
  - save_mode (string): "new_file" (default) or "overwrite" original
  - output_dir (string, optional): Output directory

Returns:
  New base character image path. If regenerate_sprites=true, also returns
  results of regenerating each action sprite.`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("Path to the base character image"),
        instruction: z.string().min(5).max(2000).describe("What to change about the character"),
        regenerate_sprites: z.boolean().default(false).describe("Re-generate all action sprites after editing base"),
        save_mode: z.enum(["new_file", "overwrite"]).default("new_file").describe("Save mode for base image"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { base64: origBase64, mimeType: origMime } = readImageBase64(params.base_character_path);

        // 캐릭터 정체성 보존 프롬프트
        const editPrompt =
          `${params.instruction}. ` +
          `This is a character design edit: preserve the character's core identity, proportions, and art style. ` +
          `Keep the same face structure, body proportions, and overall silhouette. ` +
          `Only change what is explicitly requested.`;

        const { base64: newBase64, mimeType: newMime } = await editImageGemini({
          imageBase64: origBase64,
          imageMimeType: origMime,
          editPrompt,
        });

        // 새 베이스 이미지 저장
        let newBasePath: string;
        if (params.save_mode === "overwrite") {
          newBasePath = path.resolve(params.base_character_path);
        } else {
          const ext = newMime.includes("jpeg") ? "jpg" : "png";
          const baseName = path.basename(params.base_character_path, path.extname(params.base_character_path));
          const outDir = params.output_dir || path.dirname(params.base_character_path);
          ensureDir(outDir);
          newBasePath = path.join(path.resolve(outDir), `${baseName}_v${Date.now()}.${ext}`);
        }
        saveBase64File(newBase64, newBasePath);

        const result: {
          success: boolean;
          new_base_path: string;
          save_mode: string;
          sprite_regeneration?: {
            total: number;
            succeeded: number;
            failed: number;
            results: Array<{ action: string; frame: number; success: boolean; file_path?: string; error?: string }>;
          };
        } = {
          success: true,
          new_base_path: newBasePath,
          save_mode: params.save_mode,
        };

        // 스프라이트 cascade 재생성
        if (params.regenerate_sprites) {
          const manifest = findManifestForBase(params.base_character_path);
          if (manifest && manifest.frames.length > 0) {
            const spriteResults: typeof result.sprite_regeneration extends undefined ? never : NonNullable<typeof result.sprite_regeneration>["results"] = [];

            for (const frame of manifest.frames) {
              const isPreset = DEFAULT_ACTIONS.includes(frame.action as DefaultAction);
              const actionPrompt =
                isPreset
                  ? ACTION_PROMPTS[frame.action as DefaultAction]
                  : `Show this character performing: "${frame.action}". Keep all proportions identical.`;

              try {
                const edited = await editImageGemini({
                  imageBase64: newBase64,
                  imageMimeType: newMime,
                  editPrompt: actionPrompt,
                });

                const ext = edited.mimeType.includes("jpeg") ? "jpg" : "png";
                const newFileName = `${path.basename(frame.file_path, path.extname(frame.file_path))}.${ext}`;
                const newFilePath = path.join(path.dirname(frame.file_path), newFileName);
                saveBase64File(edited.base64, newFilePath);

                spriteResults.push({ action: frame.action, frame: frame.frame_index, success: true, file_path: newFilePath });
              } catch (err) {
                spriteResults.push({ action: frame.action, frame: frame.frame_index, success: false, error: handleApiError(err, "Sprite Regeneration") });
              }
            }

            const succeeded = spriteResults.filter((r) => r.success).length;
            result.sprite_regeneration = {
              total: spriteResults.length,
              succeeded,
              failed: spriteResults.length - succeeded,
              results: spriteResults,
            };
          } else {
            result.sprite_regeneration = {
              total: 0, succeeded: 0, failed: 0, results: [],
            };
          }
        }

        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Character Design Edit") }], isError: true };
      }
    }
  );

  // ── 3. 개별 스프라이트 수정 ────────────────────────────────────────────────
  server.registerTool(
    "asset_edit_sprite",
    {
      title: "Edit Individual Action Sprite",
      description: `Edit a specific action sprite frame while maintaining consistency
with the base character design.

Use when a particular action sprite doesn't look right and needs adjustment.

Args:
  - sprite_path (string): Path to the action sprite image to edit
  - instruction (string): What to fix or change
      Examples:
        "The arm position looks unnatural, fix the elbow angle"
        "Add motion blur to the run animation frame"
        "The sword is too small, make it larger"
  - base_character_path (string, optional): Path to the original base character
      for reference (improves consistency when provided)
  - save_mode (string): "new_file" (default) or "overwrite"
  - output_dir (string, optional): Output directory

Returns:
  Path to the edited sprite file.`,
      inputSchema: z.object({
        sprite_path: z.string().min(1).describe("Path to the action sprite to edit"),
        instruction: z.string().min(5).max(2000).describe("What to fix or change in this sprite"),
        base_character_path: z.string().optional().describe("Original base character for style reference"),
        save_mode: z.enum(["new_file", "overwrite"]).default("new_file").describe("Save mode"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const { base64: spriteBase64, mimeType: spriteMime } = readImageBase64(params.sprite_path);

        const editPrompt =
          `${params.instruction}. ` +
          `Preserve the character's art style, colors, and proportions exactly. ` +
          `Only make the requested change.`;

        const { base64: resultBase64, mimeType: resultMime } = await editImageGemini({
          imageBase64: spriteBase64,
          imageMimeType: spriteMime,
          editPrompt,
        });

        let savePath: string;
        if (params.save_mode === "overwrite") {
          savePath = path.resolve(params.sprite_path);
        } else {
          const ext = resultMime.includes("jpeg") ? "jpg" : "png";
          const baseName = path.basename(params.sprite_path, path.extname(params.sprite_path));
          const outDir = params.output_dir || path.dirname(params.sprite_path);
          ensureDir(outDir);
          savePath = path.join(path.resolve(outDir), `${baseName}_fix.${ext}`);
        }

        saveBase64File(resultBase64, savePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "sprite",
          provider: "gemini-edit",
          prompt: params.instruction,
          file_path: savePath,
          file_name: path.basename(savePath),
          mime_type: resultMime,
          created_at: new Date().toISOString(),
          metadata: { original_sprite: params.sprite_path, base_character: params.base_character_path },
        };
        saveAssetToRegistry(asset, params.output_dir || DEFAULT_OUTPUT_DIR);

        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true, file_path: savePath }, null, 2) },
          ],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Sprite Edit") }], isError: true };
      }
    }
  );

  // ── 4. 음악 수정 (파라미터 변경 후 재생성) ────────────────────────────────
  server.registerTool(
    "asset_edit_music",
    {
      title: "Edit / Regenerate Music Asset",
      description: `Regenerate a music or sound effect asset with a modified prompt or parameters.

Since audio cannot be directly edited like images, this re-generates the music
with your adjusted description. Reference the original prompt from the asset registry.

Use when:
  - BGM is too fast/slow → adjust tempo in prompt
  - Wrong mood → change descriptor (e.g., "ominous" → "uplifting")
  - Wrong instruments → specify instruments explicitly
  - Too long/short → change duration_seconds

Args:
  - original_file_path (string): Path to the original music file (for naming reference)
  - new_prompt (string): Updated music description
  - music_type (string): Type of audio
  - duration_seconds (number, optional): New duration (default: 30)
  - temperature (float, optional): Creativity 0-2 (default: 1.0)
  - use_gradio (boolean, optional): Use Gradio endpoint (default: false)
  - output_dir (string, optional): Output directory

Returns:
  Path to the new audio file.`,
      inputSchema: z.object({
        original_file_path: z.string().min(1).describe("Path to original music file"),
        new_prompt: z.string().min(5).max(2000).describe("Updated music description"),
        music_type: z.enum(MUSIC_TYPES).default("background_music").describe("Type of audio"),
        duration_seconds: z.number().int().min(1).max(300).default(30).describe("Duration in seconds"),
        temperature: z.number().min(0).max(2).default(1.0).describe("Creativity (0-2)"),
        use_gradio: z.boolean().default(false).describe("Use Gradio endpoint"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

        const musicParams = {
          prompt: params.new_prompt,
          duration: params.duration_seconds,
          temperature: params.temperature,
        };
        const r = params.use_gradio
          ? await generateMusicGradio(musicParams)
          : await generateMusicLocal(musicParams);
        const audioData = r.data;
        const mimeType = r.mimeType;

        const ext = mimeType.includes("mp3") ? "mp3" : "wav";
        const baseName = path.basename(params.original_file_path, path.extname(params.original_file_path));
        const fileName = `${baseName}_v${Date.now()}.${ext}`;
        const filePath = path.join(path.resolve(outputDir, "music"), fileName);
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, audioData);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "music",
          asset_type: params.music_type,
          provider: "local",
          prompt: params.new_prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: mimeType,
          created_at: new Date().toISOString(),
          metadata: { original_file: params.original_file_path, duration_seconds: params.duration_seconds },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ success: true, file_path: filePath, duration_seconds: params.duration_seconds, provider: "local" }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Music Edit") }], isError: true };
      }
    }
  );

  // ── 5. 배경 제거 (흰색/단색 → 투명 PNG) ──────────────────────────────────
  server.registerTool(
    "asset_remove_background",
    {
      title: "Remove Background from Sprite/Image",
      description: `Remove the background from a game asset image to make it transparent (PNG with alpha channel).

Works best on images with a solid color background (white, black, green screen, etc.).
Uses color-distance thresholding — no AI required, instant processing.

Args:
  - file_path (string): Path to the image file
  - threshold (number, optional): Sensitivity 0-255 (default: 230).
      Higher = only remove very bright whites. Lower = remove more shades.
  - bg_color (string, optional): Color to remove as "R,G,B" (default: "255,255,255" = white)
  - feather (boolean, optional): Smooth semi-transparent edges (default: true)
  - save_mode (string): "new_file" saves as *_nobg.png (default), "overwrite" replaces original

Returns:
  Path to the transparent PNG file.`,
      inputSchema: z.object({
        file_path: z.string().min(1).describe("Path to the image file"),
        threshold: z.number().int().min(0).max(255).default(230).describe("Removal threshold"),
        bg_color: z.string().default("255,255,255").describe("Background color R,G,B"),
        feather: z.boolean().default(true).describe("Smooth edges"),
        save_mode: z.enum(["new_file", "overwrite"]).default("new_file").describe("Save mode"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const inputPath = path.resolve(params.file_path);
        if (!fs.existsSync(inputPath)) {
          return { content: [{ type: "text" as const, text: `Error: File not found: ${inputPath}` }], isError: true };
        }

        const parts = params.bg_color.split(",").map((s) => parseInt(s.trim(), 10));
        if (parts.length !== 3 || parts.some((n) => isNaN(n))) {
          return { content: [{ type: "text" as const, text: `Error: bg_color must be "R,G,B" format` }], isError: true };
        }
        const bgColor: [number, number, number] = [parts[0], parts[1], parts[2]];
        const isWhite = bgColor[0] === 255 && bgColor[1] === 255 && bgColor[2] === 255;

        let outputPath: string;
        if (params.save_mode === "overwrite") {
          outputPath = inputPath;
        } else {
          const baseName = path.basename(inputPath, path.extname(inputPath));
          outputPath = path.join(path.dirname(inputPath), `${baseName}_nobg.png`);
        }

        await removeBackgroundAI(inputPath, outputPath);

        const stat = fs.statSync(outputPath);
        const output = { success: true, file_path: outputPath, file_size_kb: Math.round(stat.size / 1024) };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Remove Background") }], isError: true };
      }
    }
  );

  // ── 6. 스프라이트 폴더 일괄 배경 제거 ────────────────────────────────────
  server.registerTool(
    "asset_remove_background_batch",
    {
      title: "Batch Remove Background from Sprite Folder",
      description: `Remove backgrounds from all PNG files in a sprite folder at once.

Useful after generating a full sprite sheet — processes all action frames in one call.

Args:
  - sprite_dir (string): Directory containing sprite PNG files
  - threshold (number, optional): Removal threshold (default: 230)
  - bg_color (string, optional): Background color "R,G,B" (default: "255,255,255")
  - feather (boolean, optional): Smooth edges (default: true)
  - save_mode (string): "overwrite" replaces files (default), "new_file" appends _nobg
  - skip_sheet (boolean, optional): Skip *_sheet.png files (default: true)

Returns:
  Results for each processed file.`,
      inputSchema: z.object({
        sprite_dir: z.string().min(1).describe("Directory with sprite PNG files"),
        threshold: z.number().int().min(0).max(255).default(230).describe("Removal threshold"),
        bg_color: z.string().default("255,255,255").describe("Background color R,G,B"),
        feather: z.boolean().default(true).describe("Smooth edges"),
        save_mode: z.enum(["new_file", "overwrite"]).default("overwrite").describe("Save mode"),
        skip_sheet: z.boolean().default(true).describe("Skip _sheet.png files"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const dirPath = path.resolve(params.sprite_dir);
        if (!fs.existsSync(dirPath)) {
          return { content: [{ type: "text" as const, text: `Error: Directory not found: ${dirPath}` }], isError: true };
        }

        const parts = params.bg_color.split(",").map((s) => parseInt(s.trim(), 10));
        const bgColor: [number, number, number] = [parts[0], parts[1], parts[2]];

        const pngFiles = fs.readdirSync(dirPath)
          .filter((f) => f.endsWith(".png"))
          .filter((f) => !params.skip_sheet || !f.includes("sheet"));

        const results: Array<{ file: string; success: boolean; output?: string; error?: string }> = [];

        for (const fileName of pngFiles) {
          const inputPath = path.join(dirPath, fileName);
          const outputPath = params.save_mode === "overwrite"
            ? inputPath
            : path.join(dirPath, fileName.replace(".png", "_nobg.png"));

          try {
            await removeBackgroundAI(inputPath, outputPath);
            results.push({ file: fileName, success: true, output: outputPath });
          } catch (err) {
            results.push({ file: fileName, success: false, error: String(err) });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = { total: pngFiles.length, succeeded, failed: pngFiles.length - succeeded, sprite_dir: dirPath, results };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Batch Remove Background") }], isError: true };
      }
    }
  );
}
