import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, VIDEO_TYPES } from "../constants.js";
import { generateVideoGemini } from "../services/gemini.js";
import { generateVideoOpenAI } from "../services/openai.js";
import {
  buildAssetPath,
  generateFileName,
  downloadFile,
  saveAssetToRegistry,
  generateAssetId,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GameConcept, GeneratedAsset } from "../types.js";

function loadConceptForVideo(conceptFile: string): string {
  const resolved = path.resolve(conceptFile);
  if (!fs.existsSync(resolved)) return "";
  const concept = JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameConcept;
  return `Art style: ${concept.art_style}. Theme: ${concept.theme}. Game: ${concept.game_name}.`;
}

export function registerVideoTools(server: McpServer): void {
  // ── Generate Video (Gemini Veo 2) ──────────────────────────────────────────
  server.registerTool(
    "asset_generate_video_gemini",
    {
      title: "Generate Game Video (Gemini Veo 2)",
      description: `Generate a short game video clip using Google Gemini Veo 2.

Creates cutscenes, gameplay loops, trailers, or intro/outro sequences.
Generation typically takes 1-3 minutes. The video is downloaded and saved locally.

Note: Requires GEMINI_API_KEY with Veo 2 access. Currently in limited preview.

Args:
  - prompt (string): Video description (e.g., "A hero character walking through a dark forest, pixel art style")
  - video_type (string): Type of video (cutscene, trailer, gameplay_loop, intro, outro)
  - duration_seconds (number, optional): Duration in seconds - 5, 6, 7, or 8 (default: 5)
  - aspect_ratio (string, optional): "16:9" (default, landscape) or "9:16" (portrait/mobile)
  - negative_prompt (string, optional): What to avoid in the video
  - use_concept (boolean, optional): Inject game concept into prompt (default: true)
  - concept_file (string, optional): Path to game concept JSON
  - output_dir (string, optional): Output directory

Returns:
  File path of the saved video and asset metadata. Note: video URI is returned from Gemini; the file is downloaded locally.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Video scene description"),
        video_type: z.enum(VIDEO_TYPES).default("cutscene").describe("Type of video"),
        duration_seconds: z.union([
          z.literal(5),
          z.literal(6),
          z.literal(7),
          z.literal(8),
        ]).default(5).describe("Duration in seconds (5-8)"),
        aspect_ratio: z.enum(["16:9", "9:16"]).default("16:9").describe("Aspect ratio"),
        negative_prompt: z.string().max(1000).optional().describe("What to avoid"),
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

        let enrichedPrompt = params.prompt;
        if (params.use_concept) {
          const conceptHint = loadConceptForVideo(conceptFile);
          if (conceptHint) enrichedPrompt = `${params.prompt}. ${conceptHint}`;
        }

        const result = await generateVideoGemini({
          prompt: enrichedPrompt,
          durationSeconds: params.duration_seconds,
          aspectRatio: params.aspect_ratio,
          negativePrompt: params.negative_prompt,
        });

        const providerTag = `gemini-${result.model}`;
        const fileName = generateFileName(`${params.video_type}_gemini`, "mp4");
        const filePath = buildAssetPath(outputDir, "videos", fileName);

        await downloadFile(result.videoUri, filePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "video",
          asset_type: params.video_type,
          provider: providerTag,
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "video/mp4",
          created_at: new Date().toISOString(),
          metadata: {
            duration_seconds: params.duration_seconds,
            aspect_ratio: params.aspect_ratio,
            video_uri: result.videoUri,
            model: result.model,
          },
        };

        saveAssetToRegistry(asset, outputDir);

        const output = {
          success: true,
          file_path: filePath,
          asset_id: asset.id,
          video_type: params.video_type,
          duration_seconds: params.duration_seconds,
          provider: providerTag,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Gemini Veo") }],
          isError: true,
        };
      }
    }
  );

  // ── Generate Video (OpenAI Sora) ───────────────────────────────────────────
  server.registerTool(
    "asset_generate_video_openai",
    {
      title: "Generate Game Video (OpenAI Sora)",
      description: `Generate a short game video clip using OpenAI Sora.

Creates game cutscenes, trailers, or short loops.

Note: Requires OPENAI_API_KEY with Sora access (currently limited availability).
Generation may take several minutes.

Args:
  - prompt (string): Video scene description
  - video_type (string): Type of video (cutscene, trailer, gameplay_loop, intro, outro)
  - duration_seconds (number, optional): Duration - 5, 10, 15, or 20 seconds (default: 5)
  - resolution (string, optional): "480p", "720p" (default), or "1080p"
  - aspect_ratio (string, optional): "16:9" (default), "9:16", or "1:1"
  - use_concept (boolean, optional): Inject game concept into prompt (default: true)
  - concept_file (string, optional): Path to game concept JSON
  - output_dir (string, optional): Output directory

Returns:
  File path of the saved video and asset metadata.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Video scene description"),
        video_type: z.enum(VIDEO_TYPES).default("cutscene").describe("Type of video"),
        duration_seconds: z.union([
          z.literal(5),
          z.literal(10),
          z.literal(15),
          z.literal(20),
        ]).default(5).describe("Duration in seconds"),
        resolution: z.enum(["480p", "720p", "1080p"]).default("720p").describe("Video resolution"),
        aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9").describe("Aspect ratio"),
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

        let enrichedPrompt = params.prompt;
        if (params.use_concept) {
          const conceptHint = loadConceptForVideo(conceptFile);
          if (conceptHint) enrichedPrompt = `${params.prompt}. ${conceptHint}`;
        }

        const result = await generateVideoOpenAI({
          prompt: enrichedPrompt,
          duration: params.duration_seconds as 5 | 10 | 15 | 20,
          resolution: params.resolution,
          aspect_ratio: params.aspect_ratio,
        });

        const fileName = generateFileName(`${params.video_type}_openai`, "mp4");
        const filePath = buildAssetPath(outputDir, "videos", fileName);

        await downloadFile(result.videoUrl, filePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "video",
          asset_type: params.video_type,
          provider: "openai-sora",
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "video/mp4",
          created_at: new Date().toISOString(),
          metadata: {
            duration_seconds: params.duration_seconds,
            resolution: params.resolution,
            aspect_ratio: params.aspect_ratio,
          },
        };

        saveAssetToRegistry(asset, outputDir);

        const output = {
          success: true,
          file_path: filePath,
          asset_id: asset.id,
          video_type: params.video_type,
          duration_seconds: params.duration_seconds,
          provider: "openai-sora",
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "OpenAI Sora") }],
          isError: true,
        };
      }
    }
  );
}
