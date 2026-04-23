import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, ASSET_TYPES, NO_PADDING_TYPES } from "../constants.js";
import { generateImageOpenAI, generateImageWithResponses } from "../services/openai.js";
import { generateImageGemini } from "../services/gemini.js";
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

/**
 * asset_type에 따라 기본 AI 프로바이더를 반환합니다.
 *
 * v2.0부터 **모든 타입에서 OpenAI(gpt-image-* 계열)**이 기본값입니다.
 * 배경도 gpt-image-2가 디테일/텍스트 품질이 더 우수합니다.
 * 투명 레이어가 필수인 parallax mid/near 같은 특수 케이스는
 * 도구별로 별도 처리하며, 필요 시 호출자가 provider: "gemini"를 명시합니다.
 */
function getDefaultProvider(_assetType: string): "openai" | "gemini" {
  return "openai";
}

/**
 * Gemini Imagen 전용 프롬프트 변환.
 *
 * GPT용 프롬프트에는 픽셀 크기 수치("48x48px")나 "icon style", "game inventory icon" 같은
 * 표현이 포함되어 있는데, Gemini는 이를 이미지 안에 텍스트/레이블로 렌더링하거나
 * 여러 오브젝트를 한 화면에 모아 그리는 컬렉션 시트를 생성하는 경향이 있음.
 *
 * 변환 규칙:
 * 1. 픽셀 크기 수치 제거 (48x48px, 32x32px 등)
 * 2. "icon style", "game inventory icon", "weapon icon" 등 아이콘 지시어 제거
 * 3. "clean icon style", "slightly top-down angle" 등 GPT 전용 힌트 제거
 * 4. 단일 오브젝트 강제 지시문 추가
 */
function adaptPromptForGemini(prompt: string): string {
  let p = prompt;

  // 1. 픽셀 크기 수치 제거 (e.g. "48x48px", "32x32 px", "1024x1024")
  p = p.replace(/\b\d+\s*x\s*\d+\s*px\b/gi, "");
  p = p.replace(/\b\d+\s*x\s*\d+\b/g, "");

  // 2. GPT 전용 아이콘/스타일 지시어 제거
  const removePatterns = [
    /\bgame inventory icon\b,?\s*/gi,
    /\bweapon icon\b,?\s*/gi,
    /\bclean icon style\b,?\s*/gi,
    /\bicon style\b,?\s*/gi,
    /\bslightly top-down angle\b,?\s*/gi,
    /\bvibrant colors\b,?\s*/gi,
    /\bsimple readable design\b,?\s*/gi,
  ];
  for (const pattern of removePatterns) {
    p = p.replace(pattern, "");
  }

  // 3. 연속 쉼표/공백 정리
  p = p.replace(/,\s*,/g, ",").replace(/^\s*,\s*/, "").trim();

  // 4. 단일 오브젝트 강제 지시문 추가
  p += ", single isolated object, centered, no text, no labels, no other items, one object only";

  return p;
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

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 created_assets/prompts/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로를 읽고 추가 질문 없이 바로 생성을 진행하세요.

Saves the generated image to the assets directory and returns the file path along with the inline image data.

Args:
  - prompt (string): Description of the image to generate
  - asset_type (string): Type of game asset (character, sprite, background, ui_element, icon, tile, effect, logo, other)
  - size (string, optional): Image size - "1024x1024" (default), "1792x1024" (landscape), "1024x1792" (portrait)
  - quality (string, optional): "auto" (default) | "low" | "medium" | "high"
  - use_concept (boolean, optional): Whether to inject the current game concept into the prompt (default: true)
  - concept_file (string, optional): Path to game concept file (default: ./game-concept.json)
  - output_dir (string, optional): Output directory for the asset (default: ./generated-assets)

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

  // ── Generate Image (Gemini Imagen 4) ───────────────────────────────────────
  server.registerTool(
    "asset_generate_image_gemini",
    {
      title: "Generate Game Asset Image (Gemini Imagen 4)",
      description: `Generate a game asset image using Google Gemini Imagen 4.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 created_assets/prompts/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로를 읽고 추가 질문 없이 바로 생성을 진행하세요.

Saves the generated image to the assets directory and returns the file path along with the inline image data.

Args:
  - prompt (string): Description of the image to generate
  - asset_type (string): Type of game asset (character, sprite, background, ui_element, icon, tile, effect, logo, other)
  - aspect_ratio (string, optional): "1:1" (default), "3:4", "4:3", "9:16", "16:9"
  - negative_prompt (string, optional): What to avoid in the image
  - use_concept (boolean, optional): Whether to inject the current game concept into the prompt (default: true)
  - concept_file (string, optional): Path to game concept file (default: ./game-concept.json)
  - output_dir (string, optional): Output directory for the asset (default: ./generated-assets)

Returns:
  File path of the saved image and asset metadata.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Description of the image to generate"),
        asset_type: z.enum(ASSET_TYPES).default("sprite").describe("Type of game asset"),
        model: z.enum(["imagen-4.0-generate-001", "imagen-4.0-fast-generate-001", "imagen-4.0-ultra-generate-001"]).default("imagen-4.0-generate-001").describe("Gemini Imagen model: generate-001 (balanced) | fast-generate-001 (faster) | ultra-generate-001 (highest quality)"),
        aspect_ratio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).default("1:1").describe("Image aspect ratio (all Imagen 4 models support 1:1 / 3:4 / 4:3 / 9:16 / 16:9)"),
        negative_prompt: z.string().max(1000).optional().describe("What to avoid in the image"),
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
        const enrichedPrompt = buildEnrichedPrompt(params.prompt, params.asset_type, conceptHint);

        const latency = startLatencyTracker();
        const result = await generateImageGemini({
          prompt: enrichedPrompt,
          model: params.model,
          aspectRatio: params.aspect_ratio,
          negativePrompt: params.negative_prompt,
        });

        const ext = result.mimeType.includes("jpeg") ? "jpg" : "png";
        const fileName = generateFileName(`${params.asset_type}_gemini`, ext);
        const filePath = buildAssetPath(outputDir, "images", fileName);
        saveBase64File(result.base64, filePath);

        // 캐릭터/스프라이트/무기 등 투명 배경 에셋은 여백 추가로 잘림 방지
        if (!NO_PADDING_TYPES.includes(params.asset_type)) {
          await addPadding(filePath, filePath, 5);
        }

        const providerTag = `gemini-${result.model}`;

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: params.asset_type,
          provider: providerTag,
          prompt: params.prompt,
          file_path: filePath,
          file_name: fileName,
          mime_type: result.mimeType,
          created_at: new Date().toISOString(),
          metadata: {
            aspect_ratio: params.aspect_ratio,
            negative_prompt: params.negative_prompt,
            model: result.model,
            ...buildCostTelemetry(result.model, "high", undefined, latency.elapsed()),
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
                provider: providerTag,
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Gemini Imagen") }],
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

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 created_assets/prompts/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로(created_assets/prompts/ 하위 JSON)를 읽고
추가 질문 없이 바로 생성을 진행하세요. 한 번 호출에 최대 10개까지 생성 가능합니다.

Useful for generating a complete set of initial assets for a game (characters, backgrounds, UI elements, etc.).

**기본 프로바이더 규칙 (v2.0+):**
- 모든 에셋 타입 기본 OpenAI (gpt-image-1-mini 저비용 / 필요 시 gpt-image-2 고품질).
- 배경도 gpt-image-2의 디테일/텍스트 렌더링이 우수합니다.
- 투명 레이어가 필수인 parallax mid/near 같은 특수 케이스만 provider: "gemini"를 명시하세요.

Args:
  - specs (array): List of image specs, each with: prompt, asset_type, provider ("openai" | "gemini", optional — auto-selected by asset_type if omitted), model (optional)
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
          provider: z.enum(["openai", "gemini"]).optional().describe("AI provider (auto-selected if omitted: 모든 타입 기본 openai. parallax 투명 레이어 같은 특수 케이스만 'gemini' 명시)"),
          model: z.enum(OPENAI_IMAGE_MODELS).default("gpt-image-1-mini").describe("OpenAI image model: gpt-image-1-mini (default) | gpt-image-1 | gpt-image-1.5 (고디테일) | gpt-image-2 (4K·다국어 텍스트, 투명 배경 미지원)"),
          size: z.enum(["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536", "auto"]).optional().describe("Size (OpenAI only)"),
          quality: z.enum(["low", "medium", "high", "auto"]).optional().describe("Quality (default: medium)"),
          aspect_ratio: z.enum(["1:1", "3:4", "4:3", "9:16", "16:9"]).optional().describe("Aspect ratio (Gemini only)"),
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
        // provider 미지정 시 asset_type 기반 자동 선택
        const provider = spec.provider ?? getDefaultProvider(spec.asset_type);
        // 1) CONCEPT.md BASE STYLE를 앞에 주입, 2) game-concept.json 힌트는 뒤에 추가
        const styledPrompt = buildStyledPrompt(spec.prompt, baseStyle);
        // 3) Gemini는 GPT 전용 아이콘 지시어/픽셀 크기를 시각적으로 렌더링하므로 자동 변환
        const finalPrompt = provider === "gemini"
          ? adaptPromptForGemini(styledPrompt)
          : buildEnrichedPrompt(styledPrompt, spec.asset_type, conceptHint);
        const model = spec.model ?? "gpt-image-1-mini";

        try {
          let base64: string;
          let mimeType: string;
          let usedModel: string = model;

          const latency = startLatencyTracker();
          if (provider === "gemini") {
            const r = await generateImageGemini({
              prompt: finalPrompt,
              aspectRatio: spec.aspect_ratio,
            });
            base64 = r.base64;
            mimeType = r.mimeType;
            usedModel = r.model;
          } else {
            const r = await generateImageOpenAI({
              prompt: finalPrompt,
              model: spec.model,
              size: spec.size,
              quality: spec.quality ?? "medium",
              background: "transparent",
            });
            base64 = r.base64;
            mimeType = r.mimeType;
          }
          const latencyMs = latency.elapsed();

          const ext = mimeType.includes("jpeg") ? "jpg" : "png";
          const fileName = generateFileName(`${spec.asset_type}_${provider}`, ext);
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
            provider,
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
            provider,
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
            provider,
            model,
            success: false,
            error: handleApiError(error, provider),
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
- 투명 레이어가 필수인 parallax mid/near 같은 특수 케이스만 provider: "gemini"를 명시하세요.

provider 파라미터로 명시적으로 지정하면 기본값을 덮어씁니다.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 created_assets/prompts/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마를 읽고 추가 질문 없이 바로 생성을 진행하세요.

Args:
  - prompt (string): Description of the image to generate
  - asset_type (string): Type of game asset — determines default provider
  - provider (string, optional): Override provider: "openai" | "gemini"
  - output_dir (string, optional): Output directory (default: ./generated-assets)
  - use_concept (boolean, optional): Inject game-concept.json style hint (default: true)

Returns:
  File path of the saved image and asset metadata.`,
      inputSchema: z.object({
        prompt: z.string().min(1).max(4000).describe("Description of the image to generate"),
        asset_type: z.enum(ASSET_TYPES).default("sprite").describe("Type of game asset (determines default provider)"),
        provider: z.enum(["openai", "gemini"]).optional().describe("Override provider (auto-selected by asset_type if omitted)"),
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
        const provider = params.provider ?? getDefaultProvider(params.asset_type);
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const conceptFile = params.concept_file || DEFAULT_CONCEPT_FILE;
        const conceptHint = params.use_concept ? loadConceptForPrompt(conceptFile) : "";

        let base64: string;
        let mimeType: string;
        let usedModel = "gpt-image-1-mini";

        const latency = startLatencyTracker();
        if (provider === "gemini") {
          const adaptedPrompt = adaptPromptForGemini(params.prompt);
          const aspectRatio = params.asset_type === "background" ? "9:16" : "1:1";
          const r = await generateImageGemini({ prompt: adaptedPrompt, aspectRatio });
          base64 = r.base64;
          mimeType = r.mimeType;
          usedModel = r.model;
        } else {
          const enrichedPrompt = buildEnrichedPrompt(params.prompt, params.asset_type, conceptHint);
          const r = await generateImageOpenAI({
            prompt: enrichedPrompt,
            quality: "medium",
            background: "transparent",
          });
          base64 = r.base64;
          mimeType = r.mimeType;
        }
        const latencyMs = latency.elapsed();

        const ext = mimeType.includes("jpeg") ? "jpg" : "png";
        const fileName = generateFileName(`${params.asset_type}_${provider}`, ext);
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
          provider,
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
                provider,
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
      description: `동일한 프롬프트로 여러 OpenAI 이미지 모델(및 선택적으로 Gemini)을 병렬 실행해 결과를 비교합니다.

**비교 가능 모델:**
- gpt-image-2   — 2026-04-21 최신, 4K/다국어 텍스트, 투명 배경 미지원 (수동 선택)
- gpt-image-1.5 — 4× 빠름, 20% 저렴 (기본 포함)
- gpt-image-1   — 표준 품질/가격 (기본 포함)
- gpt-image-1-mini — 가장 저렴 (기본 포함)
- Gemini Imagen — include_gemini: true 시 추가

**반환값:** 각 모델의 생성 시간(ms), 파일 크기(KB), 저장 경로, 성공/실패 여부.
같은 배치의 결과는 동일한 batch_id를 공유하므로 파일 탐색기에서 나란히 확인 가능.

**비용 절감 팁:** quality를 "low" 또는 "medium"으로 설정하면 모델 간 스타일 차이만 빠르게 확인 가능.

Args:
  - prompt (string): 비교할 이미지 프롬프트
  - models (string[], optional): 테스트할 OpenAI 모델 목록 (기본: 3개 전체)
  - include_gemini (boolean, optional): Gemini Imagen도 포함 (기본: false)
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
        include_gemini: z.boolean().default(false)
          .describe("Gemini Imagen도 비교에 포함"),
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

        if (params.include_gemini) {
          const aspectRatio = params.size === "1536x1024" ? "16:9"
            : params.size === "1024x1536" ? "9:16"
            : "1:1";
          tasks.push({
            label: "gemini-imagen",
            fn: () => generateImageGemini({ prompt: params.prompt, aspectRatio }),
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
