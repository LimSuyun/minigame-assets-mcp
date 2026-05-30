import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { generateImageOpenAI, editImageOpenAI } from "../services/openai.js";
import { safeRefinePrompt, type PromptTargetModel } from "../services/gpt5-prompt.js";
import { writeOptimized } from "../utils/image-output.js";
import { handleApiError } from "../utils/errors.js";
import { startLatencyTracker, buildCostTelemetry } from "../utils/cost-tracking.js";
import { generateAssetId, saveAssetToRegistry, ensureDir } from "../utils/files.js";
import type { GeneratedAsset } from "../types.js";

const DEFAULT_GENERAL_OUTPUT_DIR = process.env.GENERAL_IMAGE_OUTPUT_DIR || "./generated-images";

// 스타일 프리셋 → 프롬프트 앞에 주입되는 수식어
const STYLE_PREFIXES: Record<string, string> = {
  photorealistic:  "photorealistic, ultra-detailed, 8K photography, sharp focus, natural lighting,",
  illustration:    "digital illustration, clean artwork, vibrant colors, professional illustration style,",
  anime:           "anime style, cel-shaded, clean line art, vivid colors, manga-inspired,",
  "oil-painting":  "oil painting, textured brushstrokes, rich colors, classical art style,",
  watercolor:      "watercolor painting, soft washes, delicate textures, artistic, painterly,",
  "3d-render":     "3D render, CGI, physically based rendering, depth of field, studio lighting,",
  sketch:          "pencil sketch, hand-drawn, detailed linework, grayscale, artistic illustration,",
  "pixel-art":     "pixel art, retro game style, 16-bit, clean pixels, limited palette,",
  cinematic:       "cinematic photography, movie still, dramatic lighting, wide angle, film grain,",
  flat:            "flat design, minimal, geometric shapes, bold colors, clean vector-like style,",
};

function buildGeneralPrompt(prompt: string, style?: string): string {
  if (!style || style === "none") return prompt;
  const prefix = STYLE_PREFIXES[style];
  return prefix ? `${prefix} ${prompt}` : prompt;
}

export function registerGeneralImageTools(server: McpServer): void {
  server.registerTool(
    "image_generate",
    {
      title: "Generate General Image (Non-Game)",
      description: `게임과 무관한 일반 이미지를 생성합니다. 사진, 일러스트, 포스터, 개념 이미지 등 범용 목적.

게임 에셋 도구(asset_generate_image_openai 등)와 달리:
- 게임 컨셉(CONCEPT.md) 주입 없음
- 치비 스타일 강제 없음
- 이미지 내 텍스트 허용 (기본)
- 배경 기본값: opaque (불투명, 일반 이미지에 적합)
- 출력 기본 경로: ./generated-images

**모델 선택:**
- gpt-image-2 (기본): 최고 품질, 사진·광고·고품질 일러스트 등 추천. 투명 배경 미지원.
- gpt-image-1 / gpt-image-1.5: 중간 품질, 투명 배경 지원.
- gpt-image-1-mini: 빠르고 저렴, 단순 이미지.

**스타일 프리셋 (style 파라미터):**
  photorealistic, illustration, anime, oil-painting, watercolor,
  3d-render, sketch, pixel-art, cinematic, flat, none (직접 프롬프트 제어)

Args:
  - prompt (string): 생성할 이미지 설명
  - style (string, optional): 스타일 프리셋. 기본: none (프롬프트 그대로 사용)
  - model (string, optional): 기본 gpt-image-2
  - size (string, optional): 기본 1024x1024
  - quality (string, optional): auto | low | medium | high
  - background (string, optional): opaque (기본) | transparent | auto
  - allow_text (boolean, optional): 이미지 내 텍스트 허용 여부 (기본: true)
  - refine_prompt (boolean, optional): GPT-5로 프롬프트 확장 (기본: false)
  - filename (string, optional): 저장 파일명 (확장자 제외). 미지정 시 타임스탬프 자동 생성
  - output_dir (string, optional): 저장 디렉토리 (기본: ./generated-images)

Returns:
  저장된 파일 경로 및 이미지 메타데이터.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("생성할 이미지 설명"),
        style: z.enum([
          "none", "photorealistic", "illustration", "anime",
          "oil-painting", "watercolor", "3d-render", "sketch",
          "pixel-art", "cinematic", "flat",
        ]).default("none").describe("스타일 프리셋. none이면 프롬프트 그대로 사용"),
        model: z.enum(["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"])
          .default("gpt-image-2")
          .describe("이미지 생성 모델. 기본: gpt-image-2 (최고 품질)"),
        size: z.enum(["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536", "auto"])
          .default("1024x1024")
          .describe("이미지 크기. 1792x1024=가로형, 1024x1792=세로형"),
        quality: z.enum(["auto", "low", "medium", "high"])
          .default("auto")
          .describe("생성 품질"),
        background: z.enum(["opaque", "transparent", "auto"])
          .default("opaque")
          .describe("배경 타입. gpt-image-2는 transparent 미지원 → auto로 자동 처리"),
        allow_text: z.boolean().default(true)
          .describe("이미지 내 텍스트/문자 허용 여부. false면 텍스트 금지 지시어 추가"),
        refine_prompt: z.boolean().default(false)
          .describe("GPT-5로 프롬프트를 상세 영문으로 확장. 짧은 한국어 입력에 유용"),
        filename: z.string().optional()
          .describe("저장 파일명 (확장자 제외). 미지정 시 타임스탬프 자동 생성"),
        output_dir: z.string().optional()
          .describe("저장 디렉토리. 기본: ./generated-images"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const latency = startLatencyTracker();
      try {
        const outputDir = params.output_dir || DEFAULT_GENERAL_OUTPUT_DIR;
        ensureDir(outputDir);

        const effectiveModel = params.model;
        const supportsNativeTransparent = effectiveModel.startsWith("gpt-image-1");

        // gpt-image-2는 transparent 미지원 → opaque 요청이어도 auto로 처리
        const effectiveBg = (params.background === "transparent" && !supportsNativeTransparent)
          ? "auto"
          : params.background;

        // 프롬프트 구성
        let basePrompt = buildGeneralPrompt(params.prompt, params.style);
        if (!params.allow_text) {
          basePrompt +=
            " — CRITICAL: Do NOT render any readable text, letters, numbers, or writing anywhere in the image.";
        }

        // GPT-5 프롬프트 확장 (opt-in)
        const { text: finalPrompt, refined: refinedByGPT5 } = await safeRefinePrompt({
          enabled: params.refine_prompt,
          text: basePrompt,
          targetModel: effectiveModel as PromptTargetModel,
          assetType: "other",
          conceptHint: "",
          toolName: "image_generate",
        });

        const result = await generateImageOpenAI({
          prompt: finalPrompt,
          model: effectiveModel as "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
          size: params.size === "auto" ? "1024x1024" : params.size,
          quality: params.quality,
          background: effectiveBg,
        });

        // 파일명 결정
        const ts = Date.now();
        const safeName = params.filename
          ? params.filename.replace(/[^a-zA-Z0-9_-]/g, "_")
          : `image_${ts}`;
        const pathBase = path.join(outputDir, `${safeName}.png`);

        const imageBuffer = Buffer.from(result.base64, "base64");
        const written = await writeOptimized(imageBuffer, pathBase);
        const filePath = written.path;

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "other",
          provider: "openai",
          prompt: params.prompt,
          file_path: filePath,
          file_name: path.basename(filePath),
          mime_type: written.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            tool: "image_generate",
            style: params.style,
            model: effectiveModel,
            size: params.size,
            quality: params.quality,
            background: effectiveBg,
            refined_by_gpt5: refinedByGPT5,
            ...(refinedByGPT5 ? { refined_prompt: finalPrompt } : {}),
            ...buildCostTelemetry(effectiveModel, params.quality, params.size, latency.elapsed()),
          },
        };

        // general 이미지도 레지스트리에 등록 (output_dir 기준)
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                file_path: filePath,
                model: effectiveModel,
                style: params.style,
                size: params.size,
                refined_by_gpt5: refinedByGPT5,
                asset_id: asset.id,
              }, null, 2),
            },
            {
              type: "image" as const,
              data: result.base64,
              mimeType: result.mimeType,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "General Image Generate") }],
          isError: true,
        };
      }
    }
  );

  // ── 이미지 편집 (기존 이미지 기반 수정) ──────────────────────────────────────
  server.registerTool(
    "image_edit",
    {
      title: "Edit General Image",
      description: `기존 이미지를 기반으로 새 이미지를 생성합니다. 스타일 변환, 배경 교체, 요소 추가/제거 등.

게임 에셋 편집(asset_edit_image)과 달리 게임 컨셉 주입 없이 범용 목적으로 사용합니다.

Args:
  - image_path (string): 편집 기준이 될 원본 이미지 파일 경로
  - prompt (string): 어떻게 편집할지 설명
  - model (string, optional): 기본 gpt-image-2
  - size (string, optional): 기본 1024x1024
  - quality (string, optional): auto | low | medium | high
  - refine_prompt (boolean, optional): GPT-5로 프롬프트 확장 (기본: false)
  - filename (string, optional): 저장 파일명 (확장자 제외)
  - output_dir (string, optional): 저장 디렉토리 (기본: ./generated-images)

Returns:
  저장된 파일 경로 및 이미지 메타데이터.`,
      inputSchema: z.object({
        image_path: z.string().min(1).describe("편집 기준 원본 이미지 경로"),
        prompt: z.string().min(1).max(4000).describe("편집 지시 (예: 배경을 우주로 바꿔줘, 낮을 밤으로 변환)"),
        model: z.enum(["gpt-image-2", "gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"])
          .default("gpt-image-2")
          .describe("편집 모델"),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"])
          .default("1024x1024")
          .describe("출력 크기 (edit API 지원 크기)"),
        quality: z.enum(["auto", "low", "medium", "high"])
          .default("auto")
          .describe("생성 품질"),
        refine_prompt: z.boolean().default(false)
          .describe("GPT-5로 편집 지시를 상세 영문으로 확장"),
        filename: z.string().optional()
          .describe("저장 파일명 (확장자 제외)"),
        output_dir: z.string().optional()
          .describe("저장 디렉토리. 기본: ./generated-images"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const latency = startLatencyTracker();
      try {
        if (!fs.existsSync(params.image_path)) {
          throw new Error(`image_path 파일 없음: ${params.image_path}`);
        }

        const outputDir = params.output_dir || DEFAULT_GENERAL_OUTPUT_DIR;
        ensureDir(outputDir);

        const { text: finalPrompt, refined: refinedByGPT5 } = await safeRefinePrompt({
          enabled: params.refine_prompt,
          text: params.prompt,
          targetModel: params.model as PromptTargetModel,
          assetType: "other",
          conceptHint: "",
          toolName: "image_edit",
        });

        const result = await editImageOpenAI({
          imagePaths: [params.image_path],
          prompt: finalPrompt,
          model: params.model as "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
          size: params.size,
        });

        const ts = Date.now();
        const safeName = params.filename
          ? params.filename.replace(/[^a-zA-Z0-9_-]/g, "_")
          : `image_edit_${ts}`;
        const pathBase = path.join(outputDir, `${safeName}.png`);

        const imageBuffer = Buffer.from(result.base64, "base64");
        const written = await writeOptimized(imageBuffer, pathBase);
        const filePath = written.path;

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "other",
          provider: "openai",
          prompt: params.prompt,
          file_path: filePath,
          file_name: path.basename(filePath),
          mime_type: written.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            tool: "image_edit",
            source_image: path.resolve(params.image_path),
            model: params.model,
            refined_by_gpt5: refinedByGPT5,
            ...buildCostTelemetry(params.model, params.quality, params.size, latency.elapsed()),
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
                model: params.model,
                refined_by_gpt5: refinedByGPT5,
                asset_id: asset.id,
              }, null, 2),
            },
            {
              type: "image" as const,
              data: result.base64,
              mimeType: result.mimeType,
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "General Image Edit") }],
          isError: true,
        };
      }
    }
  );
}
