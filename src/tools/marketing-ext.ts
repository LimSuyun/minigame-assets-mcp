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
      title: "Compose App Store Screenshots from Real Captures",
      description: `⚠️  실제 게임 플레이 캡쳐 PNG가 있어야 사용할 수 있습니다.
   각 scene마다 capture_image_path 가 필수입니다 — AI 자동 생성 fallback은 없습니다.
   캡쳐 파일이 없으면 시뮬레이터/실기기에서 직접 캡쳐해 입력해 주세요.

처리 흐름 (AI 호출 0회):
  1. 사용자가 제공한 capture PNG 로드
  2. 플랫폼 비율(iOS 1290×2796 / Android 1080×1920) cover fit 리사이즈
  3. 캡션 SVG 오버레이 합성 (스토어 가이드라인상 텍스트 권장)
  4. 엔진별 포맷으로 저장 + registry 등록

Output sizes:
  - iOS:     1290×2796 px  → {scene}_ios.png
  - Android: 1080×1920 px  → {scene}_android.png

Args:
  - platform: 출력할 플랫폼(s) — "ios" | "android" | "both"
  - game_name: 게임명 (메타데이터)
  - screenshots: scene/caption/caption_position/capture_image_path 배열
  - output_dir: 출력 디렉토리`,
      inputSchema: z.object({
        platform: z.enum(["ios", "android", "both"]).default("both")
          .describe("Target platform(s)"),
        game_name: z.string().min(1).describe("Game name"),
        screenshots: z.array(z.object({
          scene: z.string().describe("Scene identifier (used as filename base)"),
          caption: z.string().describe("Caption text to overlay"),
          caption_position: z.enum(["top", "bottom"]).default("top")
            .describe("Position of the caption overlay"),
          capture_image_path: z.string()
            .describe("실제 게임 플레이 캡쳐 PNG 경로 (필수)"),
        })).min(1).describe("List of screenshot scenes — capture_image_path required for each"),
        output_dir: z.string().optional().describe("출력 디렉토리. 기본은 본 도구의 표준 sub-dir(`.minigame-assets/marketing/<asset_type>/`)을 자동 결정합니다. registry/deploy-map은 어떤 sub-dir을 지정하더라도 항상 프로젝트 루트(`.minigame-assets/`) 한 곳에 통합 저장됩니다."),
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

        // 사전 검증: 모든 캡쳐 파일이 존재해야 함
        const missing = params.screenshots
          .filter(s => !fs.existsSync(s.capture_image_path))
          .map(s => `  - scene "${s.scene}": ${s.capture_image_path}`);
        if (missing.length > 0) {
          throw new Error(
            `다음 capture_image_path 파일을 찾을 수 없습니다:\n${missing.join("\n")}\n\n` +
            `시뮬레이터·실기기에서 게임을 실행하고 직접 캡쳐한 PNG를 넘겨주세요.`
          );
        }

        const generatedFiles: Array<{ scene: string; platform: string; file_path: string }> = [];

        for (const screenshot of params.screenshots) {
          for (const plat of platforms) {
            // 1. 캡쳐를 플랫폼 비율로 cover fit
            const resized = await sharp(screenshot.capture_image_path)
              .resize(plat.width, plat.height, { fit: "cover" })
              .toBuffer();

            // 2. 캡션 SVG 합성
            const captionSvg = makeCaptionSvg(
              screenshot.caption,
              plat.width,
              screenshot.caption_position ?? "top",
              Math.round(plat.width * 0.04),
            );
            const captionHeight = Math.round(plat.width * 0.04) + 70;
            const captionTop =
              (screenshot.caption_position ?? "top") === "top"
                ? 0
                : plat.height - captionHeight;

            const final = await sharp(resized)
              .composite([{ input: captionSvg, top: captionTop, left: 0 }])
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
              provider: "sharp",
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
                source_capture: screenshot.capture_image_path,
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
          ai_calls: 0,
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
        output_dir: z.string().optional().describe("출력 디렉토리. 기본은 본 도구의 표준 sub-dir(`.minigame-assets/marketing/<asset_type>/`)을 자동 결정합니다. registry/deploy-map은 어떤 sub-dir을 지정하더라도 항상 프로젝트 루트(`.minigame-assets/`) 한 곳에 통합 저장됩니다."),
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
      title: "Generate Social Media Image Pack (v2 — atmosphere plate + composite)",
      description: `⚠️  사용자가 명시적으로 SNS 홍보 이미지를 요청할 때만 호출하세요.
   기본 마케팅 워크플로(스토어 배너·썸네일·로고)에는 포함되지 않습니다.

마케팅 캠페인용 SNS 4비율 이미지를 한 번에 생성합니다.

Output files (모두 marketing/social/ 하위):
  - instagram_post.png    1080×1080
  - instagram_story.png   1080×1920
  - twitter_banner.png    1200×675
  - facebook_post.png     1200×630

Pipeline (AI 호출 1회):
  1. gpt-image-2로 1024×1024 "atmosphere plate" 생성 (캐릭터 자리 비움)
  2. 각 플랫폼 비율로 sharp mirror+blur extend (정보 손실 없는 비율 확장)
  3. key_visual 합성 — drop shadow + 플랫폼별 anchor (post=중앙, story=상단,
                                                       banner류=좌측 1/3)
  4. logo_path 합성 — 코너 safe-zone (옵션)
  5. vignette — 가장자리 어둡게, 캐릭터 도드라짐

Args:
  - game_name: 게임명 (plate 프롬프트에 삽입)
  - event_type: 캠페인 타입 (launch / update / event / ranking)
  - key_visual_path: 캐릭터·키비주얼 PNG 경로 (옵션, 권장)
  - logo_path: 코너 합성용 로고 PNG 경로 (옵션)
  - style_description: AI plate 스타일 키워드 (옵션)
  - vignette: 가장자리 비네팅 적용 여부 (기본 true)
  - output_dir: 출력 디렉토리 (기본 .minigame-assets/marketing/social/)`,
      inputSchema: z.object({
        game_name: z.string().min(1).describe("Game name"),
        event_type: z.enum(["launch", "update", "event", "ranking"])
          .describe("Type of promotional event"),
        key_visual_path: z.string().optional()
          .describe("캐릭터/키비주얼 PNG 경로 (있으면 drop shadow + 플랫폼별 anchor 합성)"),
        logo_path: z.string().optional()
          .describe("로고 PNG 경로 (있으면 코너 safe-zone 합성)"),
        style_description: z.string().optional()
          .describe("plate 비주얼 스타일 키워드"),
        vignette: z.boolean().default(true)
          .describe("가장자리 비네팅 적용 여부 (기본 true — 캐릭터를 도드라지게)"),
        output_dir: z.string().optional().describe("출력 디렉토리. 기본은 본 도구의 표준 sub-dir(`.minigame-assets/marketing/<asset_type>/`)을 자동 결정합니다. registry/deploy-map은 어떤 sub-dir을 지정하더라도 항상 프로젝트 루트(`.minigame-assets/`) 한 곳에 통합 저장됩니다."),
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

        // ── Step 1: AI plate 1회 생성 ───────────────────────────────────────
        const eventDescriptions: Record<string, string> = {
          launch: "game launch announcement atmosphere",
          update: "game update reveal atmosphere",
          event: "in-game special event atmosphere",
          ranking: "leaderboard / ranking showcase atmosphere",
        };
        const platePrompt =
          `${params.style_description || "vibrant cinematic game art"} ` +
          `marketing atmosphere plate for ${params.game_name} mobile game, ` +
          `${eventDescriptions[params.event_type]}, ` +
          `painterly background with depth and lighting, ` +
          `composition with breathing room in the center for a character to be composited later, ` +
          `NO characters, NO mascots, NO logos, NO text, NO UI elements, ` +
          `high quality, opaque background`;

        const plateLatency = startLatencyTracker();
        const plateResult = await generateImageOpenAI({
          prompt: platePrompt,
          model: "gpt-image-2",
          size: "1024x1024",
          quality: "high",
          background: "opaque",
        });
        const plateCost = buildCostTelemetry("gpt-image-2", "high", "1024x1024", plateLatency.elapsed());
        const plateBuffer = Buffer.from(plateResult.base64, "base64");

        // ── 플랫폼 스펙 + anchor 정의 ───────────────────────────────────────
        type PlatformSpec = {
          id: string;
          fileName: string;
          width: number;
          height: number;
          /** key_visual 가로 anchor: 'center' | 'left-third' */
          kvAnchorX: "center" | "left-third";
          /** key_visual 세로 비율 (캔버스 높이 대비) */
          kvHeightRatio: number;
          /** logo 코너 위치 */
          logoCorner: "tl" | "tr" | "bl" | "br";
        };
        const platformSpecs: PlatformSpec[] = [
          { id: "instagram_post",  fileName: "instagram_post.png",  width: 1080, height: 1080, kvAnchorX: "center",     kvHeightRatio: 0.75, logoCorner: "br" },
          { id: "instagram_story", fileName: "instagram_story.png", width: 1080, height: 1920, kvAnchorX: "center",     kvHeightRatio: 0.62, logoCorner: "br" },
          { id: "twitter_banner",  fileName: "twitter_banner.png",  width: 1200, height: 675,  kvAnchorX: "left-third", kvHeightRatio: 0.85, logoCorner: "tl" },
          { id: "facebook_post",   fileName: "facebook_post.png",   width: 1200, height: 630,  kvAnchorX: "left-third", kvHeightRatio: 0.85, logoCorner: "tl" },
        ];

        // key_visual 사전 로드 (재사용)
        let kvBaseBuffer: Buffer | null = null;
        if (params.key_visual_path && fs.existsSync(params.key_visual_path)) {
          kvBaseBuffer = fs.readFileSync(params.key_visual_path);
        }
        // logo 사전 로드
        let logoBaseBuffer: Buffer | null = null;
        if (params.logo_path && fs.existsSync(params.logo_path)) {
          logoBaseBuffer = fs.readFileSync(params.logo_path);
        }

        const generatedFiles: Array<{ platform: string; file_path: string; width: number; height: number }> = [];

        for (const spec of platformSpecs) {
          // ── Step 2: 정사각 plate를 플랫폼 비율로 mirror+blur extend ─────
          let canvasBuffer = await extendPlateToAspect(plateBuffer, spec.width, spec.height);

          // ── Step 3: key_visual 합성 (drop shadow + anchor) ───────────────
          if (kvBaseBuffer) {
            canvasBuffer = await compositeKeyVisualWithShadow(
              canvasBuffer,
              kvBaseBuffer,
              spec.width,
              spec.height,
              spec.kvAnchorX,
              spec.kvHeightRatio,
            );
          }

          // ── Step 4: logo 합성 (코너 safe-zone) ────────────────────────────
          if (logoBaseBuffer) {
            canvasBuffer = await compositeLogoCorner(
              canvasBuffer,
              logoBaseBuffer,
              spec.width,
              spec.height,
              spec.logoCorner,
            );
          }

          // ── Step 5: vignette ─────────────────────────────────────────────
          if (params.vignette !== false) {
            canvasBuffer = await applyVignette(canvasBuffer, spec.width, spec.height);
          }

          const finalBuffer = await sharp(canvasBuffer).png().toBuffer();
          const pathBase = path.join(socialDir, spec.fileName);
          const written = await writeOptimized(finalBuffer, pathBase);
          const filePath = written.path;
          const fileName = path.basename(filePath);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "social_media",
            provider: "openai",
            prompt: platePrompt,
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
              has_key_visual: !!kvBaseBuffer,
              has_logo: !!logoBaseBuffer,
              vignette: params.vignette !== false,
              ...plateCost,
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
          ai_calls: 1,
          plate_cost_usd: plateCost.est_cost_usd,
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

// ─── social_media_pack v2 helpers ────────────────────────────────────────────
// 외부 (smoke test 등)에서 단위로 검증할 수 있도록 모두 export.

/**
 * 정사각 plate를 타깃 비율로 확장.
 * - 가로가 더 넓으면 plate를 세로 fit 후 좌·우를 plate 가장자리 mirror+blur로 채움
 * - 세로가 더 길면 plate를 가로 fit 후 상·하를 mirror+blur로 채움
 * - 정사각이면 단순 리사이즈
 */
export async function extendPlateToAspect(
  plate: Buffer,
  targetW: number,
  targetH: number,
): Promise<Buffer> {
  const targetAspect = targetW / targetH;
  if (Math.abs(targetAspect - 1) < 0.01) {
    return await sharp(plate).resize(targetW, targetH, { fit: "cover" }).toBuffer();
  }

  if (targetAspect > 1) {
    // 가로가 더 넓음: plate를 세로 height에 맞추고, 좌·우 확장
    const coreHeight = targetH;
    const coreWidth = coreHeight; // 정사각 plate라서 width === height
    const corePlate = await sharp(plate).resize(coreWidth, coreHeight, { fit: "cover" }).toBuffer();

    const sideWidth = Math.ceil((targetW - coreWidth) / 2);
    if (sideWidth <= 0) {
      return await sharp(corePlate).resize(targetW, targetH, { fit: "cover" }).toBuffer();
    }

    // 좌측 strip: plate 왼쪽 일부를 mirror + blur
    const leftStripSrc = await sharp(corePlate)
      .extract({ left: 0, top: 0, width: Math.min(sideWidth, coreWidth), height: coreHeight })
      .flop() // 좌우 미러
      .resize(sideWidth, coreHeight, { fit: "cover" })
      .blur(40)
      .toBuffer();

    const rightStripSrc = await sharp(corePlate)
      .extract({ left: coreWidth - Math.min(sideWidth, coreWidth), top: 0, width: Math.min(sideWidth, coreWidth), height: coreHeight })
      .flop()
      .resize(sideWidth, coreHeight, { fit: "cover" })
      .blur(40)
      .toBuffer();

    const canvas = await sharp({
      create: { width: targetW, height: targetH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([
        { input: leftStripSrc, left: 0, top: 0 },
        { input: corePlate, left: sideWidth, top: 0 },
        { input: rightStripSrc, left: sideWidth + coreWidth, top: 0 },
      ])
      .png()
      .toBuffer();

    return await sharp(canvas).resize(targetW, targetH, { fit: "cover" }).toBuffer();
  }

  // 세로가 더 길음: plate를 가로 width에 맞추고, 상·하 확장
  const coreWidth = targetW;
  const coreHeight = coreWidth;
  const corePlate = await sharp(plate).resize(coreWidth, coreHeight, { fit: "cover" }).toBuffer();

  const stripHeight = Math.ceil((targetH - coreHeight) / 2);
  if (stripHeight <= 0) {
    return await sharp(corePlate).resize(targetW, targetH, { fit: "cover" }).toBuffer();
  }

  const topStripSrc = await sharp(corePlate)
    .extract({ left: 0, top: 0, width: coreWidth, height: Math.min(stripHeight, coreHeight) })
    .flip() // 상하 미러
    .resize(coreWidth, stripHeight, { fit: "cover" })
    .blur(40)
    .toBuffer();

  const bottomStripSrc = await sharp(corePlate)
    .extract({ left: 0, top: coreHeight - Math.min(stripHeight, coreHeight), width: coreWidth, height: Math.min(stripHeight, coreHeight) })
    .flip()
    .resize(coreWidth, stripHeight, { fit: "cover" })
    .blur(40)
    .toBuffer();

  const canvas = await sharp({
    create: { width: targetW, height: targetH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  })
    .composite([
      { input: topStripSrc, left: 0, top: 0 },
      { input: corePlate, left: 0, top: stripHeight },
      { input: bottomStripSrc, left: 0, top: stripHeight + coreHeight },
    ])
    .png()
    .toBuffer();

  return await sharp(canvas).resize(targetW, targetH, { fit: "cover" }).toBuffer();
}

/**
 * key_visual을 drop shadow와 함께 캔버스에 합성.
 * anchor에 따라 가로 위치 결정, 세로는 항상 캔버스 하단에 base가 닿도록 (서있는 캐릭터 가정).
 */
export async function compositeKeyVisualWithShadow(
  canvas: Buffer,
  kv: Buffer,
  canvasW: number,
  canvasH: number,
  anchorX: "center" | "left-third",
  heightRatio: number,
): Promise<Buffer> {
  const targetH = Math.round(canvasH * heightRatio);
  const kvResized = await sharp(kv)
    .resize(null, targetH, { fit: "inside" })
    .toBuffer();
  const kvMeta = await sharp(kvResized).metadata();
  const kvW = kvMeta.width ?? 0;
  const kvH = kvMeta.height ?? targetH;

  // 가로 위치
  let kvLeft: number;
  if (anchorX === "left-third") {
    kvLeft = Math.round(canvasW * 0.33 - kvW / 2);
  } else {
    kvLeft = Math.round((canvasW - kvW) / 2);
  }
  // 캔버스 폭을 넘지 않도록 clamp
  kvLeft = Math.max(0, Math.min(canvasW - kvW, kvLeft));

  // 세로: 캐릭터 발이 캔버스 하단에서 5% 위에 오도록
  const bottomMargin = Math.round(canvasH * 0.05);
  let kvTop = canvasH - kvH - bottomMargin;
  if (kvTop < 0) kvTop = 0;

  // drop shadow: kv의 알파를 추출 → 검정 RGB + 해당 알파로 RGBA 재조립 → blur
  const shadowOffsetX = Math.round(kvW * 0.02);
  const shadowOffsetY = Math.round(kvH * 0.025);
  const shadowBlur = Math.max(8, Math.round(kvH * 0.02));

  const alphaRaw = await sharp(kvResized).ensureAlpha().extractChannel("alpha").raw().toBuffer();
  const shadowRaw = Buffer.alloc(kvW * kvH * 4);
  for (let i = 0; i < kvW * kvH; i++) {
    // R=G=B=0 (검정), A=원본 알파 * 0.7 (그림자 반투명)
    shadowRaw[i * 4 + 3] = Math.round(alphaRaw[i] * 0.7);
  }
  const shadow = await sharp(shadowRaw, {
    raw: { width: kvW, height: kvH, channels: 4 },
  })
    .blur(shadowBlur)
    .png()
    .toBuffer();

  return await sharp(canvas)
    .composite([
      { input: shadow, left: kvLeft + shadowOffsetX, top: kvTop + shadowOffsetY },
      { input: kvResized, left: kvLeft, top: kvTop },
    ])
    .png()
    .toBuffer();
}

/**
 * 로고를 코너 safe-zone에 합성.
 * - 로고는 캔버스 짧은 변의 18%를 최대 변으로 리사이즈
 * - safe-zone 마진은 캔버스 짧은 변의 5%
 */
export async function compositeLogoCorner(
  canvas: Buffer,
  logo: Buffer,
  canvasW: number,
  canvasH: number,
  corner: "tl" | "tr" | "bl" | "br",
): Promise<Buffer> {
  const minSide = Math.min(canvasW, canvasH);
  const logoMaxSide = Math.round(minSide * 0.18);
  const margin = Math.round(minSide * 0.05);

  const logoResized = await sharp(logo)
    .resize(logoMaxSide, logoMaxSide, { fit: "inside" })
    .toBuffer();
  const meta = await sharp(logoResized).metadata();
  const lw = meta.width ?? logoMaxSide;
  const lh = meta.height ?? logoMaxSide;

  let left: number;
  let top: number;
  switch (corner) {
    case "tl": left = margin;                  top = margin;                  break;
    case "tr": left = canvasW - lw - margin;   top = margin;                  break;
    case "bl": left = margin;                  top = canvasH - lh - margin;   break;
    case "br": left = canvasW - lw - margin;   top = canvasH - lh - margin;   break;
  }

  return await sharp(canvas)
    .composite([{ input: logoResized, left, top }])
    .png()
    .toBuffer();
}

/**
 * 가장자리 비네팅 (가운데는 그대로, 가장자리는 어둡게).
 * 검정 PNG에 중앙 라디얼 알파 그라데이션 SVG 마스크를 합성한 후
 * 원본 위에 multiply 가까운 효과를 내기 위해 over 합성한다.
 */
export async function applyVignette(
  canvas: Buffer,
  width: number,
  height: number,
): Promise<Buffer> {
  const cx = width / 2;
  const cy = height / 2;
  const rOuter = Math.round(Math.max(width, height) * 0.7);
  const rInner = Math.round(Math.min(width, height) * 0.45);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs>
      <radialGradient id="g" cx="50%" cy="50%" r="${(rOuter / Math.max(width, height)) * 100}%" fx="50%" fy="50%">
        <stop offset="${(rInner / rOuter) * 100}%" stop-color="black" stop-opacity="0"/>
        <stop offset="100%" stop-color="black" stop-opacity="0.55"/>
      </radialGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`;

  return await sharp(canvas)
    .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
    .png()
    .toBuffer();
}
