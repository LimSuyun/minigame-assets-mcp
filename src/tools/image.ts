import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, ASSET_TYPES, NO_PADDING_TYPES } from "../constants.js";
import { generateImageOpenAI, generateImageWithResponses } from "../services/openai.js";
import { refineImagePrompt } from "../services/gpt5-prompt.js";
import { OPENAI_IMAGE_MODELS } from "../constants.js";
import {
  buildAssetPath,
  generateFileName,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
} from "../utils/files.js";
import { addPadding } from "../utils/image-process.js";
import { handleApiError } from "../utils/errors.js";
import { startLatencyTracker, buildCostTelemetry } from "../utils/cost-tracking.js";
import type { GameConcept, GeneratedAsset } from "../types.js";

function loadConceptForPrompt(conceptFile: string): string {
  const resolved = path.resolve(conceptFile);
  if (!fs.existsSync(resolved)) return "";
  const concept = JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameConcept;
  return (
    `Game: ${concept.game_name}. Style: ${concept.art_style}. ` +
    `Theme: ${concept.theme}. Colors: ${concept.color_palette.join(", ")}.`
  );
}

/**
 * CONCEPT.md의 "BASE STYLE PROMPT" 코드블록 내용을 추출합니다.
 * generate_assets.py의 BASE_STYLE / WEAPON_STYLE 방식과 동일하게 프롬프트 앞에 주입됩니다.
 */
function loadBaseStyleFromConceptMd(conceptMdPath: string): string {
  const resolved = path.resolve(conceptMdPath);
  if (!fs.existsSync(resolved)) return "";

  const content = fs.readFileSync(resolved, "utf-8");

  // "## BASE STYLE PROMPT" 섹션의 첫 번째 코드블록(``` ```) 내용을 추출
  const sectionMatch = content.match(/##\s+BASE STYLE PROMPT[^\n]*\n[\s\S]*?```([^`]*)```/);
  if (!sectionMatch) return "";

  return sectionMatch[1].trim().replace(/\n/g, " ");
}

function buildEnrichedPrompt(prompt: string, assetType: string, conceptHint: string): string {
  if (!conceptHint) return prompt;
  return `${prompt}. Asset type: ${assetType}. ${conceptHint}`;
}

/**
 * BASE_STYLE을 프롬프트 앞에 주입 (generate_assets.py 방식: `f"{style}, {prompt}"`)
 */
function buildStyledPrompt(prompt: string, baseStyle: string): string {
  if (!baseStyle) return prompt;
  return `${baseStyle}, ${prompt}`;
}



export function registerImageTools(server: McpServer): void {
  // ── Generate Image (OpenAI DALL-E) ─────────────────────────────────────────
  server.registerTool(
    "asset_generate_image_openai",
    {
      title: "Generate Game Asset Image (OpenAI)",
      description: `Generate a game asset image using OpenAI gpt-image-1-mini (default — 2D 미니게임 저비용 최적).

**모델 선택 정책 (범용 이미지 도구):**
- 기본값 gpt-image-1-mini — 단순 치비/2D 에셋, 투명 배경 네이티브 지원, 저비용
- 고디테일·텍스트·4K가 필요한 경우 model: "gpt-image-2" 명시 (투명 배경 미지원 → auto로 자동 강등됨)
- 중간 품질이 필요하면 model: "gpt-image-1.5"
※ 캐릭터/썸네일/로딩·로비 화면 등 특수 목적 도구는 내부적으로 gpt-image-2를 기본값으로 사용합니다.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 .minigame-assets/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로를 읽고 추가 질문 없이 바로 생성을 진행하세요.

Saves the generated image to the assets directory and returns the file path along with the inline image data.

Args:
  - prompt (string): Description of the image to generate
  - asset_type (string): Type of game asset (character, sprite, background, ui_element, icon, tile, effect, logo, other)
  - size (string, optional): Image size - "1024x1024" (default), "1792x1024" (landscape), "1024x1792" (portrait)
  - quality (string, optional): "auto" (default) | "low" | "medium" | "high"
  - use_concept (boolean, optional): Whether to inject the current game concept into the prompt (default: true)
  - concept_file (string, optional): Path to game concept file (default: ./game-concept.json)
  - output_dir (string, optional): Output directory for the asset (default: ./.minigame-assets)

Returns:
  File path of the saved image, revised prompt from OpenAI, and asset metadata.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Description of the image to generate"),
        asset_type: z.enum(ASSET_TYPES).default("sprite").describe("Type of game asset"),
        model: z.enum(OPENAI_IMAGE_MODELS).default("gpt-image-1-mini").describe("OpenAI image model: gpt-image-1-mini (default, 2D 미니게임 최적) | gpt-image-1 | gpt-image-1.5 (고디테일) | gpt-image-2 (4K·다국어 텍스트, 투명 배경 미지원 — transparent 요청 시 auto로 자동 강등)"),
        size: z.enum(["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536", "auto"]).default("1024x1024").describe("Generation size"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("auto").describe("Generation quality"),
        background: z.enum(["transparent", "opaque", "auto"]).default("transparent").describe("Background type: transparent outputs native RGBA PNG (gpt-image-2는 미지원 → auto로 자동 강등, 크로마키 후처리 필요)"),
        refine_prompt: z.boolean().default(false).describe("GPT-5(기본: gpt-5.4-nano)로 prompt를 상세 영문으로 확장 후 이미지 생성. 짧거나 한국어 입력에 유용. 기본: false"),
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
        const conceptHint = params.use_concept ? loadConceptForPrompt(conceptFile) : "";

        // GPT-5 프롬프트 리파인 (opt-in)
        let userPrompt = params.prompt;
        let refinedByGPT5 = false;
        if (params.refine_prompt) {
          try {
            userPrompt = await refineImagePrompt({
              userDescription: params.prompt,
              targetModel: params.model as
                | "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
              assetType: params.asset_type as
                | "character" | "background" | "thumbnail" | "sprite" | "weapon" | "icon" | "logo" | "other",
              conceptHint,
            });
            refinedByGPT5 = true;
          } catch (refineErr) {
            console.warn(`[refine_prompt] image_openai refinement failed, using original: ${refineErr instanceof Error ? refineErr.message : refineErr}`);
          }
        }

        const enrichedPrompt = buildEnrichedPrompt(userPrompt, params.asset_type, conceptHint);

        const latency = startLatencyTracker();
        const result = await generateImageOpenAI({
          prompt: enrichedPrompt,
          model: params.model,
          size: params.size,
          quality: params.quality,
          background: params.background,
        });

        const fileName = generateFileName(`${params.asset_type}_openai`, "png");
        const filePath = buildAssetPath(outputDir, "images", fileName);
        saveBase64File(result.base64, filePath);

        // 캐릭터/스프라이트/무기 등 투명 배경 에셋은 여백 추가로 잘림 방지
        if (!NO_PADDING_TYPES.includes(params.asset_type)) {
          await addPadding(filePath, filePath, 5);
        }

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: params.asset_type,
          provider: "openai",
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            revised_prompt: result.revisedPrompt,
            size: params.size,
            quality: params.quality,
            refined_by_gpt5: refinedByGPT5,
            ...(refinedByGPT5 ? { refined_prompt: userPrompt } : {}),
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
                asset_id: asset.id,
                revised_prompt: result.revisedPrompt,
                asset_type: params.asset_type,
                provider: "openai",
                refined_by_gpt5: refinedByGPT5,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "OpenAI Image") }],
          isError: true,
        };
      }
    }
  );


  // ── Batch Generate Images ──────────────────────────────────────────────────
  server.registerTool(
    "asset_batch_generate_images",
    {
      title: "Batch Generate Game Asset Images",
      description: `Generate multiple game asset images in one call based on a list of specifications.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 .minigame-assets/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로(.minigame-assets/ 하위 JSON)를 읽고
추가 질문 없이 바로 생성을 진행하세요. 한 번 호출에 최대 10개까지 생성 가능합니다.

Useful for generating a complete set of initial assets for a game (characters, backgrounds, UI elements, etc.).

**기본 프로바이더 규칙 (v2.0+):**
- 모든 에셋 타입 기본 OpenAI (gpt-image-1-mini 저비용 / 필요 시 gpt-image-2 고품질).
- 배경도 gpt-image-2의 디테일/텍스트 렌더링이 우수합니다.

Args:
  - specs (array): List of image specs, each with: prompt, asset_type, model (optional)
  - concept_md (string, optional): Path to CONCEPT.md — BASE STYLE PROMPT section will be prepended to every prompt
  - use_concept (boolean, optional): Inject game-concept.json style hint into all prompts (default: false)
  - concept_file (string, optional): Path to game concept JSON
  - output_dir (string, optional): Output directory

Returns:
  Array of results for each generated image (success/failure, file path, asset ID).`,
      inputSchema: z.object({
        specs: z.array(z.object({
          prompt: z.string().min(1).max(4000).describe("Image description"),
          asset_type: z.enum(ASSET_TYPES).describe("Asset type"),
          model: z.enum(OPENAI_IMAGE_MODELS).default("gpt-image-1-mini").describe("OpenAI image model: gpt-image-1-mini (default) | gpt-image-1 | gpt-image-1.5 (고디테일) | gpt-image-2 (4K·다국어 텍스트, 투명 배경 미지원)"),
          size: z.enum(["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536", "auto"]).optional().describe("Size (OpenAI only)"),
          quality: z.enum(["low", "medium", "high", "auto"]).optional().describe("Quality (default: medium)"),
          aspect_ratio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).optional().describe("Aspect ratio"),
        })).min(1).max(10).describe("List of image specs (max 10)"),
        concept_md: z.string().optional().describe("Path to CONCEPT.md — BASE STYLE PROMPT section prepended to every prompt"),
        use_concept: z.boolean().default(false).describe("Inject game-concept.json style hint into prompts"),
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
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const conceptFile = params.concept_file || DEFAULT_CONCEPT_FILE;
      const conceptHint = params.use_concept ? loadConceptForPrompt(conceptFile) : "";

      // CONCEPT.md BASE STYLE PROMPT 로드 (generate_assets.py의 BASE_STYLE 방식)
      const baseStyle = params.concept_md ? loadBaseStyleFromConceptMd(params.concept_md) : "";

      const results: Array<{
        index: number;
        prompt: string;
        asset_type: string;
        provider: string;
        model: string;
        success: boolean;
        file_path?: string;
        asset_id?: string;
        error?: string;
      }> = [];

      for (let i = 0; i < params.specs.length; i++) {
        const spec = params.specs[i];
        const styledPrompt = buildStyledPrompt(spec.prompt, baseStyle);
        const finalPrompt = buildEnrichedPrompt(styledPrompt, spec.asset_type, conceptHint);
        const model = spec.model ?? "gpt-image-1-mini";

        try {
          const latency = startLatencyTracker();
          const r = await generateImageOpenAI({
            prompt: finalPrompt,
            model: spec.model,
            size: spec.size,
            quality: spec.quality ?? "medium",
            background: "transparent",
          });
          const base64 = r.base64;
          const mimeType = r.mimeType;
          const usedModel: string = model;
          const latencyMs = latency.elapsed();

          const ext = mimeType.includes("jpeg") ? "jpg" : "png";
          const fileName = generateFileName(`${spec.asset_type}_openai`, ext);
          const filePath = buildAssetPath(outputDir, "images", fileName);
          saveBase64File(base64, filePath);

          // 캐릭터/스프라이트/무기 등 투명 배경 에셋은 여백 추가로 잘림 방지
          if (!NO_PADDING_TYPES.includes(spec.asset_type)) {
            await addPadding(filePath, filePath, 5);
          }

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: spec.asset_type,
            provider: "openai",
            prompt: spec.prompt,
            file_path: filePath,
            file_name: fileName,
            mime_type: mimeType,
            created_at: new Date().toISOString(),
            metadata: {
              model: usedModel,
              ...buildCostTelemetry(usedModel, spec.quality ?? "medium", spec.size, latencyMs),
            },
          };

          saveAssetToRegistry(asset, outputDir);

          results.push({
            index: i,
            prompt: spec.prompt,
            asset_type: spec.asset_type,
            provider: "openai",
            model,
            success: true,
            file_path: filePath,
            asset_id: asset.id,
          });
        } catch (error) {
          results.push({
            index: i,
            prompt: spec.prompt,
            asset_type: spec.asset_type,
            provider: "openai",
            model,
            success: false,
            error: handleApiError(error, "openai"),
          });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      const output = {
        total: params.specs.length,
        succeeded,
        failed: params.specs.length - succeeded,
        results,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── Generate Image (Auto-route by asset_type) ──────────────────────────────
  server.registerTool(
    "asset_generate_image",
    {
      title: "Generate Game Asset Image (Auto-select Provider)",
      description: `Generate a single game asset image, automatically selecting the AI provider based on asset_type.

**기본 프로바이더 규칙 (v2.0+):**
- 모든 에셋 타입 기본 OpenAI (gpt-image-* 계열). 배경도 gpt-image-2 디테일이 우수.

provider 파라미터로 명시적으로 지정하면 기본값을 덮어씁니다.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 .minigame-assets/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마를 읽고 추가 질문 없이 바로 생성을 진행하세요.

Args:
  - prompt (string): Description of the image to generate
  - asset_type (string): Type of game asset — determines default provider
  - output_dir (string, optional): Output directory (default: ./.minigame-assets)
  - use_concept (boolean, optional): Inject game-concept.json style hint (default: true)

Returns:
  File path of the saved image and asset metadata.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Description of the image to generate"),
        asset_type: z.enum(ASSET_TYPES).default("sprite").describe("Type of game asset (determines default provider)"),
        output_dir: z.string().optional().describe("Output directory"),
        use_concept: z.boolean().default(true).describe("Inject game concept into prompt"),
        concept_file: z.string().optional().describe("Path to game concept JSON"),
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
        const conceptHint = params.use_concept ? loadConceptForPrompt(conceptFile) : "";

        const usedModel = "gpt-image-1-mini";

        const latency = startLatencyTracker();
        const enrichedPrompt = buildEnrichedPrompt(params.prompt, params.asset_type, conceptHint);
        const r = await generateImageOpenAI({
          prompt: enrichedPrompt,
          quality: "medium",
          background: "transparent",
        });
        const base64 = r.base64;
        const mimeType = r.mimeType;
        const latencyMs = latency.elapsed();

        const ext = mimeType.includes("jpeg") ? "jpg" : "png";
        const fileName = generateFileName(`${params.asset_type}_openai`, ext);
        const filePath = buildAssetPath(outputDir, "images", fileName);
        saveBase64File(base64, filePath);

        // 캐릭터/스프라이트/무기 등 투명 배경 에셋은 여백 추가로 잘림 방지
        if (!NO_PADDING_TYPES.includes(params.asset_type)) {
          await addPadding(filePath, filePath, 5);
        }

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: params.asset_type,
          provider: "openai",
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: mimeType,
          created_at: new Date().toISOString(),
          metadata: {
            model: usedModel,
            ...buildCostTelemetry(usedModel, "medium", undefined, latencyMs),
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
                asset_type: params.asset_type,
                provider: "openai",
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Auto Image") }],
          isError: true,
        };
      }
    }
  );

  // ── Generate / Edit Image via Responses API ────────────────────────────────
  server.registerTool(
    "asset_generate_image_responses",
    {
      title: "Generate or Edit Image (OpenAI Responses API)",
      description: `Generate or edit a game asset image using the OpenAI Responses API with the image_generation tool.

This is the newer API approach:
- Uses a text-capable model (gpt-4.1 etc.) + image_generation tool
- action "generate": force new image creation
- action "edit": edit/modify input images (inputImagePaths required)
- action "auto": model decides based on context (default)

Advantages over asset_generate_image_openai:
- Multi-turn editing: iteratively refine images
- Better prompt understanding via text reasoning model
- Supports combining/editing multiple reference images

Args:
  - prompt (string): Image description or edit instruction
  - action (string, optional): "generate" | "edit" | "auto" (default: "auto")
  - input_image_paths (string[], optional): Reference/base image paths for edit action
  - text_model (string, optional): Text reasoning model (default: "gpt-4.1")
  - size (string, optional): Output size (default: "1024x1024")
  - quality (string, optional): "low" | "medium" | "high" | "auto" (default: "high")
  - background (string, optional): "transparent" | "opaque" | "auto" (default: "transparent")
  - asset_type (string, optional): Asset type for file organization (default: "sprite")
  - output_dir (string, optional): Output directory

Returns:
  File path of the generated/edited image`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(8000).describe("Image description or edit instruction"),
        action: z.enum(["auto", "generate", "edit"]).default("auto")
          .describe("generate: force new | edit: modify input images | auto: model decides"),
        input_image_paths: z.array(z.string()).optional()
          .describe("Input image file paths (required for edit action)"),
        text_model: z.enum(["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"]).default("gpt-4.1")
          .describe("Text reasoning model for the Responses API"),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024")
          .describe("Output image size"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("high")
          .describe("Generation quality"),
        background: z.enum(["transparent", "opaque", "auto"]).default("transparent")
          .describe("Background type"),
        asset_type: z.enum(ASSET_TYPES).default("sprite").describe("Asset type for file naming"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

        const latency = startLatencyTracker();
        const result = await generateImageWithResponses({
          prompt: params.prompt,
          textModel: params.text_model,
          action: params.action,
          inputImagePaths: params.input_image_paths,
          size: params.size,
          quality: params.quality,
          background: params.background,
        });

        const fileName = generateFileName(`${params.asset_type}_responses`, "png");
        const filePath = buildAssetPath(outputDir, "images", fileName);
        saveBase64File(result.base64, filePath);

        if (!NO_PADDING_TYPES.includes(params.asset_type)) {
          await addPadding(filePath, filePath, 5);
        }

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: params.asset_type,
          provider: `openai-responses/${params.text_model}`,
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            revised_prompt: result.revisedPrompt,
            action: params.action,
            size: params.size,
            quality: params.quality,
            input_images: params.input_image_paths,
            ...buildCostTelemetry(params.text_model, params.quality, params.size, latency.elapsed()),
          },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            file_path: filePath,
            asset_id: asset.id,
            action: params.action,
            revised_prompt: result.revisedPrompt,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Responses Image") }],
          isError: true,
        };
      }
    }
  );

  // ── Compare Image Generation Models ────────────────────────────────────────
  server.registerTool(
    "asset_compare_models",
    {
      title: "Compare Image Generation Models",
      description: `동일한 프롬프트로 여러 OpenAI 이미지 모델을 병렬 실행해 결과를 비교합니다.

**비교 가능 모델:**
- gpt-image-2   — 2026-04-21 최신, 4K/다국어 텍스트, 투명 배경 미지원 (수동 선택)
- gpt-image-1.5 — 4× 빠름, 20% 저렴 (기본 포함)
- gpt-image-1   — 표준 품질/가격 (기본 포함)
- gpt-image-1-mini — 가장 저렴 (기본 포함)

**반환값:** 각 모델의 생성 시간(ms), 파일 크기(KB), 저장 경로, 성공/실패 여부.
같은 배치의 결과는 동일한 batch_id를 공유하므로 파일 탐색기에서 나란히 확인 가능.

**비용 절감 팁:** quality를 "low" 또는 "medium"으로 설정하면 모델 간 스타일 차이만 빠르게 확인 가능.

Args:
  - prompt (string): 비교할 이미지 프롬프트
  - models (string[], optional): 테스트할 OpenAI 모델 목록 (기본: 3개 전체)
  - size (string, optional): 이미지 크기 (기본: "1024x1024")
  - quality (string, optional): 생성 품질 — 비교 테스트는 "medium" 권장 (기본: "medium")
  - background (string, optional): 배경 타입 (기본: "transparent")
  - asset_type (string, optional): 에셋 타입 (파일 분류용, 기본: "sprite")
  - output_dir (string, optional): 출력 디렉토리

Returns:
  각 모델의 결과(파일 경로, 생성 시간, 파일 크기) + 정렬된 요약`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000)
          .describe("비교할 이미지 프롬프트"),
        models: z.array(z.enum(OPENAI_IMAGE_MODELS))
          .default(["gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"])
          .describe("테스트할 OpenAI 모델 목록"),
        size: z.enum(["1024x1024", "1536x1024", "1024x1536"]).default("1024x1024")
          .describe("출력 이미지 크기"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("medium")
          .describe("생성 품질 (비교 테스트는 medium 권장)"),
        background: z.enum(["transparent", "opaque", "auto"]).default("transparent")
          .describe("배경 타입"),
        asset_type: z.enum(ASSET_TYPES).default("sprite")
          .describe("에셋 타입 (파일 분류용)"),
        output_dir: z.string().optional()
          .describe("출력 디렉토리"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const batchId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

        type TaskDef = {
          label: string;
          fn: () => Promise<{ base64: string; mimeType: string }>;
        };

        const tasks: TaskDef[] = [];

        for (const model of params.models) {
          tasks.push({
            label: model,
            fn: () => generateImageOpenAI({
              prompt: params.prompt,
              model,
              size: params.size as "1024x1024" | "1536x1024" | "1024x1536",
              quality: params.quality as "low" | "medium" | "high" | "auto",
              background: params.background as "transparent" | "opaque" | "auto",
            }).then(r => ({ base64: r.base64, mimeType: r.mimeType })),
          });
        }

        type ModelResult = {
          model: string;
          success: boolean;
          file_path?: string;
          file_name?: string;
          generation_ms?: number;
          file_size_kb?: number;
          error?: string;
        };

        const settled = await Promise.allSettled(
          tasks.map(async (task): Promise<ModelResult> => {
            const start = Date.now();
            const r = await task.fn();
            const ms = Date.now() - start;

            const safeLabel = task.label.replace(/[^a-z0-9.-]/gi, "_");
            const fileName = `compare_${params.asset_type}_${safeLabel}_${batchId}.png`;
            const filePath = buildAssetPath(outputDir, "compare", fileName);
            saveBase64File(r.base64, filePath);

            if (!NO_PADDING_TYPES.includes(params.asset_type)) {
              await addPadding(filePath, filePath, 5);
            }

            const stats = fs.statSync(filePath);
            return {
              model: task.label,
              success: true,
              file_path: filePath,
              file_name: fileName,
              generation_ms: ms,
              file_size_kb: Math.round(stats.size / 1024),
            };
          })
        );

        const results: ModelResult[] = settled.map((s, i) => {
          if (s.status === "fulfilled") return s.value;
          return {
            model: tasks[i].label,
            success: false,
            error: s.reason instanceof Error ? s.reason.message : String(s.reason),
          };
        });

        const succeeded = results.filter(r => r.success).length;
        const sortedBySpeed = [...results]
          .filter(r => r.success)
          .sort((a, b) => (a.generation_ms ?? 0) - (b.generation_ms ?? 0));

        const output = {
          success: true,
          batch_id: batchId,
          prompt: params.prompt,
          total: tasks.length,
          succeeded,
          failed: tasks.length - succeeded,
          results,
          speed_ranking: sortedBySpeed.map((r, i) =>
            `#${i + 1} ${r.model}: ${r.generation_ms}ms  ${r.file_size_kb}KB  →  ${r.file_path}`
          ),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Compare Models") }],
          isError: true,
        };
      }
    }
  );
}
