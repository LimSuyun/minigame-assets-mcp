/**
 * title-text.ts — 게임 타이틀 워드마크 이미지 생성/재사용 공통 유틸
 *
 * 로고·썸네일 등 타이틀 텍스트가 필요한 도구가 공유한다.
 * gpt-image-2는 투명 배경 출력을 지원하지 않으므로,
 *   1) 마젠타(#FF00FF) 단색 배경 위에 텍스트만 렌더 → 2) 크로마키 제거로 투명 PNG화
 * 흐름을 사용한다.
 */

import * as fs from "fs";
import * as path from "path";
import { generateImageOpenAI } from "../services/openai.js";
import { removeBackground } from "./image-process.js";
import {
  ensureDir,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
} from "./files.js";
import {
  startLatencyTracker,
  buildCostTelemetry,
  type CostTelemetry,
} from "./cost-tracking.js";
import { makeAssetSlug } from "./slug.js";

export const TITLE_TEXT_SUBDIR = "title_text";
export const TITLE_TEXT_MODEL = "gpt-image-2";
export const CHROMA_MAGENTA: [number, number, number] = [255, 0, 255];

export function buildTitleTextPrompt(p: {
  game_name: string;
  brand_color?: string;
  art_style: string;
  theme: string;
  custom_prompt?: string;
}): string {
  const colorClause = p.brand_color
    ? `Text fill color: ${p.brand_color}.`
    : `Text fill color: a single bold hue inferred from the game's theme and art style — choose ONE dominant brand color that fits "${p.theme}" and "${p.art_style}" (e.g., crimson for fiery action, cyan for sci-fi, gold for fantasy royalty).`;
  const chars = p.game_name.split("").join(", ");
  return (
    `Game title typography. Render ONLY the text "${p.game_name}" as a stylized game-logo wordmark. ` +
    `Letter-by-letter spelling MUST be exact: ${chars}. ` +
    `${colorClause} Add a thick dark outline around each letter for legibility on any background. ` +
    `Strong, bold, high-contrast lettering. Style cues from: ${p.art_style}, theme: ${p.theme}. ` +
    `BACKGROUND: pure magenta (#FF00FF) — completely flat solid color, no gradient, no texture, no noise. ` +
    `The magenta MUST extend to every edge of the canvas. ` +
    `Composition: text horizontally centered, large, occupying ~70% of canvas width. ` +
    `STRICTLY NO characters, NO mascots, NO icons, NO frames, NO borders, NO decorative shapes, NO drop shadows on the background. ` +
    `Just the title text on flat magenta.` +
    (p.custom_prompt ? ` Additional: ${p.custom_prompt}` : "")
  );
}

export interface EnsureTitleTextArgs {
  game_name: string;
  /** 영문 슬러그 — CONCEPT.name_slug 같은 안전한 파일명용 ASCII */
  name_slug?: string;
  brand_color?: string;
  art_style: string;
  theme: string;
  custom_prompt?: string;
  /** 신규 생성 시 PNG 저장 폴더 (보통 outputDir의 형제 `title_text/`) */
  titleTextDir: string;
  /** registry 통합 위치 (호출 도구의 출력 폴더) */
  registryDir: string;
  /** 기존에 생성된 PNG 경로. 있으면 그대로 재사용한다. */
  reusePath?: string;
}

export interface EnsureTitleTextResult {
  path: string;
  reused: boolean;
  cost: CostTelemetry | null;
  prompt: string | null;
}

export async function ensureTitleTextImage(
  args: EnsureTitleTextArgs,
): Promise<EnsureTitleTextResult> {
  if (args.reusePath) {
    if (!fs.existsSync(args.reusePath)) {
      throw new Error(`title_text_image_path: 파일 없음 — ${args.reusePath}`);
    }
    return { path: args.reusePath, reused: true, cost: null, prompt: null };
  }

  ensureDir(args.titleTextDir);

  const prompt = buildTitleTextPrompt({
    game_name: args.game_name,
    brand_color: args.brand_color,
    art_style: args.art_style,
    theme: args.theme,
    custom_prompt: args.custom_prompt,
  });

  const latency = startLatencyTracker();
  const r = await generateImageOpenAI({
    prompt,
    model: TITLE_TEXT_MODEL,
    size: "1024x1024",
    quality: "high",
    background: "opaque", // gpt-image-2는 투명 미지원 → 마젠타 단색으로 받고 후처리
  });
  const latencyMs = latency.elapsed();

  const safeName = makeAssetSlug({
    name_slug: args.name_slug,
    game_name: args.game_name,
  });
  const ts = new Date().toISOString().slice(0, 10);
  const tmpRaw = path.join(args.titleTextDir, `_tmp_title_${Date.now()}.png`);
  saveBase64File(r.base64, tmpRaw);

  const finalPath = path.join(
    args.titleTextDir,
    `${safeName}_title_text_${ts}.png`,
  );
  await removeBackground(tmpRaw, finalPath, {
    chromaKeyColor: CHROMA_MAGENTA,
    threshold: 60,
  });
  fs.unlinkSync(tmpRaw);

  const cost = buildCostTelemetry(TITLE_TEXT_MODEL, "high", "1024x1024", latencyMs);

  saveAssetToRegistry(
    {
      id: generateAssetId(),
      type: "image",
      asset_type: "title_text",
      provider: `openai/${TITLE_TEXT_MODEL}`,
      prompt: r.revisedPrompt,
      file_path: finalPath,
      file_name: path.basename(finalPath),
      mime_type: "image/png",
      created_at: new Date().toISOString(),
      metadata: {
        game_name: args.game_name,
        brand_color: args.brand_color ?? "inferred",
        size: "1024x1024",
        background_strategy: "magenta_chroma_key",
        reusable: true,
        ...cost,
      },
    },
    args.registryDir,
  );

  return { path: finalPath, reused: false, cost, prompt };
}
