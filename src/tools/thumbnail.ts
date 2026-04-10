/**
 * thumbnail.ts — 게임 썸네일 생성 (1932×828px)
 *
 * 도구:
 *  - asset_plan_thumbnail    : 썸네일 컨텐츠 & 프롬프트 계획 (이미지 생성 없음)
 *  - asset_generate_thumbnail: 썸네일 AI 신규 생성 (레퍼런스 이미지로 새 이미지 생성)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { generateImageOpenAI, editImageOpenAI } from "../services/openai.js";
import { generateImageGemini } from "../services/gemini.js";
import {
  ensureDir,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";

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

function buildThumbnailPrompt(p: {
  game_name: string;
  genre: string;
  art_style: string;
  theme: string;
  tagline?: string;
  layout: string;
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

  const lines = [
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
    `- High contrast between characters and background`,
    `- Game-promotional quality — must look exciting and polished`,
    `- DO NOT include any text, titles, or logos in the image (text will be added separately)`,
    ``,
    p.custom_prompt ? `Additional: ${p.custom_prompt}` : "",
  ].filter((l) => l !== undefined && !(l === "" && false)).join("\n").trim();

  return lines;
}

// ─── SVG 텍스트 오버레이 ──────────────────────────────────────────────────────

function buildThumbnailSvg(opts: {
  title: string;
  tagline?: string;
  layout: string;
  color_scheme: "light" | "dark";
}): string {
  const { title, tagline, layout, color_scheme } = opts;
  const W = THUMB_W;
  const H = THUMB_H;

  if (layout === "characters_spread") {
    // 텍스트 없음 — 빈 SVG
    return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg"/>`;
  }

  const isDark = color_scheme === "dark";
  const textFill   = isDark ? "#FFD700" : "#FFFFFF";
  const textStroke = isDark ? "#1a0800" : "#003080";
  const tagFill    = isDark ? "#FFE88A" : "#D0EEFF";

  const titleSize  = Math.round(H * 0.21);
  const tagSize    = Math.round(H * 0.09);

  let textX: number;
  let anchor: string;
  // 그라디언트: 텍스트 영역 쪽을 어둡게 해서 가독성 확보
  let gx1: string, gx2: string;

  if (layout === "title_left") {
    textX = W * 0.04; anchor = "start";
    gx1 = "0%"; gx2 = "48%";
  } else if (layout === "title_right") {
    textX = W * 0.96; anchor = "end";
    gx1 = "52%"; gx2 = "100%";
  } else {
    // title_center
    textX = W * 0.5; anchor = "middle";
    gx1 = "15%"; gx2 = "85%";
  }

  const gradStop = isDark ? "rgba(0,0,15,0.82)" : "rgba(0,20,70,0.72)";
  const gradFade = isDark ? "rgba(0,0,15,0)"    : "rgba(0,20,70,0)";

  const titleY   = H * 0.44;
  const taglineY = H * 0.66;

  const taglineSvg = tagline
    ? `<text x="${textX}" y="${taglineY}"
        font-family="Apple SD Gothic Neo,Noto Sans KR,Malgun Gothic,sans-serif"
        font-size="${tagSize}" font-weight="500"
        text-anchor="${anchor}" dominant-baseline="middle"
        fill="${tagFill}" stroke="${textStroke}"
        stroke-width="${Math.round(tagSize * 0.08)}" paint-order="stroke fill"
      >${tagline}</text>`
    : "";

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tg" x1="${gx1}" y1="0%" x2="${gx2}" y2="0%">
      <stop offset="0%" stop-color="${gradStop}"/>
      <stop offset="100%" stop-color="${gradFade}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${W}" height="${H}" fill="url(#tg)"/>
  <text x="${textX}" y="${titleY}"
    font-family="Apple SD Gothic Neo,Noto Sans KR,Malgun Gothic,sans-serif"
    font-size="${titleSize}" font-weight="bold"
    text-anchor="${anchor}" dominant-baseline="middle"
    fill="${textFill}" stroke="${textStroke}"
    stroke-width="${Math.round(titleSize * 0.09)}" paint-order="stroke fill"
  >${title}</text>
  ${taglineSvg}
</svg>`;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerThumbnailTools(server: McpServer): void {

  // ── 1. 계획 수립 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_plan_thumbnail",
    {
      title: "Plan Thumbnail Composition",
      description: `썸네일에 담을 구성을 계획하고 AI 생성 프롬프트를 작성합니다. (이미지 생성 없음)

결과로 반환된 \`ai_prompt\`를 검토·수정한 후 asset_generate_thumbnail에 그대로 전달할 수 있습니다.

**레이아웃**:
- \`title_left\`       : 왼쪽 제목 영역 / 오른쪽 캐릭터+액션
- \`title_right\`      : 왼쪽 캐릭터+액션 / 오른쪽 제목 영역
- \`title_center\`     : 양쪽 캐릭터 / 중앙 제목
- \`characters_spread\`: 전체 액션 씬 (텍스트 없음)

Args:
  - game_name, genre, art_style, theme
  - tagline: 짧은 태그라인 (선택)
  - layout: 레이아웃 타입
  - color_scheme: light / dark
  - characters: [{role, description}] 등장 캐릭터 (최대 3개 권장)
  - background_hint: 배경 장면 힌트 (선택)
  - custom_prompt: 추가 지시사항 (선택)

Returns:
  ai_prompt (생성용), composition_notes.`,
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
      const aiPrompt = buildThumbnailPrompt({
        game_name: params.game_name,
        genre: params.genre,
        art_style: params.art_style,
        theme: params.theme,
        tagline: params.tagline,
        layout: params.layout,
        color_scheme: params.color_scheme,
        characters: params.characters,
        background_hint: params.background_hint,
        custom_prompt: params.custom_prompt,
      });

      const output = {
        plan: {
          title: params.game_name,
          tagline: params.tagline || "",
          layout: params.layout,
          layout_description: LAYOUT_DESC[params.layout],
          color_scheme: params.color_scheme,
          characters_to_feature: params.characters,
          background_hint: params.background_hint || `${params.theme} environment`,
        },
        ai_prompt: aiPrompt,
        composition_notes: [
          `Size: ${THUMB_W}×${THUMB_H}px (2.33:1 aspect ratio)`,
          `Layout: ${LAYOUT_DESC[params.layout]}`,
          `Text overlay: SVG (programmatic, added after generation)`,
          `Title: "${params.game_name}"${params.tagline ? ` / Tagline: "${params.tagline}"` : ""}`,
        ].join("\n"),
        next_step: "asset_generate_thumbnail에 ai_prompt를 그대로 전달하거나 수정 후 사용하세요.",
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
      description: `게임 썸네일을 1932×828px PNG로 **새로 생성**합니다.

레퍼런스 이미지(캐릭터, 배경)를 제공하면 AI가 해당 스타일과 캐릭터를 참고해
**완전히 새로운 썸네일 이미지를 생성**합니다. (단순 합성이 아님)

**생성 방식**:
1. **레퍼런스 이미지 제공 시** (character_image_paths / background_image_path):
   - OpenAI gpt-image-1 Image Edit API에 레퍼런스로 전달
   - AI가 해당 캐릭터/스타일/분위기를 이해하고 새 씬을 창작
   - → 1536×1024 생성 후 1932×828 크롭

2. **레퍼런스 없음 — 텍스트 프롬프트만**:
   - openai: gpt-image-1로 1792×1024 생성 → 1932×828 크롭
   - gemini: Imagen 4 16:9 생성 → 1932×828 크롭

3. **공통**: 게임 제목+태그라인을 SVG로 합성 (한글 정확 렌더링)

**레이아웃**:
- \`title_left\`       : 왼쪽 제목 / 오른쪽 캐릭터
- \`title_right\`      : 왼쪽 캐릭터 / 오른쪽 제목
- \`title_center\`     : 양쪽 캐릭터 / 중앙 제목
- \`characters_spread\`: 전체 액션 씬

Args:
  - game_name, genre, art_style, theme
  - tagline: 태그라인 (선택)
  - layout: 레이아웃 타입
  - color_scheme: light / dark
  - ai_prompt: 생성 프롬프트 (asset_plan_thumbnail 결과 활용 권장)
  - character_image_paths: 캐릭터 PNG 경로 배열 (레퍼런스용, 최대 4개)
  - background_image_path: 배경 이미지 경로 (레퍼런스용)
  - add_text: 제목+태그라인 SVG 텍스트 합성 여부 (기본: true)
  - provider: 레퍼런스 없을 때 사용할 AI (openai / gemini, 기본: openai)
  - quality: 생성 품질 (기본: high)
  - output_dir: 출력 경로

Returns:
  생성된 1932×828 PNG 파일 경로.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름"),
        genre: z.string().min(1).max(200).describe("게임 장르"),
        art_style: z.string().min(1).max(200).describe("아트 스타일"),
        theme: z.string().min(1).max(200).describe("게임 테마"),
        tagline: z.string().max(100).optional().describe("태그라인"),
        layout: z.enum(["title_left", "title_right", "title_center", "characters_spread"])
          .default("title_left").describe("레이아웃"),
        color_scheme: z.enum(["light", "dark"]).default("dark").describe("색상 스킴"),
        ai_prompt: z.string().max(4000).optional()
          .describe("AI 생성 프롬프트 (미제공 시 파라미터로 자동 생성, asset_plan_thumbnail 결과 권장)"),
        character_image_paths: z.array(z.string()).max(4).optional()
          .describe("캐릭터 PNG 파일 경로 배열 (AI 레퍼런스용, 최대 4개)"),
        background_image_path: z.string().optional()
          .describe("배경 이미지 파일 경로 (AI 레퍼런스용)"),
        add_text: z.boolean().default(true)
          .describe("제목+태그라인 SVG 텍스트 합성 여부"),
        provider: z.enum(["openai", "gemini"]).default("openai")
          .describe("레퍼런스 이미지 없을 때 사용할 AI 제공자"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("high")
          .describe("생성 품질 (openai gpt-image-1 기준)"),
        output_dir: z.string().optional().describe("출력 디렉토리"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = path.resolve(params.output_dir || path.join(DEFAULT_OUTPUT_DIR, THUMB_SUBDIR));
        ensureDir(outputDir);

        // 프롬프트 결정
        const prompt = params.ai_prompt || buildThumbnailPrompt({
          game_name: params.game_name,
          genre: params.genre,
          art_style: params.art_style,
          theme: params.theme,
          tagline: params.tagline,
          layout: params.layout,
          color_scheme: params.color_scheme,
          characters: [],
          custom_prompt: undefined,
        });

        // 레퍼런스 이미지 수집
        const refPaths: string[] = [];
        if (params.background_image_path) {
          if (!fs.existsSync(params.background_image_path)) {
            throw new Error(`background_image_path 파일 없음: ${params.background_image_path}`);
          }
          refPaths.push(params.background_image_path);
        }
        if (params.character_image_paths?.length) {
          for (const p of params.character_image_paths) {
            if (!fs.existsSync(p)) throw new Error(`character_image_paths 파일 없음: ${p}`);
            refPaths.push(p);
          }
        }

        let base64: string;
        let generationMethod: string;

        const tmpPath = path.join(outputDir, `_tmp_thumb_${Date.now()}.png`);

        if (refPaths.length > 0) {
          // ── 레퍼런스 이미지 기반: gpt-image-1 edit API ──
          const r = await editImageOpenAI({
            imagePaths: refPaths,
            prompt,
            model: "gpt-image-1",
            size: "1536x1024",
          });
          base64 = r.base64;
          generationMethod = `openai_edit (${refPaths.length} refs)`;
        } else if (params.provider === "gemini") {
          // ── Gemini Imagen 16:9 ──
          const r = await generateImageGemini({ prompt, aspectRatio: "16:9" });
          base64 = r.base64;
          generationMethod = "gemini_imagen_16:9";
        } else {
          // ── OpenAI gpt-image-1 wide ──
          const r = await generateImageOpenAI({
            prompt,
            model: "gpt-image-1",
            size: "1792x1024",
            quality: params.quality,
            background: "opaque",
          });
          base64 = r.base64;
          generationMethod = "openai_gpt-image-1_1792x1024";
        }

        // ── 1932×828 리사이즈 (cover crop) ──
        saveBase64File(base64, tmpPath);
        const resizedBuf = await sharp(tmpPath)
          .resize(THUMB_W, THUMB_H, { fit: "cover", position: "center" })
          .png()
          .toBuffer();

        // ── SVG 텍스트 오버레이 ──
        let finalBuf = resizedBuf;
        if (params.add_text) {
          const svg = buildThumbnailSvg({
            title: params.game_name,
            tagline: params.tagline,
            layout: params.layout,
            color_scheme: params.color_scheme,
          });
          finalBuf = await sharp(resizedBuf)
            .composite([{ input: Buffer.from(svg), blend: "over" }])
            .png()
            .toBuffer();
        }

        // ── 저장 ──
        const safeName = params.game_name.toLowerCase().replace(/\s+/g, "_").replace(/[^\w가-힣]/g, "");
        const ts = new Date().toISOString().slice(0, 10);
        const fileName = `${safeName}_thumb_${params.layout}_${params.color_scheme}_${ts}.png`;
        const finalPath = path.join(outputDir, fileName);

        fs.writeFileSync(finalPath, finalBuf);
        try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }

        saveAssetToRegistry({
          id: generateAssetId(), type: "image", asset_type: "thumbnail",
          provider: generationMethod, prompt,
          file_path: finalPath, file_name: fileName, mime_type: "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            game_name: params.game_name,
            size: `${THUMB_W}x${THUMB_H}`,
            layout: params.layout,
            color_scheme: params.color_scheme,
            generation_method: generationMethod,
            reference_images: refPaths,
            add_text: params.add_text,
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
              reference_images_used: refPaths.length,
              add_text: params.add_text,
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: handleApiError(err, "thumbnail") }] };
      }
    }
  );
}
