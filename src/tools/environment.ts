import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR, DEFAULT_ASSET_SIZE_SPEC_FILE, NO_TEXT_IN_IMAGE, NO_SHADOW_IN_IMAGE } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { generateImageGemini } from "../services/gemini.js";
import {
  buildAssetPath,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { startLatencyTracker, buildCostTelemetry } from "../utils/cost-tracking.js";
import { writeOptimized } from "../utils/image-output.js";
import type { GeneratedAsset, AssetSizeSpecFile } from "../types.js";

// ─── Seamless 타일링 헬퍼 ─────────────────────────────────────────────────────

/**
 * 이미지의 양끝을 블렌딩하여 seamless 타일 가능하게 만든다.
 * Sharp composite 기반 — SVG 그라디언트 마스크로 오른쪽 끝을 왼쪽에 페이드인 합성.
 */
async function makeSeamlessTileable(inputBuffer: Buffer, blendWidth = 0.15): Promise<Buffer> {
  const meta = await sharp(inputBuffer).metadata();
  const w = meta.width!;
  const h = meta.height!;
  const bw = Math.round(w * blendWidth);

  // 왼쪽 bw 픽셀을 오른쪽 끝과 블렌딩 (SVG 그라디언트 마스크)
  const gradientSvg = `<svg width="${bw}" height="${h}">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="white" stop-opacity="1"/>
        <stop offset="1" stop-color="white" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect width="${bw}" height="${h}" fill="url(#g)"/>
  </svg>`;

  // 오른쪽 끝 bw 픽셀 추출
  const rightEdge = await sharp(inputBuffer)
    .extract({ left: w - bw, top: 0, width: bw, height: h })
    .png()
    .toBuffer();

  // 마스크 적용
  const maskBuf = Buffer.from(gradientSvg);
  const maskedRight = await sharp(rightEdge)
    .composite([{ input: await sharp(maskBuf).png().toBuffer(), blend: "dest-in" }])
    .png()
    .toBuffer();

  // 왼쪽 bw 픽셀 위에 블렌딩된 오른쪽 끝 합성
  return sharp(inputBuffer)
    .composite([{ input: maskedRight, left: 0, top: 0, blend: "over" }])
    .png()
    .toBuffer();
}

// ─── 크기 스펙 로드 헬퍼 ─────────────────────────────────────────────────────

function loadSizeSpec(specFilePath: string): AssetSizeSpecFile | null {
  const resolved = path.resolve(specFilePath);
  if (!fs.existsSync(resolved)) return null;
  try {
    return JSON.parse(fs.readFileSync(resolved, "utf-8")) as AssetSizeSpecFile;
  } catch {
    return null;
  }
}

// ─── Base64 → Buffer 변환 헬퍼 ───────────────────────────────────────────────

function base64ToBuffer(base64: string): Buffer {
  return Buffer.from(base64, "base64");
}

// ─── 크기를 OpenAI 지원 사이즈로 맞추는 헬퍼 ────────────────────────────────

function nearestOpenAISize(
  w: number,
  h: number
): "1024x1024" | "1536x1024" | "1024x1536" {
  const ratio = w / h;
  if (ratio > 1.2) return "1536x1024";
  if (ratio < 0.8) return "1024x1536";
  return "1024x1024";
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerEnvironmentTools(server: McpServer): void {
  // ── 1. 패럴랙스 배경 레이어 세트 생성 ────────────────────────────────────
  server.registerTool(
    "asset_generate_parallax_set",
    {
      title: "Generate Parallax Background Layer Set",
      description: `Generate a multi-layer parallax background set for a game scene.

Produces far/mid/near/ground layers at the correct widths for smooth side-scrolling parallax.
- Far layer  : Gemini Imagen 4 (opaque, screen-fill background)
- Mid/near/ground layers: gpt-image-1 (transparent PNG, foreground objects)

Each layer is made seamlessly tileable (horizontal loop) via edge-blending.
A parallax_config.json is written alongside the images.

Args:
  - theme           : Scene theme (forest / dungeon / city / sky / desert / underwater / custom)
  - layer_count     : 2-5 layers (default 4 = far + mid + near + ground)
  - style_description : Art style (e.g. "pixel art 16-bit", "hand-drawn cartoon")
  - canvas_width    : Game canvas width in pixels (default 390)
  - canvas_height   : Game canvas height in pixels (default 844)
  - size_spec_file  : Optional path to asset_size_spec.json for automatic size loading
  - output_dir      : Output directory`,
      inputSchema: z.object({
        theme: z
          .string()
          .min(1)
          .max(100)
          .describe("Scene theme: forest | dungeon | city | sky | desert | underwater | custom"),
        layer_count: z.number().int().min(2).max(5).default(4).describe("Number of parallax layers (2-5)"),
        style_description: z.string().min(3).max(2000).describe("Art style description"),
        canvas_width: z.number().int().min(100).max(4096).default(390).describe("Canvas width in px"),
        canvas_height: z.number().int().min(100).max(4096).default(844).describe("Canvas height in px"),
        size_spec_file: z
          .string()
          .optional()
          .describe("Path to asset_size_spec.json for auto size loading"),
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
        const parallaxDir = buildAssetPath(outputDir, "backgrounds/parallax", ".");
        // buildAssetPath already calls ensureDir — remove trailing dot
        const parallaxDirResolved = path.resolve(outputDir, "backgrounds/parallax");
        ensureDir(parallaxDirResolved);

        // 크기 결정: size_spec_file 우선, 없으면 파라미터
        let sw = params.canvas_width;
        let sh = params.canvas_height;
        const specFilePath = params.size_spec_file || DEFAULT_ASSET_SIZE_SPEC_FILE;
        const sizeSpec = loadSizeSpec(specFilePath);
        if (sizeSpec) {
          sw = sizeSpec.canvas_size.width;
          sh = sizeSpec.canvas_size.height;
        }

        // 레이어 정의 (layer_count에 따라 슬라이스)
        interface LayerDef {
          name: string;
          file: string;
          widthMultiplier: number;
          transparent: boolean;
          speedFactor: number;
          provider: "gemini" | "openai";
          promptSuffix: string;
        }

        const allLayers: LayerDef[] = [
          {
            name: "far",
            file: "parallax_far.png",
            widthMultiplier: 2.5,
            transparent: false,
            speedFactor: 0.1,
            provider: "gemini",
            promptSuffix:
              "distant background scenery, fills entire frame, no foreground elements, solid opaque background",
          },
          {
            name: "mid",
            file: "parallax_mid.png",
            widthMultiplier: 3.5,
            transparent: true,
            speedFactor: 0.3,
            provider: "openai",
            promptSuffix:
              "mid-ground elements, scattered objects, transparent background, no ground or sky fill",
          },
          {
            name: "near",
            file: "parallax_near.png",
            widthMultiplier: 5.0,
            transparent: true,
            speedFactor: 0.6,
            provider: "openai",
            promptSuffix:
              "near-ground foreground details, close-up plants / rocks / debris, transparent background",
          },
          {
            name: "ground",
            file: "parallax_ground.png",
            widthMultiplier: 2.0,
            transparent: true,
            speedFactor: 1.0,
            provider: "openai",
            promptSuffix:
              "ground-level strip, terrain surface / floor details only, transparent background",
          },
          {
            name: "extra",
            file: "parallax_extra.png",
            widthMultiplier: 4.0,
            transparent: true,
            speedFactor: 0.8,
            provider: "openai",
            promptSuffix:
              "additional decorative layer, scattered floating elements, transparent background",
          },
        ];

        const layers = allLayers.slice(0, params.layer_count);

        interface LayerResult {
          name: string;
          file: string;
          file_path: string;
          speed_factor: number;
          transparent: boolean;
          width: number;
          height: number;
          provider: string;
        }

        const layerResults: LayerResult[] = [];

        for (const layer of layers) {
          const layerW = Math.round(sw * layer.widthMultiplier);
          const layerH = sh;

          const prompt =
            `${params.theme} theme parallax background layer — ${layer.name} distance. ` +
            `${params.style_description}. ` +
            `${layer.promptSuffix}. ` +
            `Horizontal seamless tileable, width ${layerW}px × height ${layerH}px. ` +
            `Clean 2D game asset. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

          let rawBuffer: Buffer;

          let callModel: string = "gpt-image-1-mini";
          let callSize: string | undefined;
          const latency = startLatencyTracker();
          if (layer.provider === "gemini") {
            // 종횡비 계산 → Gemini aspectRatio
            const ratio = layerW / layerH;
            let aspectRatio: "1:1" | "3:4" | "4:3" | "9:16" | "16:9" = "1:1";
            if (ratio >= 1.6) aspectRatio = "16:9";
            else if (ratio >= 1.2) aspectRatio = "4:3";
            else if (ratio <= 0.65) aspectRatio = "9:16";
            else if (ratio <= 0.85) aspectRatio = "3:4";

            const result = await generateImageGemini({ prompt, aspectRatio });
            rawBuffer = base64ToBuffer(result.base64);
            callModel = result.model;
          } else {
            // gpt-image-1 — 투명 배경
            const openaiSize = nearestOpenAISize(layerW, layerH);
            const result = await generateImageOpenAI({
              prompt,
              size: openaiSize,
              quality: "medium",
              background: "transparent",
            });
            rawBuffer = base64ToBuffer(result.base64);
            callSize = openaiSize;
          }
          const layerLatencyMs = latency.elapsed();

          // 목표 크기로 리사이즈
          const resized = await sharp(rawBuffer)
            .resize(layerW, layerH, { fit: "cover" })
            .png()
            .toBuffer();

          // Seamless 타일링 처리
          const seamless = await makeSeamlessTileable(resized);

          // 저장 (engine-aware 포맷)
          const pathBase = path.join(parallaxDirResolved, layer.file);
          const written = await writeOptimized(seamless, pathBase);
          const filePath = written.path;

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "background",
            provider: layer.provider === "gemini" ? `gemini-${callModel}` : "openai-gpt-image-1",
            prompt,
            file_path: filePath,
            file_name: path.basename(filePath),
            mime_type: written.format === "webp" ? "image/webp" : "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              theme: params.theme,
              layer_name: layer.name,
              transparent: layer.transparent,
              speed_factor: layer.speedFactor,
              width: layerW,
              height: layerH,
              model: callModel,
              ...buildCostTelemetry(callModel, "medium", callSize, layerLatencyMs),
            },
          };
          saveAssetToRegistry(asset, outputDir);

          layerResults.push({
            name: layer.name,
            file: layer.file,
            file_path: filePath,
            speed_factor: layer.speedFactor,
            transparent: layer.transparent,
            width: layerW,
            height: layerH,
            provider: asset.provider,
          });
        }

        // parallax_config.json 생성
        const config = {
          theme: params.theme,
          canvas_width: sw,
          canvas_height: sh,
          layers: layerResults.map((l) => ({
            name: l.name,
            file: l.file,
            speed_factor: l.speed_factor,
            transparent: l.transparent,
            width: l.width,
            height: l.height,
          })),
          generated_at: new Date().toISOString(),
        };
        const configPath = path.join(parallaxDirResolved, "parallax_config.json");
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  theme: params.theme,
                  output_dir: parallaxDirResolved,
                  config_path: configPath,
                  layers: layerResults,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Parallax Set") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. 게임 맵 타일셋 생성 ────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_tileset",
    {
      title: "Generate Game Map Tileset",
      description: `Generate a complete game map tileset PNG and its configuration JSON.

Produces a 16×16 grid tileset image where each cell is T×T pixels (T = tile_size).
Individual tiles are generated via gpt-image-1, then composed with Sharp into the final sheet.
Each tile is made seamlessly tileable before placement.

Included tile types:
  ground_top, ground_mid, ground_bot, platform, wall_left, wall_right,
  ceiling, grass, flower, stone, spike, water, void, spawn, goal, ladder

Args:
  - theme           : Tile theme (forest / dungeon / city / snow / desert / custom)
  - tile_size       : Size of each tile in px — 16 | 32 | 48 | 64 (default 64)
  - style_description : Art style description
  - tileset_type    : "topdown" | "sidescroller" | "isometric" (default "sidescroller")
  - output_dir      : Output directory`,
      inputSchema: z.object({
        theme: z.string().min(1).max(100).describe("Tile theme: forest | dungeon | city | snow | desert | custom"),
        tile_size: z.union([z.literal(16), z.literal(32), z.literal(48), z.literal(64)]).default(64).describe("Tile size in px"),
        style_description: z.string().min(3).max(2000).describe("Art style description"),
        tileset_type: z
          .enum(["topdown", "sidescroller", "isometric"])
          .default("sidescroller")
          .describe("Map type"),
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
        const tilesetDir = path.resolve(outputDir, "tilesets");
        ensureDir(tilesetDir);

        const T = params.tile_size;
        const COLS = 16;
        const ROWS = 16;

        interface TileDefinition {
          id: number;
          type: string;
          name: string;
          description: string;
        }

        // 표준 타일 목록 (0-15번 타일)
        const standardTiles: TileDefinition[] = [
          { id: 0, type: "ground_top", name: "Ground Top", description: "top surface of solid ground with grass or dirt top edge" },
          { id: 1, type: "ground_mid", name: "Ground Middle", description: "solid ground middle fill, uniform earth/rock texture" },
          { id: 2, type: "ground_bot", name: "Ground Bottom", description: "solid ground bottom edge, slight darker shade" },
          { id: 3, type: "platform", name: "Platform", description: "floating platform tile, flat top surface, slightly elevated" },
          { id: 4, type: "wall_left", name: "Wall Left", description: "vertical wall tile with left-facing surface detail" },
          { id: 5, type: "wall_right", name: "Wall Right", description: "vertical wall tile with right-facing surface detail" },
          { id: 6, type: "ceiling", name: "Ceiling", description: "ceiling tile, bottom-facing surface, stalactites or flat" },
          { id: 7, type: "grass", name: "Grass", description: "decorative grass surface, short blades of grass on flat ground" },
          { id: 8, type: "flower", name: "Flower", description: "decorative small flower on ground, colorful petals" },
          { id: 9, type: "stone", name: "Stone", description: "loose stone / boulder decorative element on ground" },
          { id: 10, type: "spike", name: "Spike", description: "hazard spike tile, sharp upward-pointing metal or stone spike" },
          { id: 11, type: "water", name: "Water", description: "water tile, blue translucent liquid surface with wave ripple" },
          { id: 12, type: "void", name: "Void", description: "empty void / pit tile, completely dark or transparent" },
          { id: 13, type: "spawn", name: "Spawn Point", description: "player spawn point marker, subtle glowing indicator on ground" },
          { id: 14, type: "goal", name: "Goal", description: "level goal / exit tile, glowing portal or door indicator" },
          { id: 15, type: "ladder", name: "Ladder", description: "vertical ladder tile, wooden or metal rungs for climbing" },
        ];

        // 나머지 타일 (16-255)은 빈 투명 타일
        const allTileConfigs: Array<{ id: number; x: number; y: number; type: string; name: string }> = [];

        for (let row = 0; row < ROWS; row++) {
          for (let col = 0; col < COLS; col++) {
            const id = row * COLS + col;
            const tileId = id < standardTiles.length ? id : id;
            allTileConfigs.push({
              id,
              x: col * T,
              y: row * T,
              type: id < standardTiles.length ? standardTiles[id].type : "empty",
              name: id < standardTiles.length ? standardTiles[id].name : `tile_${id}`,
            });
          }
        }

        // 타일셋 시트 캔버스 생성 (투명 배경)
        const sheetW = COLS * T;
        const sheetH = ROWS * T;

        let sheetBuffer = await sharp({
          create: {
            width: sheetW,
            height: sheetH,
            channels: 4,
            background: { r: 0, g: 0, b: 0, alpha: 0 },
          },
        })
          .png()
          .toBuffer();

        // 표준 타일 16개를 gpt-image-1로 생성 후 시트에 배치
        const generatedTiles: Array<{ id: number; success: boolean; error?: string }> = [];
        const tilesetLatency = startLatencyTracker();

        for (const tileDef of standardTiles) {
          const col = tileDef.id % COLS;
          const row = Math.floor(tileDef.id / COLS);

          const prompt =
            `Single game tile: ${tileDef.description}. ` +
            `${params.theme} theme, ${params.tileset_type} perspective. ` +
            `${params.style_description}. ` +
            `Exactly ${T}×${T}px tile, seamlessly tileable, solid (non-transparent) background matching the tile type. ` +
            `Clean pixel-art or cartoon style tile. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

          try {
            const result = await generateImageOpenAI({
              prompt,
              size: "1024x1024",
              quality: "medium",
              background: "opaque",
            });

            const rawBuffer = base64ToBuffer(result.base64);

            // T×T로 리사이즈
            const resized = await sharp(rawBuffer)
              .resize(T, T, { fit: "cover" })
              .png()
              .toBuffer();

            // Seamless 처리
            const seamless = await makeSeamlessTileable(resized);

            // 시트에 합성
            sheetBuffer = await sharp(sheetBuffer)
              .composite([{ input: seamless, left: col * T, top: row * T }])
              .png()
              .toBuffer();

            generatedTiles.push({ id: tileDef.id, success: true });
          } catch (err) {
            generatedTiles.push({
              id: tileDef.id,
              success: false,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }

        // 파일 저장 (engine-aware 포맷)
        const tilesetPathBase = path.join(tilesetDir, `${params.theme}_tileset.png`);
        const tilesetWritten = await writeOptimized(sheetBuffer, tilesetPathBase);
        const tilesetPath = tilesetWritten.path;
        const tilesetFileName = path.basename(tilesetPath);

        // 설정 JSON 저장
        const tilesetConfig = {
          theme: params.theme,
          tileset_type: params.tileset_type,
          tile_size: T,
          cols: COLS,
          rows: ROWS,
          sheet_width: sheetW,
          sheet_height: sheetH,
          tiles: allTileConfigs,
          generated_at: new Date().toISOString(),
        };
        const configFileName = `${params.theme}_tileset_config.json`;
        const configPath = path.join(tilesetDir, configFileName);
        fs.writeFileSync(configPath, JSON.stringify(tilesetConfig, null, 2));

        const tilesetSuccessCount = generatedTiles.filter((t) => t.success).length;
        const tilesetLatencyMs = tilesetLatency.elapsed();
        const tilesetCost = buildCostTelemetry("gpt-image-1-mini", "medium", "1024x1024", tilesetLatencyMs);
        // 타일 1장당 cost를 성공한 타일 수만큼 곱해 집계
        tilesetCost.est_cost_usd = +(tilesetCost.est_cost_usd * tilesetSuccessCount).toFixed(4);
        tilesetCost.cost_formula = `${tilesetCost.cost_formula} × ${tilesetSuccessCount} tiles`;

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "tile",
          provider: "openai-gpt-image-1",
          prompt: `${params.theme} tileset, ${params.style_description}`,
          file_path: tilesetPath,
          file_name: tilesetFileName,
          mime_type: tilesetWritten.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            theme: params.theme,
            tile_size: T,
            tileset_type: params.tileset_type,
            cols: COLS,
            rows: ROWS,
            config_path: configPath,
            ...tilesetCost,
          },
        };
        saveAssetToRegistry(asset, outputDir);

        const succeeded = generatedTiles.filter((t) => t.success).length;

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: true,
                  theme: params.theme,
                  tileset_path: tilesetPath,
                  config_path: configPath,
                  tile_size: T,
                  sheet_size: { width: sheetW, height: sheetH },
                  tiles_generated: succeeded,
                  tiles_total: standardTiles.length,
                  tile_results: generatedTiles,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Tileset") }],
          isError: true,
        };
      }
    }
  );

  // ── 3. 맵 배치용 소품 세트 생성 ─────────────────────────────────────────────
  server.registerTool(
    "asset_generate_props_set",
    {
      title: "Generate Map Props Set",
      description: `Generate a set of decorative / interactive map props for a game level.

Each prop is generated as a separate transparent PNG using gpt-image-1.
Props are saved to {output_dir}/props/{theme}/ with individual file names.

Args:
  - theme            : Scene theme for context (e.g. "forest", "dungeon", "city")
  - props            : Array of prop definitions { id, name, description }
  - style_description : Art style description
  - output_dir       : Output directory`,
      inputSchema: z.object({
        theme: z.string().min(1).max(100).describe("Scene theme for visual context"),
        props: z
          .array(
            z.object({
              id: z.string().min(1).max(100).describe("Prop identifier for file naming"),
              name: z.string().min(1).max(200).describe("Human-readable prop name"),
              description: z.string().min(3).max(1000).describe("Visual description of the prop"),
            })
          )
          .min(1)
          .max(30)
          .describe("List of props to generate"),
        style_description: z.string().min(3).max(2000).describe("Art style description"),
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
        const safeTheme = params.theme.replace(/[^a-zA-Z0-9_-]/g, "_");
        const propsDir = path.resolve(outputDir, `props/${safeTheme}`);
        ensureDir(propsDir);

        interface PropResult {
          id: string;
          name: string;
          file_path: string;
          file_name: string;
          success: boolean;
          error?: string;
        }

        const results: PropResult[] = [];

        for (const prop of params.props) {
          const safeId = prop.id.replace(/[^a-zA-Z0-9_-]/g, "_");
          const pathBase = path.join(propsDir, `${safeId}.png`);

          const prompt =
            `Game map prop: ${prop.name}. ${prop.description}. ` +
            `${params.theme} theme environment. ` +
            `${params.style_description}. ` +
            `Single isolated object, transparent background, no shadow on background. ` +
            `Clean 2D game asset, full object visible, centered in frame. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

          try {
            const propLatency = startLatencyTracker();
            const result = await generateImageOpenAI({
              prompt,
              size: "1024x1024",
              quality: "medium",
              background: "transparent",
            });
            const propLatencyMs = propLatency.elapsed();

            const buffer = base64ToBuffer(result.base64);
            const written = await writeOptimized(buffer, pathBase);
            const filePath = written.path;
            const fileName = path.basename(filePath);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "other",
              provider: "openai-gpt-image-1",
              prompt,
              file_path: filePath,
              file_name: fileName,
              mime_type: written.format === "webp" ? "image/webp" : "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                theme: params.theme,
                prop_id: prop.id,
                prop_name: prop.name,
                ...buildCostTelemetry("gpt-image-1-mini", "medium", "1024x1024", propLatencyMs),
              },
            };
            saveAssetToRegistry(asset, outputDir);

            results.push({ id: prop.id, name: prop.name, file_path: filePath, file_name: fileName, success: true });
          } catch (err) {
            results.push({
              id: prop.id,
              name: prop.name,
              file_path: "",
              file_name: path.basename(pathBase),
              success: false,
              error: err instanceof Error ? err.message : String(err),
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
                  theme: params.theme,
                  output_dir: propsDir,
                  total: results.length,
                  succeeded,
                  failed: results.length - succeeded,
                  props: results,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Props Set") }],
          isError: true,
        };
      }
    }
  );

  // ── 4. 인터랙티브 오브젝트 상태별 스프라이트 생성 ────────────────────────
  server.registerTool(
    "asset_generate_interactive_objects",
    {
      title: "Generate Interactive Object State Sprites",
      description: `Generate per-state sprites for interactive game objects (e.g. doors, chests, switches, traps).

For each object × state combination, a transparent PNG is generated via gpt-image-1.
An atlas JSON is written per object listing all state file paths.

Args:
  - objects          : Array of { id, states[], description? }
                       e.g. [{ id: "chest", states: ["closed", "open", "empty"], description: "wooden treasure chest" }]
  - style_description : Art style description
  - frame_size       : Size of each sprite — 64 | 128 | 256 (default 128)
  - output_dir       : Output directory`,
      inputSchema: z.object({
        objects: z
          .array(
            z.object({
              id: z.string().min(1).max(100).describe("Object identifier for file naming"),
              states: z
                .array(z.string().min(1).max(100))
                .min(1)
                .max(10)
                .describe("State names (e.g. closed, open, activated, broken)"),
              description: z.string().max(1000).optional().describe("Visual description of the object"),
            })
          )
          .min(1)
          .max(20)
          .describe("List of interactive objects"),
        style_description: z.string().min(3).max(2000).describe("Art style description"),
        frame_size: z
          .union([z.literal(64), z.literal(128), z.literal(256)])
          .default(128)
          .describe("Sprite frame size in px"),
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
        const objectsDir = path.resolve(outputDir, "interactive_objects");
        ensureDir(objectsDir);

        const F = params.frame_size;

        interface ObjectResult {
          id: string;
          atlas_path: string;
          states: Array<{
            state: string;
            file_path: string;
            file_name: string;
            success: boolean;
            error?: string;
          }>;
        }

        const objectResults: ObjectResult[] = [];

        for (const obj of params.objects) {
          const safeId = obj.id.replace(/[^a-zA-Z0-9_-]/g, "_");
          const objDir = path.join(objectsDir, safeId);
          ensureDir(objDir);

          const stateResults: ObjectResult["states"] = [];

          for (const state of obj.states) {
            const safeState = state.replace(/[^a-zA-Z0-9_-]/g, "_");
            const pathBase = path.join(objDir, `${safeId}_${safeState}.png`);

            const objectDesc = obj.description
              ? `${obj.id}: ${obj.description}`
              : obj.id;

            const prompt =
              `Interactive game object — ${objectDesc}. ` +
              `Current state: "${state}". ` +
              `${params.style_description}. ` +
              `${F}×${F}px sprite, transparent background, single object centered, ` +
              `no background fill, clean 2D game asset. ` +
              `State "${state}" must be clearly visually distinct (e.g. open vs closed, active vs inactive). ` +
              `${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

            try {
              const openaiSize: "1024x1024" = "1024x1024";
              const stateLatency = startLatencyTracker();
              const result = await generateImageOpenAI({
                prompt,
                size: openaiSize,
                quality: "medium",
                background: "transparent",
              });
              const stateLatencyMs = stateLatency.elapsed();

              const rawBuffer = base64ToBuffer(result.base64);

              // F×F로 리사이즈
              const resized = await sharp(rawBuffer)
                .resize(F, F, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer();

              const written = await writeOptimized(resized, pathBase);
              const filePath = written.path;
              const fileName = path.basename(filePath);

              const asset: GeneratedAsset = {
                id: generateAssetId(),
                type: "image",
                asset_type: "sprite",
                provider: "openai-gpt-image-1",
                prompt,
                file_path: filePath,
                file_name: fileName,
                mime_type: written.format === "webp" ? "image/webp" : "image/png",
                created_at: new Date().toISOString(),
                metadata: {
                  object_id: obj.id,
                  state,
                  frame_size: F,
                  ...buildCostTelemetry("gpt-image-1-mini", "medium", openaiSize, stateLatencyMs),
                },
              };
              saveAssetToRegistry(asset, outputDir);

              stateResults.push({ state, file_path: filePath, file_name: fileName, success: true });
            } catch (err) {
              stateResults.push({
                state,
                file_path: "",
                file_name: path.basename(pathBase),
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Atlas JSON 생성
          const atlasData: Record<string, string> = {};
          for (const sr of stateResults) {
            if (sr.success) {
              atlasData[sr.state] = sr.file_path;
            }
          }

          const atlasFileName = `${safeId}_atlas.json`;
          const atlasPath = path.join(objDir, atlasFileName);
          const atlas = {
            object_id: obj.id,
            description: obj.description ?? "",
            frame_size: F,
            states: atlasData,
            generated_at: new Date().toISOString(),
          };
          fs.writeFileSync(atlasPath, JSON.stringify(atlas, null, 2));

          objectResults.push({
            id: obj.id,
            atlas_path: atlasPath,
            states: stateResults,
          });
        }

        const totalSprites = objectResults.reduce((sum, o) => sum + o.states.length, 0);
        const succeededSprites = objectResults.reduce(
          (sum, o) => sum + o.states.filter((s) => s.success).length,
          0
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(
                {
                  success: succeededSprites > 0,
                  output_dir: objectsDir,
                  total_sprites: totalSprites,
                  succeeded: succeededSprites,
                  failed: totalSprites - succeededSprites,
                  frame_size: F,
                  objects: objectResults,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Interactive Objects") }],
          isError: true,
        };
      }
    }
  );
}
