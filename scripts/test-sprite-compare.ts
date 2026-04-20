/**
 * 9-프레임 마법봉 휘두르기 스프라이트 시트 모델 비교 테스트
 *
 * 4개 모델(gpt-image-1.5, gpt-image-1, gpt-image-1-mini, Gemini)로
 * 동일한 참조 이미지를 기반으로 9프레임 공격 스프라이트 시트를 생성·비교합니다.
 *
 * 사용법:
 *   npx tsx scripts/test-sprite-compare.ts [reference_image_path]
 *   npx tsx scripts/test-sprite-compare.ts ./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png
 *
 * 기본 참조 이미지: ./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png
 *
 * 결과물:
 *   - test-output/sprite-compare/frames/{model}/frame_f{nn}.png  (개별 프레임)
 *   - test-output/sprite-compare/sheets/{model}_sheet.png         (3×3 스프라이트 시트)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ── .env 로드 ──────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf-8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (!process.env[k]) process.env[k] = v;
  }
  console.log("✓ .env 로드됨");
}

// ── 인수 파싱 ──────────────────────────────────────────────────────────────────
const DEFAULT_REF = "./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png";
const REF_PATH = process.argv[2] ?? DEFAULT_REF;
const OUT_DIR = "./test-output/sprite-compare";

// ── 서비스 / 유틸 임포트 ──────────────────────────────────────────────────────
import { editImageOpenAI } from "../src/services/openai.js";
import { editImageGemini } from "../src/services/gemini.js";
import { composeSpritSheet } from "../src/utils/spritesheet-composer.js";
import { processFrameBase64 } from "../src/utils/image-process.js";
import type { FrameInfo } from "../src/utils/spritesheet-composer.js";

// ── 상수 ─────────────────────────────────────────────────────────────────────
const FRAME_COUNT = 9;

/** 순백 배경 지시어 (편집 API는 transparent 지원 안 함 → 후처리로 제거) */
const WHITE_BG_PROMPT =
  "pure white (#FFFFFF) background — perfectly uniform solid white, " +
  "absolutely no gradients, no shadows, no texture on the background. " +
  "CRITICAL: the character itself must NOT contain any pure white (#FFFFFF) pixels — " +
  "use off-white or light cream (at most rgb(220,220,220)) for any light-colored areas on the character.";

const NO_SHADOW =
  "CRITICAL — NO SHADOWS: Do NOT render any shadows of any kind — " +
  "no drop shadow, no cast shadow, no ground shadow, no contact shadow. " +
  "The character must appear completely shadow-free on the background.";

const NO_TEXT =
  "CRITICAL — NO TEXT: Do NOT render any readable text, letters, numbers, or writing anywhere in the image.";

/** 9프레임 마법봉 스윙 액션 정의 */
const FRAME_DEFS: Array<{ id: string; name: string; pose: string }> = [
  {
    id: "f00", name: "ready",
    pose: "idle ready stance — standing upright holding the magic staff diagonally at the side, " +
          "body relaxed, eyes alert and looking forward, one hand gripping the staff mid-shaft",
  },
  {
    id: "f01", name: "windup_start",
    pose: "beginning wind-up — both hands now gripping the magic staff, " +
          "arms starting to pull the staff backward and upward behind the head, " +
          "body turning very slightly to prepare for the swing",
  },
  {
    id: "f02", name: "windup_peak",
    pose: "full wind-up at peak — staff raised HIGH overhead with both hands, " +
          "arms fully extended upward, body coiled with energy ready to strike, " +
          "staff pointing diagonally upward behind the head",
  },
  {
    id: "f03", name: "swing_start",
    pose: "initiating swing — staff beginning to arc forward and downward forcefully, " +
          "arms driving forward, body starting to uncoil, staff at roughly 45 degrees above horizontal",
  },
  {
    id: "f04", name: "swing_mid",
    pose: "mid-swing — staff swinging horizontally through the air at chest height, " +
          "arms extended forward, body leaning into the swing, " +
          "small speed motion lines trailing behind the staff tip",
  },
  {
    id: "f05", name: "impact",
    pose: "impact moment — staff fully extended forward at waist height, " +
          "arms locked straight, a burst of blue magic energy exploding from the staff tip, " +
          "body fully committed to the forward swing",
  },
  {
    id: "f06", name: "magic_release",
    pose: "magic release — large glowing magical projectile/orb shooting out from the staff tip, " +
          "bright sparks and particles radiating outward, staff still pointed forward, " +
          "arms extended, expression focused and fierce",
  },
  {
    id: "f07", name: "follow_through",
    pose: "follow-through — staff swinging past the forward position, " +
          "arm slightly lowered following momentum, residual magic sparkles dissipating, " +
          "body beginning to decelerate",
  },
  {
    id: "f08", name: "recovery",
    pose: "recovery — returning to a guard/ready stance, staff being pulled back upright, " +
          "body straightening, expression returning to calm alertness, " +
          "back to near-idle pose",
  },
];

/** GPT edit 프롬프트 생성 */
function buildEditPrompt(pose: string): string {
  return (
    `Redraw this exact character in the following pose or action: ${pose}. ` +
    `Preserve every visual detail from the reference image exactly — ` +
    `same face, same body shape and proportions, same outfit and colors, same accessories and items. ` +
    `Only the pose or action changes. Nothing is added or removed. ` +
    `CRITICAL — framing and body visibility: ` +
    `The ENTIRE body from the very top of the head to the very tips of the feet MUST be fully visible — NEVER clip or cut off any body part. ` +
    `If the action requires more space, make the character SMALLER to fit — do NOT crop. ` +
    `The character must NOT exceed 70% of the total image height. ` +
    `Leave at least 15% empty margin on all sides. ` +
    `${WHITE_BG_PROMPT} ` +
    `${NO_SHADOW} ` +
    `${NO_TEXT}`
  );
}

/** Gemini edit 프롬프트 생성 (캐릭터 설명 포함) */
function buildGeminiEditPrompt(pose: string): string {
  return (
    `This is a chibi cat character wearing a blue hooded cloak with gold trim, holding a wooden magic staff with a glowing orb at the top. ` +
    `Redraw this exact character in the following pose: ${pose}. ` +
    `Keep the exact same character design, colors, and chibi art style. ` +
    `CRITICAL: Full body must be visible from head to feet, character no taller than 70% of image. ` +
    `${WHITE_BG_PROMPT} ` +
    `${NO_SHADOW} ` +
    `${NO_TEXT}`
  );
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readRefImage(refPath: string): { base64: string; mimeType: string; absPath: string } {
  const absPath = path.resolve(refPath);
  if (!fs.existsSync(absPath)) throw new Error(`참조 이미지를 찾을 수 없습니다: ${absPath}`);
  const base64 = fs.readFileSync(absPath).toString("base64");
  const ext = path.extname(absPath).toLowerCase();
  const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
    : ext === ".webp" ? "image/webp" : "image/png";
  return { base64, mimeType, absPath };
}

/** 프레임 후처리: 흰 배경 제거(flood-fill) + crop-to-content */
async function postProcess(base64: string, frameDir: string, frameId: string): Promise<string> {
  const buf = await processFrameBase64(base64, 250);
  const framePath = path.join(frameDir, `${frameId}.png`);
  fs.writeFileSync(framePath, buf);
  return framePath;
}

// ── 모델별 생성 함수 ────────────────────────────────────────────────────────────

type ModelLabel = "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini" | "gemini-2.5-flash-image";

async function generateFramesForModel(
  model: ModelLabel,
  ref: { base64: string; mimeType: string; absPath: string },
  frameDir: string,
  onFrame: (frameId: string, ok: boolean, ms: number) => void,
): Promise<Array<{ frameId: string; framePath: string | null; ms: number; error?: string }>> {

  const tasks = FRAME_DEFS.map(async (def) => {
    const start = Date.now();
    try {
      let base64: string;

      if (model === "gemini-2.5-flash-image") {
        const r = await editImageGemini({
          imageBase64: ref.base64,
          imageMimeType: ref.mimeType,
          editPrompt: buildGeminiEditPrompt(def.pose),
          model: "gemini-2.5-flash-image",
        });
        base64 = r.base64;
      } else {
        const r = await editImageOpenAI({
          imagePath: ref.absPath,
          prompt: buildEditPrompt(def.pose),
          model,
          size: "1024x1024",
        });
        base64 = r.base64;
      }

      const framePath = await postProcess(base64, frameDir, def.id);
      const ms = Date.now() - start;
      onFrame(def.id, true, ms);
      return { frameId: def.id, framePath, ms };
    } catch (err) {
      const ms = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      onFrame(def.id, false, ms);
      return { frameId: def.id, framePath: null, ms, error };
    }
  });

  return Promise.all(tasks);
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n" + "═".repeat(70));
  console.log("  9-프레임 마법봉 스윙 스프라이트 시트 — 모델 비교 테스트");
  console.log("═".repeat(70));
  console.log(`  참조 이미지 : ${REF_PATH}`);
  console.log(`  프레임 수   : ${FRAME_COUNT} (3×3 그리드)`);
  console.log(`  비교 모델   : gpt-image-1.5 | gpt-image-1 | gpt-image-1-mini | gemini-2.5-flash-image`);
  console.log(`  저장 경로   : ${OUT_DIR}`);
  console.log("═".repeat(70) + "\n");

  const ref = readRefImage(REF_PATH);

  const MODELS: ModelLabel[] = [
    "gpt-image-1.5",
    "gpt-image-1",
    "gpt-image-1-mini",
    "gemini-2.5-flash-image",
  ];

  const sheetsDir = path.resolve(OUT_DIR, "sheets");
  ensureDir(sheetsDir);

  type ModelSummary = {
    model: string;
    success: boolean;
    sheetPath?: string;
    totalMs?: number;
    frameResults?: Array<{ frameId: string; ok: boolean; ms: number }>;
    error?: string;
  };

  // 진행 상황 추적
  const progress: Record<string, Record<string, { ok: boolean; ms: number }>> = {};
  for (const m of MODELS) progress[m] = {};

  function onFrame(model: string, frameId: string, ok: boolean, ms: number): void {
    progress[model][frameId] = { ok, ms };
    const done = Object.keys(progress[model]).length;
    const symbol = ok ? "✅" : "❌";
    process.stdout.write(`  [${model.padEnd(24)}] ${symbol} ${frameId}  ${ms}ms  (${done}/${FRAME_COUNT} 완료)\n`);
  }

  console.log("4개 모델 × 9프레임 병렬 생성 시작...\n");
  const totalStart = Date.now();

  // 4개 모델 병렬 실행
  const modelResults = await Promise.allSettled(
    MODELS.map(async (model): Promise<ModelSummary> => {
      const frameDir = path.resolve(OUT_DIR, "frames", model.replace(/[./]/g, "_"));
      ensureDir(frameDir);

      const modelStart = Date.now();
      const frames = await generateFramesForModel(
        model, ref, frameDir,
        (frameId, ok, ms) => onFrame(model, frameId, ok, ms),
      );
      const totalMs = Date.now() - modelStart;

      // 성공한 프레임만 스프라이트 시트에 사용
      const validFrames: FrameInfo[] = frames
        .filter(f => f.framePath !== null)
        .map(f => ({
          name: `${model}_${f.frameId}`,
          filePath: f.framePath!,
          action: "wand_swing",
          frameIndex: FRAME_DEFS.findIndex(d => d.id === f.frameId),
        }))
        .sort((a, b) => a.frameIndex - b.frameIndex);

      if (validFrames.length === 0) {
        return { model, success: false, totalMs, error: "모든 프레임 생성 실패" };
      }

      const safeModel = model.replace(/[./]/g, "_");
      const sheetPath = path.join(sheetsDir, `${safeModel}_sheet.png`);
      await composeSpritSheet(validFrames, sheetPath, 4);

      return {
        model,
        success: true,
        sheetPath,
        totalMs,
        frameResults: frames.map(f => ({
          frameId: f.frameId,
          ok: f.framePath !== null,
          ms: f.ms,
        })),
      };
    })
  );

  const totalMs = Date.now() - totalStart;

  // ── 결과 출력 ────────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(70));
  console.log("  최종 결과");
  console.log("─".repeat(70));

  const summaries: ModelSummary[] = modelResults.map((r, i) =>
    r.status === "fulfilled"
      ? r.value
      : { model: MODELS[i], success: false, error: String((r as PromiseRejectedResult).reason) }
  );

  for (const s of summaries) {
    const ok = s.success ? "✅" : "❌";
    const successFrames = s.frameResults?.filter(f => f.ok).length ?? 0;
    const avgMs = s.frameResults
      ? Math.round(s.frameResults.reduce((a, f) => a + f.ms, 0) / s.frameResults.length)
      : 0;
    console.log(`\n  ${ok} ${s.model}`);
    if (s.success) {
      console.log(`     프레임 성공   : ${successFrames}/${FRAME_COUNT}`);
      console.log(`     평균 프레임 ms: ${avgMs}ms`);
      console.log(`     총 생성 시간  : ${s.totalMs}ms`);
      const sheetSize = s.sheetPath ? Math.round(fs.statSync(s.sheetPath).size / 1024) : 0;
      console.log(`     시트 크기     : ${sheetSize}KB`);
      console.log(`     시트 경로     : ${s.sheetPath}`);
    } else {
      console.log(`     오류: ${s.error}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(`  총 소요 시간: ${totalMs}ms (${(totalMs / 1000).toFixed(1)}초)`);

  // 프레임 성공률 순위
  const ranked = summaries
    .filter(s => s.success)
    .sort((a, b) => (b.frameResults?.filter(f => f.ok).length ?? 0) - (a.frameResults?.filter(f => f.ok).length ?? 0));

  if (ranked.length > 0) {
    console.log("\n  📊 결과 순위 (성공 프레임 수 기준):");
    ranked.forEach((s, i) => {
      const success = s.frameResults?.filter(f => f.ok).length ?? 0;
      const avg = s.frameResults
        ? Math.round(s.frameResults.reduce((a, f) => a + f.ms, 0) / s.frameResults.length)
        : 0;
      console.log(`    #${i + 1}  ${s.model.padEnd(26)} ${success}/${FRAME_COUNT}프레임  평균 ${avg}ms/frame`);
    });
  }

  console.log(`\n  스프라이트 시트 저장 위치: ${sheetsDir}\n`);
}

main().catch(err => {
  console.error("\n❌ 치명적 오류:", err.message ?? err);
  process.exit(1);
});
