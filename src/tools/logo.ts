import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { generateImageOpenAI, editImageOpenAI } from "../services/openai.js";
import { removeBackground } from "../utils/image-process.js";
import {
  ensureDir,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import {
  startLatencyTracker,
  buildCostTelemetry,
  buildEditCostTelemetry,
  type CostTelemetry,
} from "../utils/cost-tracking.js";
import { writeOptimized } from "../utils/image-output.js";
import {
  ensureTitleTextImage,
  TITLE_TEXT_SUBDIR,
  CHROMA_MAGENTA,
} from "../utils/title-text.js";
import { makeAssetSlug } from "../utils/slug.js";

const LOGO_SIZE = 600;
const LOGO_SUBDIR = "logos";
const REPRESENTATIVE_MODEL = "gpt-image-2";
const COMPOSITE_MODEL = "gpt-image-2";

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

// ─── Prompt Builders ──────────────────────────────────────────────────────────

function buildRepresentativeImagePrompt(p: {
  game_name: string;
  genre: string;
  art_style: string;
  theme: string;
  characters_description?: string;
  custom_prompt?: string;
}): string {
  const subject = p.characters_description?.trim()
    ? p.characters_description
    : `a single iconic hero character or signature object that best represents the game`;
  return (
    `Square key art for a ${p.genre} mobile game titled "${p.game_name}". ` +
    `Subject: ${subject}. ` +
    `Composition: subject centered, full body or full silhouette visible, taking ~70% of canvas. ` +
    `Art style: ${p.art_style}. Theme: ${p.theme}. ` +
    `Bold silhouette, strong readable shapes, limited palette (3–4 colors). ` +
    `BACKGROUND: pure magenta (#FF00FF) — completely flat solid color, no gradient, no texture, fills every edge. ` +
    `STRICTLY NO text, NO logo, NO frame, NO border, NO UI elements.` +
    (p.custom_prompt ? ` Additional: ${p.custom_prompt}` : "")
  );
}

function buildLogoCompositePrompt(p: {
  game_name: string;
  genre: string;
  art_style: string;
  theme: string;
  color_scheme: "light" | "dark";
  brand_color?: string;
  ref_count_chars: number;
  custom_prompt?: string;
}): string {
  const bgColor = p.color_scheme === "dark"
    ? "solid deep dark navy (#0a0a2e)"
    : "solid sky blue (#4a90d9)";
  const charRefs = p.ref_count_chars === 1
    ? "the FIRST reference image"
    : `the FIRST ${p.ref_count_chars} reference images`;
  const brandLine = p.brand_color
    ? ` The wordmark's brand color is ${p.brand_color}; preserve it.`
    : "";
  return (
    `Compose a single square mobile game app icon by combining the provided reference images into one unified piece of art. ` +
    `• ${charRefs} show the focal character / hero subject. Place it CENTERED, occupying roughly the upper 70% of the canvas. ` +
    `• The LAST reference image is the finished game-title wordmark. Place it across the bottom 25% of the canvas. ` +
    `• PRESERVE the wordmark EXACTLY — keep its letter shapes, spelling, color, and outline identical to the reference. Do NOT redraw, restyle, translate, or re-letter the text.${brandLine} ` +
    `• BACKGROUND: ${bgColor}. Fills the ENTIRE canvas to every edge — NO border, NO frame, NO rounded corners, NO vignette, NO inner padding. ` +
    `• Integrate the character and wordmark so they read as one cohesive logo, not pasted layers. The character may sit just above the wordmark with light visual overlap allowed, but the wordmark text itself must remain fully readable and unobscured. ` +
    `• Design principles: instantly recognizable at 60×60px, bold silhouette, limited palette (3–4 colors total including the brand color). ` +
    `Game: "${p.game_name}", ${p.genre} genre. Art style: ${p.art_style}. Theme: ${p.theme}.` +
    (p.custom_prompt ? ` Additional: ${p.custom_prompt}` : "")
  );
}

// ─── Representative Image — only when character refs are absent ──────────────

async function generateRepresentativeImage(args: {
  game_name: string;
  genre: string;
  art_style: string;
  theme: string;
  characters_description?: string;
  custom_prompt?: string;
  workDir: string;
}): Promise<{ path: string; cost: CostTelemetry; prompt: string }> {
  ensureDir(args.workDir);

  const prompt = buildRepresentativeImagePrompt({
    game_name: args.game_name,
    genre: args.genre,
    art_style: args.art_style,
    theme: args.theme,
    characters_description: args.characters_description,
    custom_prompt: args.custom_prompt,
  });

  const latency = startLatencyTracker();
  const r = await generateImageOpenAI({
    prompt,
    model: REPRESENTATIVE_MODEL,
    size: "1024x1024",
    quality: "high",
    background: "opaque",
  });
  const latencyMs = latency.elapsed();

  const tmpRaw = path.join(args.workDir, `_tmp_repr_${Date.now()}.png`);
  saveBase64File(r.base64, tmpRaw);

  // 마젠타 배경을 투명화해 합성 단계의 가이드 이미지 품질을 높임
  const finalPath = path.join(args.workDir, `_tmp_repr_clean_${Date.now()}.png`);
  await removeBackground(tmpRaw, finalPath, {
    chromaKeyColor: CHROMA_MAGENTA,
    threshold: 60,
  });
  fs.unlinkSync(tmpRaw);

  const cost = buildCostTelemetry(REPRESENTATIVE_MODEL, "high", "1024x1024", latencyMs);
  return { path: finalPath, cost, prompt };
}

// ─── Tool Registration ────────────────────────────────────────────────────────

export function registerLogoTools(server: McpServer): void {
  server.registerTool(
    "asset_generate_app_logo",
    {
      title: "Generate App Logo (600×600)",
      description: `게임 앱 로고를 600×600px PNG로 생성합니다.

**호출 순서 권장**:
- 본 도구는 워크플로 **마지막(Stage 6 — Marketing)** 에 위치합니다.
- 호출 전에 캐릭터·배경·타이틀 텍스트 PNG가 모두 준비된 상태에서 \`character_image_paths\` / \`title_text_image_path\` 를 넘겨주세요.
- 입력이 비면 도구가 내부에서 대표 이미지·타이틀 텍스트를 자동 생성하지만, 다른 도구로 먼저 만든 자산을 재사용하는 편이 일관성·비용 모두 유리합니다.

**디자인 원칙**:
- 한 눈에 들어오는 구성 — 60×60px로 축소해도 인식 가능
- 굵은 실루엣, 단순한 형태, 강한 대비
- 게임 장르/분위기를 즉시 전달

**자동 처리 (신규 파이프라인)**:
1. 타이틀 텍스트 이미지 생성 (1회) — gpt-image-2로 마젠타(#FF00FF) 단색 배경 위에 게임명 워드마크만 렌더 → 마젠타 크로마키 제거 → 투명 PNG
   - \`title_text_image_path\` 입력 시 그대로 재사용 (재생성 비용 0)
   - 새로 생성한 텍스트 이미지는 \`title_text/\` 하위에 영구 저장되어 다른 화면(로딩/로비 등) 도구에 레퍼런스로 재사용 가능
2. 캐릭터/대표 이미지 확보 — \`character_image_paths\` 제공 시 그대로 사용, 미제공 시 gpt-image-2로 대표 이미지 1장 자동 생성
3. 합성 — gpt-image-2 edit API에 [캐릭터 …, 타이틀 텍스트] 순으로 레퍼런스 투입해 통합 로고 생성 (color_scheme별로 반복)
4. 코너 비네팅 제거 + 600×600 리사이즈
5. 엔진별 최종 인코딩 (PNG/WebP 자동 선택)

**텍스트 색상**: \`brand_color\` 미지정 시 theme/art_style로부터 단일 주색을 자동 선택합니다.

Args:
  - game_name: 게임 이름 (텍스트 이미지에 정확히 렌더)
  - genre: 게임 장르
  - art_style: 아트 스타일
  - theme: 게임 테마
  - characters_description: 대표 이미지 자동 생성 시 사용할 캐릭터/시각 요소 설명 (character_image_paths 미제공 시 fallback)
  - color_scheme: "light" | "dark" | "both" (기본: both) — 합성 단계 배경색
  - character_image_paths: 캐릭터 베이스 이미지 경로 배열 (최대 4개)
  - brand_color: 텍스트 워드마크 색상 (hex 또는 색명, 미지정 시 자동 추론)
  - title_text_image_path: 이미 생성된 타이틀 텍스트 PNG 경로 (재사용 시)
  - custom_prompt: 추가 프롬프트 지시사항
  - output_dir: 로고 출력 디렉토리. 기본 \`.minigame-assets/logos/\`. 타이틀 텍스트는 형제 폴더 \`title_text/\`에 별도 저장. **registry/deploy-map은 항상 프로젝트 루트(\`.minigame-assets/\`) 한 곳에 통합 저장됩니다** — sub-dir을 직접 지정해도 분리되지 않습니다.

Returns:
  생성된 600×600 PNG 파일 경로 + 타이틀 텍스트 이미지 경로(\`title_text_path\`).`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름"),
        name_slug: z.string().min(1).max(60).optional()
          .describe("ASCII 영문 슬러그 (파일명용). 한글 게임명일 때 권장. 미지정 시 game_name에서 한글 보존 슬러그로 fallback"),
        genre: z.string().min(1).max(200).describe("게임 장르"),
        art_style: z.string().min(1).max(200).describe("아트 스타일"),
        theme: z.string().min(1).max(200).describe("게임 테마"),
        characters_description: z.string().max(1000).optional()
          .describe("대표 이미지 자동 생성 시 사용 (character_image_paths 미제공 시)"),
        color_scheme: z.enum(["light", "dark", "both"]).default("both")
          .describe("배경 색상 스킴 (합성 단계)"),
        character_image_paths: z.array(z.string()).max(4).optional()
          .describe("캐릭터 베이스 이미지 경로 (최대 4개)"),
        brand_color: z.string().max(80).optional()
          .describe("타이틀 텍스트 색상 (hex 또는 색명). 미제공 시 theme/art_style로부터 자동 추론"),
        title_text_image_path: z.string().optional()
          .describe("이미 생성된 타이틀 텍스트 PNG 경로 (재사용)"),
        custom_prompt: z.string().max(500).optional()
          .describe("추가 프롬프트 지시사항"),
        output_dir: z.string().optional()
          .describe("로고 출력 디렉토리. 기본 `.minigame-assets/logos/`. registry/deploy-map은 항상 프로젝트 루트(`.minigame-assets/`) 한 곳에 통합."),
      }).strict(),
      annotations: {
        readOnlyHint: false, destructiveHint: false,
        idempotentHint: false, openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const logoDir = path.resolve(params.output_dir || path.join(DEFAULT_OUTPUT_DIR, LOGO_SUBDIR));
        ensureDir(logoDir);
        const titleTextDir = path.resolve(logoDir, "..", TITLE_TEXT_SUBDIR);

        const charPaths = params.character_image_paths ?? [];
        for (const p of charPaths) {
          if (!fs.existsSync(p)) throw new Error(`character_image_paths: 파일 없음 — ${p}`);
        }

        // ── Step A: title text image (한 번만) ──────────────────────────────
        const titleText = await ensureTitleTextImage({
          game_name: params.game_name,
          name_slug: params.name_slug,
          brand_color: params.brand_color,
          art_style: params.art_style,
          theme: params.theme,
          custom_prompt: params.custom_prompt,
          titleTextDir,
          registryDir: logoDir,
          reusePath: params.title_text_image_path,
        });

        // ── Step B: 캐릭터 또는 대표 이미지 확보 (한 번만) ─────────────────
        let representative: { path: string; cost: CostTelemetry; prompt: string } | null = null;
        let referenceCharPaths: string[];
        if (charPaths.length > 0) {
          referenceCharPaths = charPaths;
        } else {
          representative = await generateRepresentativeImage({
            game_name: params.game_name,
            genre: params.genre,
            art_style: params.art_style,
            theme: params.theme,
            characters_description: params.characters_description,
            custom_prompt: params.custom_prompt,
            workDir: logoDir,
          });
          referenceCharPaths = [representative.path];
        }

        // ── Step C: scheme별 합성 ───────────────────────────────────────────
        const schemes: Array<"light" | "dark"> =
          params.color_scheme === "both" ? ["light", "dark"] : [params.color_scheme];
        const results: Array<{ scheme: string; filePath: string }> = [];

        for (const scheme of schemes) {
          const compositePrompt = buildLogoCompositePrompt({
            game_name: params.game_name,
            genre: params.genre,
            art_style: params.art_style,
            theme: params.theme,
            color_scheme: scheme,
            brand_color: params.brand_color,
            ref_count_chars: referenceCharPaths.length,
            custom_prompt: params.custom_prompt,
          });

          const editLatency = startLatencyTracker();
          const editResult = await editImageOpenAI({
            imagePaths: [...referenceCharPaths, titleText.path],
            prompt: compositePrompt,
            model: COMPOSITE_MODEL,
            size: "1024x1024",
          });
          const editLatencyMs = editLatency.elapsed();
          const refCount = referenceCharPaths.length + 1;

          const tmpRaw = path.join(logoDir, `_tmp_${Date.now()}.png`);
          saveBase64File(editResult.base64, tmpRaw);

          const safeName = makeAssetSlug({ name_slug: params.name_slug, game_name: params.game_name });
          const ts = new Date().toISOString().slice(0, 10);
          const pngPath = path.join(logoDir, `${safeName}_logo_${scheme}_${ts}.png`);

          await fixCornerVignette(tmpRaw, pngPath);
          fs.unlinkSync(tmpRaw);

          // Engine-aware final encode — if engine supports WebP, drop the PNG
          const pngBuf = fs.readFileSync(pngPath);
          const written = await writeOptimized(pngBuf, pngPath);
          const finalPath = written.path;
          const fileName = path.basename(finalPath);
          if (finalPath !== pngPath) {
            fs.unlinkSync(pngPath);
          }

          const compositeCost = buildEditCostTelemetry(COMPOSITE_MODEL, "1024x1024", editLatencyMs, refCount);

          saveAssetToRegistry({
            id: generateAssetId(), type: "image", asset_type: "logo",
            provider: `openai/${COMPOSITE_MODEL}`,
            prompt: compositePrompt,
            file_path: finalPath, file_name: fileName,
            mime_type: written.format === "webp" ? "image/webp" : "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              game_name: params.game_name,
              color_scheme: scheme,
              size: `${LOGO_SIZE}x${LOGO_SIZE}`,
              brand_color: params.brand_color ?? "inferred",
              title_text_path: titleText.path,
              title_text_reused: titleText.reused,
              character_ref_mode: charPaths.length > 0
                ? "user_provided"
                : "auto_representative",
              character_ref_count: referenceCharPaths.length,
              pre_generation: {
                ...(titleText.cost ? { title_text: titleText.cost } : {}),
                ...(representative ? { representative: representative.cost } : {}),
              },
              ...compositeCost,
            },
          }, logoDir);

          results.push({ scheme, filePath: finalPath });
        }

        // ── Step D: 임시 대표 이미지 정리 ───────────────────────────────────
        if (representative && fs.existsSync(representative.path)) {
          try { fs.unlinkSync(representative.path); } catch { /* ignore */ }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              size: `${LOGO_SIZE}×${LOGO_SIZE}px`,
              title_text_path: titleText.path,
              title_text_reused: titleText.reused,
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
