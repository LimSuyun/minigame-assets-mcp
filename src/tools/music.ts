import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, MUSIC_TYPES } from "../constants.js";
import { generateMusicLocal, generateMusicGradio } from "../services/local-music.js";
import {
  buildAssetPath,
  generateFileName,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GameConcept, GeneratedAsset } from "../types.js";

function loadMusicStyle(conceptFile: string): string {
  const resolved = path.resolve(conceptFile);
  if (!fs.existsSync(resolved)) return "";
  const concept = JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameConcept;
  return concept.music_style || "";
}

export function registerMusicTools(server: McpServer): void {
  // ── Generate Music (Local Server) ──────────────────────────────────────────
  server.registerTool(
    "asset_generate_music_local",
    {
      title: "Generate Game Music (Local Model)",
      description: `Generate game music or sound effects using a locally running music generation model.

Compatible with AudioCraft/MusicGen (with a REST or Gradio wrapper), Stable Audio, or any custom server.
Set LOCAL_MUSIC_SERVER_URL in your environment to point to your local server.

Default endpoint: POST http://localhost:7860/generate
Also supports Gradio endpoint: POST http://localhost:7860/run/predict

Args:
  - prompt (string): Music description (e.g., "epic orchestral battle theme with drums")
  - music_type (string): Type of audio (background_music, sound_effect, jingle, ambient, battle_theme, menu_theme)
  - duration_seconds (number, optional): Duration in seconds (default: 30, max: 300)
  - temperature (float, optional): Creativity/randomness 0.0-2.0 (default: 1.0)
  - model (string, optional): Model variant (e.g., "melody", "large", "stereo-melody-large")
  - use_gradio (boolean, optional): Use Gradio /run/predict endpoint instead of /generate (default: false)
  - use_concept (boolean, optional): Append game music style to prompt (default: true)
  - concept_file (string, optional): Path to game concept JSON
  - output_dir (string, optional): Output directory

Returns:
  File path of the saved audio file and asset metadata.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(2000).describe("Music/audio description"),
        music_type: z.enum(MUSIC_TYPES).default("background_music").describe("Type of audio"),
        duration_seconds: z.number().int().min(1).max(300).default(30).describe("Duration in seconds"),
        temperature: z.number().min(0).max(2).default(1.0).describe("Creativity level (0-2)"),
        model: z.string().optional().describe("Model variant (e.g., melody, large)"),
        use_gradio: z.boolean().default(false).describe("Use Gradio /run/predict endpoint"),
        use_concept: z.boolean().default(true).describe("Append game music style to prompt"),
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

        let enrichedPrompt = params.prompt;
        if (params.use_concept) {
          const musicStyle = loadMusicStyle(conceptFile);
          if (musicStyle) enrichedPrompt = `${params.prompt}. Style: ${musicStyle}`;
        }

        const musicParams = {
          prompt: enrichedPrompt,
          duration: params.duration_seconds,
          temperature: params.temperature,
          model: params.model,
        };

        const result = params.use_gradio
          ? await generateMusicGradio(musicParams)
          : await generateMusicLocal(musicParams);

        const ext = result.mimeType.includes("mp3") ? "mp3" : "wav";
        const fileName = generateFileName(`${params.music_type}_local`, ext);
        const filePath = buildAssetPath(outputDir, "music", fileName);
        ensureDir(path.dirname(filePath));
        fs.writeFileSync(filePath, result.data);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "music",
          asset_type: params.music_type,
          provider: "local",
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: result.mimeType,
          created_at: new Date().toISOString(),
          metadata: {
            duration_seconds: params.duration_seconds,
            temperature: params.temperature,
            model: params.model,
          },
        };

        saveAssetToRegistry(asset, outputDir);

        const output = {
          success: true,
          file_path: filePath,
          asset_id: asset.id,
          music_type: params.music_type,
          duration_seconds: params.duration_seconds,
          provider: "local",
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Local Music Server") }],
          isError: true,
        };
      }
    }
  );

}
