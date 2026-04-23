import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { editImageGemini } from "../services/gemini.js";
import {
  ensureDir,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { startLatencyTracker, buildCostTelemetry, buildEditCostTelemetry } from "../utils/cost-tracking.js";
import { writeOptimized } from "../utils/image-output.js";

const LOGO_SIZE = 600;
const LOGO_SUBDIR = "logos";

// ─── Corner Vignette Removal ──────────────────────────────────────────────────
// AI가 생성한 앱아이콘 스타일 이미지는 라운드 코너 효과를 자동으로 추가하는 경향이 있음.
// 엣지 중앙에서 배경색을 샘플링 후, 코너 영역을 배경색으로 블렌딩하여 플랫하게 처리.

async function fixCornerVignette(inputPath: string, outputPath: string): Promise<void> {
  const { data, info } = await sharp(inputPath)
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const arr = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) arr[i] = data[i];

  const { width: w, height: h, channels } = info;

  const midY = Math.floor(h / 2);
  let bgR = 0, bgG = 0, bgB = 0, count = 0;
  for (let y = midY - 10; y <= midY + 10; y++) {
    for (const x of [0, 1, 2, w - 3, w - 2, w - 1]) {
      const idx = (y * w + x) * channels;
      bgR += arr[idx]; bgG += arr[idx + 1]; bgB += arr[idx + 2];
      count++;
    }
  }
  bgR /= count; bgG /= count; bgB /= count;

  const radius = w * 0.10;
  const blendW = w * 0.04;

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = Math.min(x, w - 1 - x);
      const dy = Math.min(y, h - 1 - y);
      const dist = Math.sqrt(dx * dx + dy * dy);

      let blend = 0;
      if (dist < radius - blendW) blend = 1;
      else if (dist < radius) blend = (radius - dist) / blendW;

      if (blend > 0) {
        const idx = (y * w + x) * channels;
        arr[idx]     = arr[idx]     * (1 - blend) + bgR * blend;
        arr[idx + 1] = arr[idx + 1] * (1 - blend) + bgG * blend;
        arr[idx + 2] = arr[idx + 2] * (1 - blend) + bgB * blend;
      }
    }
  }

  const buf = Buffer.alloc(data.length);
  for (let i = 0; i < arr.length; i++) buf[i] = Math.min(255, Math.max(0, Math.round(arr[i])));

  await sharp(buf, { raw: { width: w, height: h, channels: channels as 3 } })
    .resize(LOGO_SIZE, LOGO_SIZE, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toFile(outputPath);
}

// ─── SVG Text Overlay ────────────────────────────────────────────────────────

async function addLogoText(
  imagePath: string,
  text: string,
  colorScheme: "light" | "dark"
): Promise<void> {
  const size = LOGO_SIZE;
  const fontSize = Math.round(size * 0.13);
  const textY = Math.round(size * 0.91);
  const bgY   = Math.round(size * 0.79);
  const bgH   = size - bgY;

  const gradStop1 = colorScheme === "dark" ? "rgba(0,0,20,0.85)"    : "rgba(0,60,120,0.75)";
  const gradStop2 = colorScheme === "dark" ? "rgba(0,0,20,0)"       : "rgba(0,60,120,0)";

  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="tbg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${gradStop2}"/>
      <stop offset="100%" stop-color="${gradStop1}"/>
    </linearGradient>
  </defs>
  <rect x="0" y="${bgY}" width="${size}" height="${bgH}" fill="url(#tbg)"/>
  <text
    x="${size / 2}" y="${textY}"
    font-family="Apple SD Gothic Neo, Noto Sans KR, Malgun Gothic, sans-serif"
    font-size="${fontSize}" font-weight="bold"
    text-anchor="middle" dominant-baseline="middle"
    fill="#FFB800" stroke="#3B1200"
    stroke-width="${Math.round(fontSize * 0.12)}"
    paint-order="stroke fill"
  >${text}</text>
</svg>`;

  const tmpPath = imagePath + ".tmp_notext.png";
  fs.copyFileSync(imagePath, tmpPath);
  await sharp(tmpPath)
    .composite([{ input: Buffer.from(svg), blend: "over" }])
    .png()
    .toFile(imagePath);
  fs.unlinkSync(tmpPath);
}

// ─── Prompt Builders ──────────────────────────────────────────────────────────

function buildLogoPrompt(p: {
  game_name: string; genre: string; characters_description: string;
  art_style: string; theme: string; color_scheme: "light" | "dark";
  custom_prompt?: string;
}): string {
  const bg = p.color_scheme === "dark"
    ? "solid deep dark navy blue fills the ENTIRE canvas to every edge — NO border, NO frame, NO rounded corners. Characters BRIGHT with neon outlines."
    : "solid sky blue fills the ENTIRE canvas to every edge — NO border, NO frame, NO rounded corners. Characters colorful with clear dark outlines.";

  const chars = p.game_name.split("").join(", ");
  return (
    `Square mobile game app icon for a ${p.genre} game. Art style: ${p.art_style}. ` +
    `Characters and visual elements: ${p.characters_description}. ` +
    `BACKGROUND: ${bg} ` +
    `TEXT: display game name "${p.game_name}" at bottom center — ${p.game_name.length} characters: ${chars}. ` +
    `DESIGN PRINCIPLE: readable and instantly recognizable at 60×60px. Bold shapes, strong silhouette. Theme: ${p.theme}. ` +
    `NO transparency. Flat square, no inner border.` +
    (p.custom_prompt ? ` Additional: ${p.custom_prompt}` : "")
  );
}

function buildLogoEditPrompt(p: {
  game_name: string; genre: string; art_style: string; theme: string;
  color_scheme: "light" | "dark"; custom_prompt?: string;
}): string {
  const bgColor = p.color_scheme === "dark" ? "solid deep dark navy (#0a0a2e)" : "solid sky blue (#4a90d9)";
  return (
    `Using the reference character image(s) as style guide, draw a NEW square mobile game app icon. ` +
    `DESIGN PRINCIPLES (most important): ` +
    `• Instantly recognizable at 60×60px — flat, bold shapes, strong silhouette. ` +
    `• Max 2 focal characters. No busy backgrounds. Limited color palette (3–4 colors). ` +
    `• Characters centered, taking ~70% of canvas. Bottom 20% left empty (text added later). ` +
    `BACKGROUND: ${bgColor}, fills entire canvas to every corner. NO border, NO frame, NO vignette. ` +
    `DO NOT add any text. ` +
    `Game: "${p.game_name}", ${p.genre} genre. Art style: ${p.art_style}. Theme: ${p.theme}.` +
    (p.custom_prompt ? ` Additional: ${p.custom_prompt}` : "")
  );
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerLogoTools(server: McpServer): void {
  server.registerTool(
    "asset_generate_app_logo",
    {
      title: "Generate App Logo (600×600)",
      description: `게임 앱 로고를 600×600px PNG로 생성합니다.

**디자인 원칙**:
- 한 눈에 들어오는 구성 — 60×60px로 축소해도 인식 가능
- 굵은 실루엣, 단순한 형태, 강한 대비
- 게임 장르/분위기를 즉시 전달

**자동 처리**:
1. gpt-image-1로 1024×1024 생성 (텍스트 없이 아트워크만)
2. AI가 자주 추가하는 코너 비네팅 제거
3. 600×600으로 리사이즈
4. 게임 이름 텍스트를 SVG로 프로그래밍 합성 (하단 중앙)
   - 한글/영문 정확 렌더링

**character_image_paths 제공 시**: 해당 캐릭터 이미지 스타일을 참고해 새 로고 생성 (Gemini 활용)

Args:
  - game_name: 게임 이름 (로고 하단에 텍스트로 삽입)
  - genre: 게임 장르
  - art_style: 아트 스타일
  - theme: 게임 테마
  - characters_description: 로고에 들어갈 캐릭터/시각 요소 설명 (character_image_paths 미제공 시 사용)
  - color_scheme: "light" | "dark" | "both" (기본: both)
  - character_image_paths: 캐릭터 베이스 이미지 경로 배열 (스타일 참조용, 최대 4개)
  - add_text: 게임 이름 텍스트 합성 여부 (기본: true)
  - custom_prompt: 추가 프롬프트 지시사항
  - output_dir: 출력 경로

Returns:
  생성된 600×600 PNG 파일 경로.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름 (로고 텍스트)"),
        genre: z.string().min(1).max(200).describe("게임 장르"),
        art_style: z.string().min(1).max(200).describe("아트 스타일"),
        theme: z.string().min(1).max(200).describe("게임 테마"),
        characters_description: z.string().max(1000).optional()
          .describe("로고에 들어갈 캐릭터/시각 요소 설명 (character_image_paths 미제공 시)"),
        color_scheme: z.enum(["light", "dark", "both"]).default("both")
          .describe("배경 색상 스킴 (light: 밝은 배경 / dark: 어두운 배경 / both: 둘 다)"),
        character_image_paths: z.array(z.string()).max(4).optional()
          .describe("캐릭터 베이스 이미지 경로 (스타일 참조용, 최대 4개)"),
        add_text: z.boolean().default(true)
          .describe("게임 이름 텍스트를 하단에 합성할지 여부"),
        custom_prompt: z.string().max(500).optional()
          .describe("추가 프롬프트 지시사항"),
        output_dir: z.string().optional()
          .describe("출력 디렉토리"),
      }).strict(),
      annotations: {
        readOnlyHint: false, destructiveHint: false,
        idempotentHint: false, openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const outputDir = path.resolve(params.output_dir || path.join(DEFAULT_OUTPUT_DIR, LOGO_SUBDIR));
        ensureDir(outputDir);

        const schemes: Array<"light" | "dark"> =
          params.color_scheme === "both" ? ["light", "dark"] : [params.color_scheme];

        const results: Array<{ scheme: string; filePath: string }> = [];

        const charPaths = params.character_image_paths ?? [];
        for (const p of charPaths) {
          if (!fs.existsSync(p)) throw new Error(`character_image_paths: 파일 없음 — ${p}`);
        }
        const useCharRef = charPaths.length > 0;

        for (const scheme of schemes) {
          let base64: string;
          let revisedPrompt: string;
          let callModel: string;
          let callKind: "edit" | "generate";
          let refCount = 0;

          const latency = startLatencyTracker();
          if (useCharRef) {
            const prompt = buildLogoEditPrompt({
              game_name: params.game_name, genre: params.genre,
              art_style: params.art_style, theme: params.theme,
              color_scheme: scheme, custom_prompt: params.custom_prompt,
            });
            const refs = charPaths.map((p) => ({
              base64: fs.readFileSync(p).toString("base64"),
              mimeType: "image/png" as const,
            }));
            const r = await editImageGemini({
              imageBase64: refs[0].base64,
              imageMimeType: refs[0].mimeType,
              referenceImages: refs,
              editPrompt: prompt,
            });
            base64 = r.base64;
            revisedPrompt = prompt;
            callModel = "gemini-2.5-flash-image";
            callKind = "edit";
            refCount = refs.length;
          } else {
            const prompt = buildLogoPrompt({
              game_name: params.game_name, genre: params.genre,
              characters_description: params.characters_description ?? "",
              art_style: params.art_style, theme: params.theme,
              color_scheme: scheme, custom_prompt: params.custom_prompt,
            });
            const r = await generateImageOpenAI({
              prompt, size: "1024x1024", quality: "high", background: "opaque",
            });
            base64 = r.base64;
            revisedPrompt = r.revisedPrompt;
            callModel = "gpt-image-1-mini";
            callKind = "generate";
          }
          const latencyMs = latency.elapsed();

          const tmpRaw = path.join(outputDir, `_tmp_${Date.now()}.png`);
          saveBase64File(base64, tmpRaw);

          const safeName = params.game_name.toLowerCase().replace(/\s+/g, "_").replace(/[^\w가-힣]/g, "");
          const ts = new Date().toISOString().slice(0, 10);
          // Intermediate PNG (corner vignette + text overlay operate on PNG)
          const pngPath = path.join(outputDir, `${safeName}_logo_${scheme}_${ts}.png`);

          await fixCornerVignette(tmpRaw, pngPath);
          fs.unlinkSync(tmpRaw);

          if (params.add_text) {
            await addLogoText(pngPath, params.game_name, scheme);
          }

          // Engine-aware final encode — if engine supports WebP, drop the PNG
          const pngBuf = fs.readFileSync(pngPath);
          const written = await writeOptimized(pngBuf, pngPath);
          const finalPath = written.path;
          const fileName = path.basename(finalPath);
          if (finalPath !== pngPath) {
            fs.unlinkSync(pngPath);
          }

          saveAssetToRegistry({
            id: generateAssetId(), type: "image", asset_type: "logo",
            provider: useCharRef ? "gemini" : "openai/gpt-image-1",
            prompt: revisedPrompt, file_path: finalPath, file_name: fileName,
            mime_type: written.format === "webp" ? "image/webp" : "image/png", created_at: new Date().toISOString(),
            metadata: {
              game_name: params.game_name, color_scheme: scheme,
              size: `${LOGO_SIZE}x${LOGO_SIZE}`,
              character_ref_mode: useCharRef,
              add_text: params.add_text,
              model: callModel,
              ...(callKind === "edit"
                ? buildEditCostTelemetry(callModel, "1024x1024", latencyMs, refCount)
                : buildCostTelemetry(callModel, "high", "1024x1024", latencyMs)),
            },
          }, outputDir);

          results.push({ scheme, filePath: finalPath });
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              size: `${LOGO_SIZE}×${LOGO_SIZE}px`,
              generated: results.map((r) => ({ scheme: r.scheme, file_path: r.filePath })),
            }, null, 2),
          }],
        };
      } catch (err) {
        return { content: [{ type: "text" as const, text: handleApiError(err, "app logo") }] };
      }
    }
  );
}
