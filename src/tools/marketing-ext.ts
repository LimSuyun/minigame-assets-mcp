import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { buildAssetPath, saveAssetToRegistry, generateAssetId, ensureDir } from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { startLatencyTracker, buildCostTelemetry } from "../utils/cost-tracking.js";
import { writeOptimized } from "../utils/image-output.js";
import type { GeneratedAsset } from "../types.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeCaptionSvg(
  caption: string,
  width: number,
  position: "top" | "bottom",
  fontSize = 52
): Buffer {
  const yPos = position === "top" ? fontSize + 40 : 9999; // 9999 will be overridden below
  const actualY = position === "top" ? fontSize + 40 : -40; // relative within the SVG element placed at bottom

  const padding = 30;
  const boxHeight = fontSize + padding * 2;
  const boxY = position === "top" ? 0 : -boxHeight;

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${boxHeight}">
    <rect x="0" y="0" width="${width}" height="${boxHeight}" fill="rgba(0,0,0,0.55)" rx="0"/>
    <text
      x="${width / 2}"
      y="${fontSize + padding - 8}"
      font-family="Arial, sans-serif"
      font-size="${fontSize}"
      font-weight="bold"
      fill="white"
      text-anchor="middle"
      dominant-baseline="auto"
    >${escapeXml(caption)}</text>
  </svg>`;

  void yPos; void actualY; void boxY; // suppress unused-variable lint
  return Buffer.from(svg);
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function base64ToSharp(base64: string, mimeType: string): Promise<sharp.Sharp> {
  const buffer = Buffer.from(base64, "base64");
  void mimeType;
  return sharp(buffer);
}

export function registerMarketingExtTools(server: McpServer): void {
  // ── asset_generate_store_screenshots ──────────────────────────────────────
  server.registerTool(
    "asset_generate_store_screenshots",
    {
      title: "Generate App Store Screenshots",
      description: `Generate app store screenshot sets for iOS and/or Android platforms.

For each screenshot scene:
  1. If background_image_path is provided → resize + blur overlay via Sharp
  2. Otherwise → generate background with gpt-image-1
  3. Composite caption text SVG overlay on top or bottom
  4. Resize to platform-specific dimensions and save

Output sizes:
  - iOS:     1290×2796 px  → {scene}_ios.png
  - Android: 1080×1920 px  → {scene}_android.png

Args:
  - platform: Target platform(s) ("ios", "android", "both")
  - game_name: Name of the game (used in prompts)
  - screenshots: List of screenshot scenes with caption text
  - style_description: Optional visual style for AI-generated backgrounds
  - output_dir: Output directory`,
      inputSchema: z.object({
        platform: z.enum(["ios", "android", "both"]).default("both")
          .describe("Target platform(s)"),
        game_name: z.string().min(1).describe("Game name"),
        screenshots: z.array(z.object({
          scene: z.string().describe("Scene identifier (used as filename base)"),
          caption: z.string().describe("Caption text to overlay"),
          caption_position: z.enum(["top", "bottom"]).default("top")
            .describe("Position of the caption overlay"),
          background_image_path: z.string().optional()
            .describe("Path to existing background image (optional)"),
        })).min(1).describe("List of screenshot scenes"),
        style_description: z.string().optional()
          .describe("Visual style description for AI-generated backgrounds"),
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
        const screenshotsDir = path.resolve(outputDir, "marketing", "screenshots");
        ensureDir(screenshotsDir);

        const platforms: Array<{ key: string; width: number; height: number }> = [];
        if (params.platform === "ios" || params.platform === "both") {
          platforms.push({ key: "ios", width: 1290, height: 2796 });
        }
        if (params.platform === "android" || params.platform === "both") {
          platforms.push({ key: "android", width: 1080, height: 1920 });
        }

        const generatedFiles: Array<{ scene: string; platform: string; file_path: string }> = [];

        for (const screenshot of params.screenshots) {
          let baseImageBuffer: Buffer;

          let screenshotCost: { latency_ms: number; est_cost_usd: number; cost_formula?: string; model?: string } | null = null;
          if (screenshot.background_image_path && fs.existsSync(screenshot.background_image_path)) {
            // Use existing image: resize to largest needed dimension then blur overlay
            const maxWidth = Math.max(...platforms.map((p) => p.width));
            const maxHeight = Math.max(...platforms.map((p) => p.height));
            baseImageBuffer = await sharp(screenshot.background_image_path)
              .resize(maxWidth, maxHeight, { fit: "cover" })
              .toBuffer();
          } else {
            // Generate with gpt-image-1
            const prompt = `${params.style_description || "vibrant colorful game"} screenshot scene: ${screenshot.scene}, ${params.game_name} mobile game, high quality game artwork`;
            const shotLatency = startLatencyTracker();
            const result = await generateImageOpenAI({
              prompt,
              size: "1024x1536",
              quality: "high",
              background: "opaque",
            });
            screenshotCost = buildCostTelemetry("gpt-image-1-mini", "high", "1024x1536", shotLatency.elapsed());
            baseImageBuffer = Buffer.from(result.base64, "base64");
          }

          for (const plat of platforms) {
            // Resize to platform dimensions
            const resized = await sharp(baseImageBuffer)
              .resize(plat.width, plat.height, { fit: "cover" })
              .toBuffer();

            // Build caption SVG
            const captionSvg = makeCaptionSvg(
              screenshot.caption,
              plat.width,
              screenshot.caption_position ?? "top",
              Math.round(plat.width * 0.04) // ~4% of width
            );
            const captionHeight = Math.round(plat.width * 0.04) + 70;
            const captionTop =
              (screenshot.caption_position ?? "top") === "top"
                ? 0
                : plat.height - captionHeight;

            // Composite caption overlay
            const final = await sharp(resized)
              .composite([
                {
                  input: captionSvg,
                  top: captionTop,
                  left: 0,
                },
              ])
              .png()
              .toBuffer();

            const pathBase = path.join(screenshotsDir, `${screenshot.scene}_${plat.key}.png`);
            const written = await writeOptimized(final, pathBase);
            const filePath = written.path;
            const fileName = path.basename(filePath);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "store_screenshot",
              provider: screenshot.background_image_path ? "sharp" : "openai",
              prompt: screenshot.caption,
              file_path: filePath,
              file_name: fileName,
              mime_type: written.format === "webp" ? "image/webp" : "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                platform: plat.key,
                scene: screenshot.scene,
                width: plat.width,
                height: plat.height,
                game_name: params.game_name,
                ...(screenshotCost ?? {}),
              },
            };
            saveAssetToRegistry(asset, outputDir);
            generatedFiles.push({ scene: screenshot.scene, platform: plat.key, file_path: filePath });
          }
        }

        const output = {
          success: true,
          game_name: params.game_name,
          platform: params.platform,
          total_files: generatedFiles.length,
          files: generatedFiles,
          output_dir: screenshotsDir,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Store Screenshots") }],
          isError: true,
        };
      }
    }
  );

  // ── asset_generate_store_banner ───────────────────────────────────────────
  server.registerTool(
    "asset_generate_store_banner",
    {
      title: "Generate App Store Featured Banner",
      description: `Generate a featured banner image for app store listings.

Output sizes:
  - Google Play Featured: 1024×500 px → google_play_banner.png
  - App Store Feature:    1024×500 px → app_store_banner.png (future expansion)

Processing:
  1. If key_visual_path is provided → composite it over a generated/plain background
  2. Otherwise → generate 1536×1024 image with gpt-image-1, then resize to 1024×500

Args:
  - platform: Target store platform
  - game_name: Name of the game
  - key_visual_path: Optional path to a key character/scene image to composite
  - style_description: Optional visual style for AI generation
  - output_dir: Output directory`,
      inputSchema: z.object({
        platform: z.enum(["google_play", "app_store"]).default("google_play")
          .describe("Target store platform"),
        game_name: z.string().min(1).describe("Game name"),
        key_visual_path: z.string().optional()
          .describe("Path to key character/scene image for compositing"),
        style_description: z.string().optional()
          .describe("Visual style description for AI generation"),
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
        const marketingDir = path.resolve(outputDir, "marketing", "banners");
        ensureDir(marketingDir);

        const BANNER_WIDTH = 1024;
        const BANNER_HEIGHT = 500;

        let bannerBuffer: Buffer;
        const bannerLatency = startLatencyTracker();

        if (params.key_visual_path && fs.existsSync(params.key_visual_path)) {
          // Generate a background image, then composite the key visual
          const bgPrompt = `${params.style_description || "vibrant game art"} featured banner background for ${params.game_name}, wide cinematic landscape, no text`;
          const bgResult = await generateImageOpenAI({
            prompt: bgPrompt,
            size: "1536x1024",
            quality: "high",
            background: "opaque",
          });
          const bgBuffer = Buffer.from(bgResult.base64, "base64");
          const bgResized = await sharp(bgBuffer)
            .resize(BANNER_WIDTH, BANNER_HEIGHT, { fit: "cover" })
            .toBuffer();

          // Resize key visual to fit banner height (leave some margin)
          const kvResized = await sharp(params.key_visual_path)
            .resize(null, Math.round(BANNER_HEIGHT * 0.85), { fit: "inside" })
            .toBuffer();
          const kvMeta = await sharp(kvResized).metadata();
          const kvLeft = Math.max(0, BANNER_WIDTH - (kvMeta.width ?? BANNER_HEIGHT) - 40);
          const kvTop = Math.round((BANNER_HEIGHT - (kvMeta.height ?? BANNER_HEIGHT)) / 2);

          bannerBuffer = await sharp(bgResized)
            .composite([{ input: kvResized, left: kvLeft, top: kvTop }])
            .png()
            .toBuffer();
        } else {
          // AI-generate the full banner image
          const prompt = `${params.style_description || "exciting vibrant game art"} featured banner for ${params.game_name} mobile game, wide horizontal composition, cinematic, high quality, no text`;
          const result = await generateImageOpenAI({
            prompt,
            size: "1536x1024",
            quality: "high",
            background: "opaque",
          });
          const rawBuffer = Buffer.from(result.base64, "base64");
          bannerBuffer = await sharp(rawBuffer)
            .resize(BANNER_WIDTH, BANNER_HEIGHT, { fit: "cover" })
            .png()
            .toBuffer();
        }
        const bannerLatencyMs = bannerLatency.elapsed();

        const fileNames: Record<string, string> = {
          google_play: "google_play_banner.png",
          app_store: "app_store_banner.png",
        };
        const pathBase = path.join(marketingDir, fileNames[params.platform]);
        const written = await writeOptimized(bannerBuffer, pathBase);
        const filePath = written.path;
        const fileName = path.basename(filePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "store_banner",
          provider: "openai",
          prompt: params.style_description || params.game_name,
          file_path: filePath,
          file_name: fileName,
          mime_type: written.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            platform: params.platform,
            width: BANNER_WIDTH,
            height: BANNER_HEIGHT,
            game_name: params.game_name,
            ...buildCostTelemetry("gpt-image-1-mini", "high", "1536x1024", bannerLatencyMs),
          },
        };
        saveAssetToRegistry(asset, outputDir);

        const output = {
          success: true,
          game_name: params.game_name,
          platform: params.platform,
          file_path: filePath,
          width: BANNER_WIDTH,
          height: BANNER_HEIGHT,
          asset_id: asset.id,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Store Banner") }],
          isError: true,
        };
      }
    }
  );

  // ── asset_generate_social_media_pack ──────────────────────────────────────
  server.registerTool(
    "asset_generate_social_media_pack",
    {
      title: "Generate Social Media Image Pack",
      description: `Generate a set of promotional images sized for major social media platforms.

Output files:
  - instagram_post.png    (1080×1080 px)
  - instagram_story.png   (1080×1920 px)
  - twitter_banner.png    (1200×675 px)
  - facebook_post.png     (1200×630 px)

Processing:
  1. Generate a 1024×1024 base image with gpt-image-1
  2. Resize to each platform's required dimensions
  3. If key_visual_path is provided, composite it into each image

Args:
  - game_name: Name of the game
  - event_type: Type of promotional event
  - key_visual_path: Optional path to a key image for compositing
  - caption: Optional caption/tagline text
  - style_description: Optional visual style for AI generation
  - output_dir: Output directory`,
      inputSchema: z.object({
        game_name: z.string().min(1).describe("Game name"),
        event_type: z.enum(["launch", "update", "event", "ranking"])
          .describe("Type of promotional event"),
        key_visual_path: z.string().optional()
          .describe("Path to a key image for compositing"),
        caption: z.string().optional().describe("Caption or tagline text"),
        style_description: z.string().optional()
          .describe("Visual style description for AI generation"),
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
        const socialDir = path.resolve(outputDir, "marketing", "social");
        ensureDir(socialDir);

        const eventDescriptions: Record<string, string> = {
          launch: "game launch announcement, exciting new release",
          update: "game update announcement, new content reveal",
          event: "in-game special event promotion",
          ranking: "leaderboard and ranking showcase",
        };

        const prompt = `${params.style_description || "vibrant colorful game art"} ${eventDescriptions[params.event_type]} for ${params.game_name} mobile game, eye-catching promotional artwork${params.caption ? `, tagline: ${params.caption}` : ""}, high quality`;

        const socialLatency = startLatencyTracker();
        const result = await generateImageOpenAI({
          prompt,
          size: "1024x1024",
          quality: "high",
          background: "opaque",
        });
        const socialCost = buildCostTelemetry("gpt-image-1-mini", "high", "1024x1024", socialLatency.elapsed());

        const baseBuffer = Buffer.from(result.base64, "base64");

        const platformSpecs = [
          { id: "instagram_post",  fileName: "instagram_post.png",  width: 1080, height: 1080 },
          { id: "instagram_story", fileName: "instagram_story.png", width: 1080, height: 1920 },
          { id: "twitter_banner",  fileName: "twitter_banner.png",  width: 1200, height: 675  },
          { id: "facebook_post",   fileName: "facebook_post.png",   width: 1200, height: 630  },
        ];

        const generatedFiles: Array<{ platform: string; file_path: string; width: number; height: number }> = [];

        for (const spec of platformSpecs) {
          let platformBuffer = await sharp(baseBuffer)
            .resize(spec.width, spec.height, { fit: "cover" })
            .toBuffer();

          if (params.key_visual_path && fs.existsSync(params.key_visual_path)) {
            const kvMaxH = Math.round(spec.height * 0.75);
            const kvResized = await sharp(params.key_visual_path)
              .resize(null, kvMaxH, { fit: "inside" })
              .toBuffer();
            const kvMeta = await sharp(kvResized).metadata();
            const kvLeft = Math.round((spec.width - (kvMeta.width ?? 0)) / 2);
            const kvTop = Math.round((spec.height - (kvMeta.height ?? 0)) / 2);

            platformBuffer = await sharp(platformBuffer)
              .composite([{ input: kvResized, left: Math.max(0, kvLeft), top: Math.max(0, kvTop) }])
              .toBuffer();
          }

          const finalBuffer = await sharp(platformBuffer).png().toBuffer();
          const pathBase = path.join(socialDir, spec.fileName);
          const written = await writeOptimized(finalBuffer, pathBase);
          const filePath = written.path;
          const fileName = path.basename(filePath);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "social_media",
            provider: "openai",
            prompt,
            file_path: filePath,
            file_name: fileName,
            mime_type: written.format === "webp" ? "image/webp" : "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              platform_id: spec.id,
              event_type: params.event_type,
              width: spec.width,
              height: spec.height,
              game_name: params.game_name,
              ...socialCost,
            },
          };
          saveAssetToRegistry(asset, outputDir);
          generatedFiles.push({ platform: spec.id, file_path: filePath, width: spec.width, height: spec.height });
        }

        const output = {
          success: true,
          game_name: params.game_name,
          event_type: params.event_type,
          total_files: generatedFiles.length,
          files: generatedFiles,
          output_dir: socialDir,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Social Media Pack") }],
          isError: true,
        };
      }
    }
  );
}
