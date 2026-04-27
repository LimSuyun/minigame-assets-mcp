/**
 * thumbnail.ts — 게임 썸네일 생성 (1932×828px)
 *
 * 도구:
 *  - asset_plan_thumbnail    : 썸네일 컨텐츠 & 프롬프트 계획 (이미지 생성 없음)
 *  - asset_generate_thumbnail: 썸네일 AI 신규 생성 (레퍼런스 이미지로 새 이미지 생성)
 *
 * 텍스트 처리: 종전 SVG 사후 오버레이 방식을 폐기하고,
 *   타이틀 워드마크 PNG(투명 배경)를 마지막 레퍼런스로 함께 edit API에 투입해
 *   AI가 한 장의 통합 합성으로 그리도록 한다 (로고 도구와 동일 패턴).
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { generateImageOpenAI, editImageOpenAI } from "../services/openai.js";
import { refineImagePrompt } from "../services/gpt5-prompt.js";
import { writeOptimized } from "../utils/image-output.js";
import {
  ensureDir,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { startLatencyTracker, buildCostTelemetry, buildEditCostTelemetry } from "../utils/cost-tracking.js";
import { ensureTitleTextImage, TITLE_TEXT_SUBDIR } from "../utils/title-text.js";
import { makeAssetSlug } from "../utils/slug.js";

const THUMB_W = 1932;
const THUMB_H = 828;
const THUMB_SUBDIR = "thumbnails";

// ─── 프롬프트 빌더 ───────────────────────────────────────────────────────────

const LAYOUT_DESC: Record<string, string> = {
  title_left:        "game title and logo area on the LEFT third, characters and action on the RIGHT two-thirds",
  title_right:       "characters and action on the LEFT two-thirds, game title area on the RIGHT third",
  title_center:      "characters flanking both sides, game title and tagline prominently in the CENTER",
  characters_spread: "all characters spread dynamically across the full width, epic action scene with no dedicated text area",
};

const LAYOUT_WORDMARK_PLACEMENT: Record<string, string> = {
  title_left:   "Place the wordmark vertically centered inside the LEFT third of the canvas (anchored ~4–8% from the left edge).",
  title_right:  "Place the wordmark vertically centered inside the RIGHT third of the canvas (anchored ~4–8% from the right edge).",
  title_center: "Place the wordmark horizontally centered, vertically in the upper-middle of the canvas, occupying roughly the central 40% of the width.",
};

type Layout = "title_left" | "title_right" | "title_center" | "characters_spread";

function buildThumbnailScenePrompt(p: {
  game_name: string;
  genre: string;
  art_style: string;
  theme: string;
  layout: Layout;
  color_scheme: "light" | "dark";
  characters: Array<{ role: string; description: string }>;
  background_hint?: string;
  custom_prompt?: string;
}): string {
  const charList = p.characters.length > 0
    ? p.characters.map((c) => `${c.role}: ${c.description}`).join("; ")
    : "the game's main characters";

  const bgMood = p.color_scheme === "dark"
    ? "dramatic dark atmosphere, dynamic lighting, vibrant neon accents"
    : "bright vivid scene, energetic lighting, saturated colors";

  const bgHint = p.background_hint || `${p.theme} environment game scene`;

  return [
    `Create a brand new, high-quality game promotional banner/thumbnail for "${p.game_name}", a ${p.genre} game.`,
    `Art style: ${p.art_style}. Theme: ${p.theme}.`,
    ``,
    `LAYOUT (strictly follow): ${LAYOUT_DESC[p.layout] || LAYOUT_DESC.title_left}.`,
    ``,
    `CHARACTERS to feature: ${charList}.`,
    `Draw the characters in dynamic, expressive poses that convey the game's energy and genre.`,
    ``,
    `BACKGROUND: ${bgHint}. ${bgMood}.`,
    ``,
    `VISUAL REQUIREMENTS:`,
    `- Wide cinematic banner composition (2.33:1 aspect ratio)`,
    `- Bold, instantly readable design with strong focal points`,
    `- High contrast between subjects and background`,
    `- Game-promotional quality — must look exciting and polished`,
    p.custom_prompt ? `Additional: ${p.custom_prompt}` : "",
  ].filter(Boolean).join("\n").trim();
}

function buildThumbnailCompositePrompt(p: {
  scene: string;
  layout: Exclude<Layout, "characters_spread">;
  brand_color?: string;
  ref_count_visual: number; // 캐릭터 + 배경 합산 (텍스트 이미지 제외)
  has_visual_refs: boolean;
}): string {
  const placement = LAYOUT_WORDMARK_PLACEMENT[p.layout];
  const visualClause = p.has_visual_refs
    ? `The FIRST ${p.ref_count_visual} reference image${p.ref_count_visual > 1 ? "s are" : " is"} the visual subject(s) (background and/or character art) — use them to inform composition, character likeness, palette, and style.`
    : `No visual reference images are provided besides the wordmark; render the scene purely from the description below.`;
  const brandLine = p.brand_color
    ? ` The wordmark's brand color is ${p.brand_color}; preserve it.`
    : "";
  return [
    `Compose ONE unified game promotional banner that integrates the references into a single piece of art.`,
    visualClause,
    `The LAST reference image is the FINISHED game-title wordmark (transparent background).`,
    `${placement} PRESERVE the wordmark EXACTLY — keep its letter shapes, spelling, color, and outline identical to the reference. Do NOT redraw, restyle, translate, or re-letter the text.${brandLine}`,
    `Integrate the wordmark and the scene so they read as one cohesive banner — the wordmark must remain fully readable and unobscured, while the scene fills the remaining canvas space without competing focal text.`,
    `Add a subtle darkening / gradient under the wordmark area only if needed for contrast; do NOT add boxes, plates, or frames.`,
    ``,
    `SCENE DESCRIPTION:`,
    p.scene,
  ].join("\n");
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerThumbnailTools(server: McpServer): void {

  // ── 1. 계획 수립 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_plan_thumbnail",
    {
      title: "Plan Thumbnail Composition",
      description: `썸네일에 담을 구성을 계획하고 AI 생성 프롬프트(장면 묘사)를 작성합니다. (이미지 생성 없음)

결과로 반환된 \`ai_prompt\`(장면 묘사)를 검토·수정한 후 asset_generate_thumbnail의 \`ai_prompt\`로 그대로 전달할 수 있습니다.
워드마크(타이틀 텍스트) 합성 지시는 \`asset_generate_thumbnail\`이 내부적으로 추가하므로 여기서는 신경 쓸 필요가 없습니다.

**레이아웃**:
- \`title_left\`       : 왼쪽 제목 영역 / 오른쪽 캐릭터+액션
- \`title_right\`      : 왼쪽 캐릭터+액션 / 오른쪽 제목 영역
- \`title_center\`     : 양쪽 캐릭터 / 중앙 제목
- \`characters_spread\`: 전체 액션 씬 (텍스트 없음 — 워드마크 미합성)

Args:
  - game_name, genre, art_style, theme
  - tagline: 태그라인 (선택, plan 메타에만 기록되며 워드마크 이미지에는 미반영)
  - layout: 레이아웃 타입
  - color_scheme: light / dark
  - characters: [{role, description}] 등장 캐릭터 (최대 3개 권장)
  - background_hint: 배경 장면 힌트 (선택)
  - custom_prompt: 추가 지시사항 (선택)

Returns:
  ai_prompt (장면 묘사), composition_notes.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100),
        genre: z.string().min(1).max(200),
        art_style: z.string().min(1).max(200),
        theme: z.string().min(1).max(200),
        tagline: z.string().max(100).optional(),
        layout: z.enum(["title_left", "title_right", "title_center", "characters_spread"]).default("title_left"),
        color_scheme: z.enum(["light", "dark"]).default("dark"),
        characters: z.array(z.object({
          role: z.string(),
          description: z.string(),
        })).default([]),
        background_hint: z.string().max(300).optional(),
        custom_prompt: z.string().max(500).optional(),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const aiPrompt = buildThumbnailScenePrompt({
        game_name: params.game_name,
        genre: params.genre,
        art_style: params.art_style,
        theme: params.theme,
        layout: params.layout,
        color_scheme: params.color_scheme,
        characters: params.characters,
        background_hint: params.background_hint,
        custom_prompt: params.custom_prompt,
      });

      const wordmarkIncluded = params.layout !== "characters_spread";
      const output = {
        plan: {
          title: params.game_name,
          tagline: params.tagline || "",
          layout: params.layout,
          layout_description: LAYOUT_DESC[params.layout],
          color_scheme: params.color_scheme,
          characters_to_feature: params.characters,
          background_hint: params.background_hint || `${params.theme} environment`,
          wordmark_included: wordmarkIncluded,
        },
        ai_prompt: aiPrompt,
        composition_notes: [
          `Size: ${THUMB_W}×${THUMB_H}px (2.33:1 aspect ratio)`,
          `Layout: ${LAYOUT_DESC[params.layout]}`,
          wordmarkIncluded
            ? `Text: AI-composited reusable title text image (PNG) supplied as the LAST reference to the edit API`
            : `Text: none (characters_spread layout)`,
          `Title: "${params.game_name}"${params.tagline ? ` / Tagline: "${params.tagline}"` : ""}`,
        ].join("\n"),
        next_step: "asset_generate_thumbnail에 ai_prompt를 그대로 전달하거나 수정 후 사용하세요. brand_color/title_text_image_path를 함께 넘기면 워드마크 색·재사용을 제어할 수 있습니다.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 2. 썸네일 생성 ────────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_thumbnail",
    {
      title: "Generate Game Thumbnail (1932×828)",
      description: `게임 썸네일을 1932×828px PNG로 **새로 생성**합니다 (기본: OpenAI gpt-image-2).

**호출 순서 권장**:
- 본 도구는 워크플로 **마지막(Stage 6 — Marketing)** 에 위치합니다.
- 호출 전에 캐릭터·배경·타이틀 텍스트 PNG가 모두 준비된 상태에서 \`character_image_paths\` / \`background_image_path\` / \`title_text_image_path\` 를 넘겨주세요.
- 입력이 비어 있어도 도구가 일부 자산을 자동 생성하지만, 사전 자산을 재사용하는 편이 일관성·비용 모두 유리합니다.

**텍스트 처리 (신규 파이프라인)**:
- 게임 제목 워드마크는 별도 PNG(투명 배경)로 만들어 \`title_text/\` 하위에 정식 자산으로 저장한 뒤,
  edit API에 **마지막 레퍼런스**로 함께 투입해 AI가 한 장의 통합 배너로 합성합니다.
- \`title_text_image_path\` 입력 시 그대로 재사용 (재생성 비용 0).
- 한 번 만든 워드마크는 로고/로딩 화면 등 다른 도구에서도 \`title_text_image_path\`로 재사용 가능.
- \`layout: "characters_spread"\`는 "텍스트 없음" 의미를 유지 — 워드마크를 합성하지 않습니다.

**생성 방식**:
1. **워드마크 텍스트 이미지 확보** (1회) — 새로 생성하거나 \`title_text_image_path\` 재사용
2. **레퍼런스 수집** — \`background_image_path\` + \`character_image_paths\`
3. **OpenAI gpt-image-2 edit API** 호출
   - characters_spread 레이아웃: 시각 레퍼런스만 사용 (텍스트 이미지 미투입)
   - 그 외: \`[배경?, 캐릭터들..., 타이틀텍스트]\` 순서 (LAST = 타이틀)
   - 시각 레퍼런스가 0개여도 layout이 텍스트 포함 레이아웃이면 텍스트 이미지 1장만으로 edit
   - characters_spread + 시각 레퍼런스 0개의 단 한 케이스만 generate API fallback
4. 1932×828 cover crop → 엔진별 인코딩(PNG/WebP)

**레이아웃**:
- \`title_left\`       : 왼쪽 제목 / 오른쪽 캐릭터
- \`title_right\`      : 왼쪽 캐릭터 / 오른쪽 제목
- \`title_center\`     : 양쪽 캐릭터 / 중앙 제목
- \`characters_spread\`: 전체 액션 씬 (텍스트 없음)

Args:
  - game_name, genre, art_style, theme
  - tagline: 태그라인 (선택, 합성에 영향 없음)
  - layout: 레이아웃 타입
  - color_scheme: light / dark
  - ai_prompt: 장면 묘사 프롬프트 (asset_plan_thumbnail 결과 활용 권장)
  - character_image_paths: 캐릭터 PNG 경로 배열 (레퍼런스용, 최대 4개)
  - background_image_path: 배경 이미지 경로 (레퍼런스용)
  - brand_color: 워드마크 색상 (hex 또는 색명, 미제공 시 자동 추론)
  - title_text_image_path: 이미 생성된 타이틀 텍스트 PNG 경로 (재사용)
  - model: OpenAI 모델 (기본: gpt-image-2)
  - quality: 생성 품질 (기본: high)
  - refine_prompt: GPT-5로 장면 묘사를 상세화 (기본: false)
  - output_dir: 출력 경로. 기본 \`.minigame-assets/thumbnails/\`. **registry/deploy-map은 항상 프로젝트 루트(\`.minigame-assets/\`) 한 곳에 통합 저장됩니다.**

Returns:
  생성된 1932×828 PNG 파일 경로 + 사용된 \`title_text_path\`.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름"),
        name_slug: z.string().min(1).max(60).optional()
          .describe("ASCII 영문 슬러그 (파일명용). 미지정 시 game_name에서 한글 보존 슬러그로 fallback"),
        genre: z.string().min(1).max(200).describe("게임 장르"),
        art_style: z.string().min(1).max(200).describe("아트 스타일"),
        theme: z.string().min(1).max(200).describe("게임 테마"),
        tagline: z.string().max(100).optional().describe("태그라인 (참고용, 합성에 영향 없음)"),
        layout: z.enum(["title_left", "title_right", "title_center", "characters_spread"])
          .default("title_left").describe("레이아웃"),
        color_scheme: z.enum(["light", "dark"]).default("dark").describe("색상 스킴"),
        ai_prompt: z.string().max(4000).optional()
          .describe("장면 묘사 프롬프트 (미제공 시 파라미터로 자동 생성, asset_plan_thumbnail 결과 권장)"),
        character_image_paths: z.array(z.string()).max(4).optional()
          .describe("캐릭터 PNG 파일 경로 배열 (최대 4개)"),
        background_image_path: z.string().optional()
          .describe("배경 이미지 파일 경로"),
        brand_color: z.string().max(80).optional()
          .describe("워드마크 색상 (hex 또는 색명). 미제공 시 theme/art_style로부터 자동 추론"),
        title_text_image_path: z.string().optional()
          .describe("이미 생성된 타이틀 텍스트 PNG 경로 (재사용)"),
        model: z.string().optional()
          .describe("OpenAI 모델 override. 기본: gpt-image-2"),
        refine_prompt: z.boolean().default(false)
          .describe("GPT-5로 장면 묘사를 상세화 (워드마크 합성 지시는 항상 그대로 유지)"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("high")
          .describe("생성 품질 (gpt-image-2 기준)"),
        output_dir: z.string().optional().describe("출력 디렉토리. 기본 `.minigame-assets/thumbnails/`. registry/deploy-map은 항상 프로젝트 루트에 통합."),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = path.resolve(params.output_dir || path.join(DEFAULT_OUTPUT_DIR, THUMB_SUBDIR));
        ensureDir(outputDir);
        const titleTextDir = path.resolve(outputDir, "..", TITLE_TEXT_SUBDIR);

        const layout = params.layout as Layout;
        const includeWordmark = layout !== "characters_spread";

        // ── Step 1: 시각 레퍼런스 검증·수집 ────────────────────────────────
        const visualRefPaths: string[] = [];
        if (params.background_image_path) {
          if (!fs.existsSync(params.background_image_path)) {
            throw new Error(`background_image_path 파일 없음: ${params.background_image_path}`);
          }
          visualRefPaths.push(params.background_image_path);
        }
        if (params.character_image_paths?.length) {
          for (const p of params.character_image_paths) {
            if (!fs.existsSync(p)) throw new Error(`character_image_paths 파일 없음: ${p}`);
            visualRefPaths.push(p);
          }
        }

        // ── Step 2: 장면 묘사 프롬프트 결정 (옵션 GPT-5 refine) ───────────
        let scenePrompt = params.ai_prompt || buildThumbnailScenePrompt({
          game_name: params.game_name,
          genre: params.genre,
          art_style: params.art_style,
          theme: params.theme,
          layout,
          color_scheme: params.color_scheme,
          characters: [],
          custom_prompt: undefined,
        });

        let refinedByGPT5 = false;
        if (params.refine_prompt) {
          try {
            scenePrompt = await refineImagePrompt({
              userDescription: scenePrompt,
              targetModel: (params.model ?? "gpt-image-2") as
                | "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
              assetType: "thumbnail",
              conceptHint: `Game: ${params.game_name} — Genre: ${params.genre} — Art style: ${params.art_style} — Theme: ${params.theme}${params.tagline ? ` — Tagline: ${params.tagline}` : ""}`,
            });
            refinedByGPT5 = true;
          } catch (refineErr) {
            console.warn(`[refine_prompt] thumbnail refinement failed, using original: ${refineErr instanceof Error ? refineErr.message : refineErr}`);
          }
        }

        // ── Step 3: 워드마크 텍스트 이미지 확보 (텍스트 포함 레이아웃만) ──
        let titleText: Awaited<ReturnType<typeof ensureTitleTextImage>> | null = null;
        if (includeWordmark) {
          titleText = await ensureTitleTextImage({
            game_name: params.game_name,
            name_slug: params.name_slug,
            brand_color: params.brand_color,
            art_style: params.art_style,
            theme: params.theme,
            custom_prompt: undefined,
            titleTextDir,
            registryDir: outputDir,
            reusePath: params.title_text_image_path,
          });
        }

        // ── Step 4: 합성 prompt 작성 ──────────────────────────────────────
        const finalPrompt = includeWordmark
          ? buildThumbnailCompositePrompt({
              scene: scenePrompt,
              layout: layout as Exclude<Layout, "characters_spread">,
              brand_color: params.brand_color,
              ref_count_visual: visualRefPaths.length,
              has_visual_refs: visualRefPaths.length > 0,
            })
          : scenePrompt;

        // ── Step 5: OpenAI 호출 ──────────────────────────────────────────
        const effectiveModel = (params.model ?? "gpt-image-2") as
          | "gpt-image-2"
          | "gpt-image-1.5"
          | "gpt-image-1"
          | "gpt-image-1-mini";

        const editRefPaths: string[] = includeWordmark
          ? [...visualRefPaths, titleText!.path]
          : [...visualRefPaths];

        let base64: string;
        let generationMethod: string;
        type CallKind = "edit" | "generate";
        let callKind: CallKind = "generate";
        let callSize: string | undefined;
        const callQuality: "low" | "medium" | "high" | "auto" = params.quality;
        const callModel: string = effectiveModel;

        const tmpPath = path.join(outputDir, `_tmp_thumb_${Date.now()}.png`);
        const latency = startLatencyTracker();

        if (editRefPaths.length > 0) {
          const r = await editImageOpenAI({
            imagePaths: editRefPaths,
            prompt: finalPrompt,
            model: effectiveModel,
            size: "1536x1024",
          });
          base64 = r.base64;
          generationMethod = `openai_${effectiveModel}_edit (${editRefPaths.length} refs${includeWordmark ? ", incl. wordmark" : ""})`;
          callKind = "edit";
          callSize = "1536x1024";
        } else {
          // characters_spread + 시각 레퍼런스 0개 — 유일한 generate fallback
          const r = await generateImageOpenAI({
            prompt: finalPrompt,
            model: effectiveModel,
            size: "1792x1024",
            quality: params.quality,
            background: "opaque",
          });
          base64 = r.base64;
          generationMethod = `openai_${effectiveModel}_1792x1024 (no refs)`;
          callSize = "1792x1024";
        }
        const latencyMs = latency.elapsed();

        // ── Step 6: 1932×828 cover crop ──────────────────────────────────
        saveBase64File(base64, tmpPath);
        const finalBuf = await sharp(tmpPath)
          .resize(THUMB_W, THUMB_H, { fit: "cover", position: "center" })
          .png()
          .toBuffer();

        // ── Step 7: 저장 (engine-aware 포맷) ──────────────────────────────
        const safeName = makeAssetSlug({ name_slug: params.name_slug, game_name: params.game_name });
        const ts = new Date().toISOString().slice(0, 10);
        const pathBase = path.join(outputDir, `${safeName}_thumb_${params.layout}_${params.color_scheme}_${ts}.png`);

        const written = await writeOptimized(finalBuf, pathBase);
        const finalPath = written.path;
        const fileName = path.basename(finalPath);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

        saveAssetToRegistry({
          id: generateAssetId(), type: "image", asset_type: "thumbnail",
          provider: generationMethod,
          prompt: finalPrompt,
          file_path: finalPath, file_name: fileName,
          mime_type: written.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            game_name: params.game_name,
            size: `${THUMB_W}x${THUMB_H}`,
            layout: params.layout,
            color_scheme: params.color_scheme,
            generation_method: generationMethod,
            visual_reference_images: visualRefPaths,
            wordmark_included: includeWordmark,
            ...(titleText ? {
              title_text_path: titleText.path,
              title_text_reused: titleText.reused,
              brand_color: params.brand_color ?? "inferred",
              ...(titleText.cost ? { pre_generation: { title_text: titleText.cost } } : {}),
            } : {}),
            refined_by_gpt5: refinedByGPT5,
            ...(refinedByGPT5 ? { refined_scene_prompt: scenePrompt } : {}),
            model: callModel,
            ...(callKind === "edit"
              ? buildEditCostTelemetry(callModel, callSize, latencyMs, editRefPaths.length)
              : buildCostTelemetry(callModel, callQuality, callSize, latencyMs)),
          },
        }, outputDir);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              size: `${THUMB_W}×${THUMB_H}px`,
              file_path: finalPath,
              layout: params.layout,
              color_scheme: params.color_scheme,
              generation_method: generationMethod,
              visual_reference_images_used: visualRefPaths.length,
              wordmark_included: includeWordmark,
              ...(titleText ? {
                title_text_path: titleText.path,
                title_text_reused: titleText.reused,
              } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: handleApiError(err, "thumbnail") }] };
      }
    }
  );
}
