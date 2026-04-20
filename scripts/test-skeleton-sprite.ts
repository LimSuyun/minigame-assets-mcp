/**
 * 스켈레톤 가이드 기반 스프라이트 시트 생성 테스트
 *
 * [캐릭터 참조 이미지 + OpenPose 스켈레톤 이미지]를 함께 모델에 전달해
 * 포즈 일관성을 개선합니다.
 *
 * 사용법:
 *   npx tsx scripts/test-skeleton-sprite.ts [reference_image]
 *   npx tsx scripts/test-skeleton-sprite.ts ./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png
 *
 * 결과물:
 *   test-output/skeleton-sprite/skeletons/  — 9개 스켈레톤 PNG
 *   test-output/skeleton-sprite/frames/{model}/  — 개별 프레임
 *   test-output/skeleton-sprite/sheets/  — 최종 스프라이트 시트 비교
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
const REF_PATH = process.argv.find(a => !a.startsWith("-") && a !== process.argv[1] && a !== process.argv[0]) ?? DEFAULT_REF;
const OUT_DIR = "./test-output/skeleton-sprite";

// ── 임포트 ───────────────────────────────────────────────────────────────────
import { editImageOpenAI } from "../src/services/openai.js";
import { editImageGemini } from "../src/services/gemini.js";
import { composeSpritSheet } from "../src/utils/spritesheet-composer.js";
import { processFrameBase64 } from "../src/utils/image-process.js";
import { generateSkeletonPng, WAND_SWING_POSES } from "../src/utils/pose-skeleton.js";
import type { FrameInfo } from "../src/utils/spritesheet-composer.js";
import type { PoseKeypoints } from "../src/utils/pose-skeleton.js";

// ── 상수 ─────────────────────────────────────────────────────────────────────

const SKELETON_SIZE = 512;   // 스켈레톤 PNG 해상도
const FRAME_COUNT = WAND_SWING_POSES.length; // 9

const WHITE_BG_PROMPT =
  "pure white (#FFFFFF) background — perfectly uniform solid white, " +
  "absolutely no gradients, no shadows, no texture on the background. " +
  "CRITICAL: the character itself must NOT contain any pure white (#FFFFFF) pixels — " +
  "use off-white or light cream (at most rgb(220,220,220)) for any light-colored areas on the character.";

const NO_SHADOW =
  "CRITICAL — NO SHADOWS: Do NOT render any shadows of any kind — " +
  "no drop shadow, no cast shadow, no ground shadow, no ambient occlusion. " +
  "The character must appear completely shadow-free.";

const NO_TEXT =
  "CRITICAL — NO TEXT: Do NOT render any readable text, letters, or numbers anywhere.";

const FRAMING =
  "CRITICAL — framing: The ENTIRE body from head-top to feet-tips MUST be fully visible. " +
  "Character must NOT exceed 70% of the total image height. " +
  "Leave at least 15% empty margin on all sides. Do NOT crop any body part.";

// ── 유틸 ──────────────────────────────────────────────────────────────────────

function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

function readImageAsBase64(p: string): { base64: string; mimeType: string; absPath: string } {
  const absPath = path.resolve(p);
  if (!fs.existsSync(absPath)) throw new Error(`이미지를 찾을 수 없습니다: ${absPath}`);
  return {
    base64: fs.readFileSync(absPath).toString("base64"),
    mimeType: "image/png",
    absPath,
  };
}

async function postProcess(base64: string, outPath: string): Promise<string> {
  const buf = await processFrameBase64(base64, 250);
  fs.writeFileSync(outPath, buf);
  return outPath;
}

// ── 프롬프트 빌더 ─────────────────────────────────────────────────────────────

function buildPromptWithSkeleton(pose: PoseKeypoints): string {
  return (
    `The FIRST image is the character reference — keep every visual detail exactly: ` +
    `same face, body shape, outfit colors, accessories, chibi art style. ` +
    `The SECOND image is a color-coded pose skeleton guide — follow this skeleton's body pose STRICTLY: ` +
    `match the arm angles, elbow positions, wrist positions, leg stance, and spine direction precisely. ` +
    `The skeleton uses colors: yellow=head, orange=right arm, blue=left arm, green=right leg, purple=left leg, white=spine, brown=staff, cyan=staff orb. ` +
    `Pose description: ${pose.promptHint}. ` +
    `${FRAMING} ` +
    `${WHITE_BG_PROMPT} ` +
    `${NO_SHADOW} ` +
    `${NO_TEXT}`
  );
}

function buildGeminiPromptWithSkeleton(pose: PoseKeypoints): string {
  return (
    `The first image is a chibi cat mage character reference (blue hooded cloak, magic staff with glowing orb). ` +
    `The second image is a COLOR-CODED POSE SKELETON: orange=right arm, blue=left arm, green=right leg, purple=left leg, white=spine, brown=staff. ` +
    `Redraw the cat mage character in the EXACT pose shown by the skeleton. ` +
    `Match the limb angles, elbow bends, wrist positions and leg stance from the skeleton precisely. ` +
    `Pose: ${pose.promptHint}. ` +
    `${FRAMING} ` +
    `${WHITE_BG_PROMPT} ` +
    `${NO_SHADOW} ` +
    `${NO_TEXT}`
  );
}

// ── 모델별 프레임 생성 ────────────────────────────────────────────────────────

type ModelLabel = "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini" | "gemini-2.5-flash-image";

async function generateFrameWithSkeleton(
  model: ModelLabel,
  charRef: { base64: string; mimeType: string; absPath: string },
  skeletonPath: string,
  pose: PoseKeypoints,
): Promise<{ base64: string; mimeType: string }> {
  if (model === "gemini-2.5-flash-image") {
    const skelBase64 = fs.readFileSync(skeletonPath).toString("base64");
    return editImageGemini({
      imageBase64: charRef.base64,
      imageMimeType: charRef.mimeType,
      editPrompt: buildGeminiPromptWithSkeleton(pose),
      model: "gemini-2.5-flash-image",
      referenceImages: [
        { base64: charRef.base64, mimeType: charRef.mimeType },
        { base64: skelBase64, mimeType: "image/png" },
      ],
    });
  } else {
    return editImageOpenAI({
      imagePaths: [charRef.absPath, skeletonPath],
      prompt: buildPromptWithSkeleton(pose),
      model,
      size: "1024x1024",
    });
  }
}

// ── 메인 ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n" + "═".repeat(70));
  console.log("  스켈레톤 가이드 스프라이트 시트 테스트");
  console.log("  캐릭터 참조 + OpenPose 스켈레톤 → 9프레임 마법봉 스윙");
  console.log("═".repeat(70));
  console.log(`  참조 이미지 : ${REF_PATH}`);
  console.log(`  프레임 수   : ${FRAME_COUNT}`);
  console.log(`  저장 경로   : ${OUT_DIR}`);
  console.log("═".repeat(70) + "\n");

  const charRef = readImageAsBase64(REF_PATH);
  ensureDir(OUT_DIR);

  // ── Step 1: 스켈레톤 PNG 9개 생성 ──────────────────────────────────────────
  const skelDir = path.resolve(OUT_DIR, "skeletons");
  ensureDir(skelDir);

  console.log("Step 1: 스켈레톤 PNG 생성 중...");
  const skeletonPaths: string[] = [];

  await Promise.all(
    WAND_SWING_POSES.map(async (pose, i) => {
      const buf = await generateSkeletonPng(pose, SKELETON_SIZE);
      const skelPath = path.join(skelDir, `${pose.label}.png`);
      fs.writeFileSync(skelPath, buf);
      skeletonPaths[i] = skelPath;
      process.stdout.write(`  ✅ ${pose.label}.png\n`);
    })
  );

  console.log(`\n  스켈레톤 저장: ${skelDir}\n`);

  // ── Step 2: 4개 모델 × 9프레임 병렬 생성 ───────────────────────────────────
  const MODELS: ModelLabel[] = [
    "gpt-image-1.5",
    "gpt-image-1",
    "gpt-image-1-mini",
    "gemini-2.5-flash-image",
  ];

  const sheetsDir = path.resolve(OUT_DIR, "sheets");
  ensureDir(sheetsDir);

  type FrameResult = { frameId: string; ok: boolean; ms: number; error?: string };
  type ModelSummary = {
    model: string;
    success: boolean;
    sheetPath?: string;
    totalMs?: number;
    frames?: FrameResult[];
    error?: string;
  };

  console.log("Step 2: 4모델 × 9프레임 병렬 생성 시작...\n");
  const totalStart = Date.now();

  const modelResults = await Promise.allSettled(
    MODELS.map(async (model): Promise<ModelSummary> => {
      const safeModel = model.replace(/[./]/g, "_");
      const frameDir = path.resolve(OUT_DIR, "frames", safeModel);
      ensureDir(frameDir);

      const modelStart = Date.now();

      const frameResults = await Promise.all(
        WAND_SWING_POSES.map(async (pose, i): Promise<FrameResult & { framePath: string | null }> => {
          const start = Date.now();
          try {
            const r = await generateFrameWithSkeleton(model, charRef, skeletonPaths[i], pose);
            const outPath = path.join(frameDir, `${pose.label}.png`);
            const saved = await postProcess(r.base64, outPath);
            const ms = Date.now() - start;
            process.stdout.write(`  [${model.padEnd(24)}] ✅ ${pose.label}  ${ms}ms\n`);
            return { frameId: pose.label, ok: true, ms, framePath: saved };
          } catch (err) {
            const ms = Date.now() - start;
            const error = err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80);
            process.stdout.write(`  [${model.padEnd(24)}] ❌ ${pose.label}  ${ms}ms  ${error}\n`);
            return { frameId: pose.label, ok: false, ms, error, framePath: null };
          }
        })
      );

      const totalMs = Date.now() - modelStart;

      const validFrames: FrameInfo[] = frameResults
        .filter(f => f.framePath !== null)
        .map((f, _) => ({
          name: `${model}_${f.frameId}`,
          filePath: f.framePath!,
          action: "wand_swing",
          frameIndex: WAND_SWING_POSES.findIndex(p => p.label === f.frameId),
        }))
        .sort((a, b) => a.frameIndex - b.frameIndex);

      if (validFrames.length === 0) {
        return { model, success: false, totalMs, error: "모든 프레임 생성 실패" };
      }

      const sheetPath = path.join(sheetsDir, `${safeModel}_skeleton_sheet.png`);
      await composeSpritSheet(validFrames, sheetPath, 4);

      return {
        model, success: true, sheetPath, totalMs,
        frames: frameResults.map(f => ({ frameId: f.frameId, ok: f.ok, ms: f.ms, error: f.error })),
      };
    })
  );

  const totalMs = Date.now() - totalStart;

  // ── 결과 출력 ────────────────────────────────────────────────────────────────
  const summaries: ModelSummary[] = modelResults.map((r, i) =>
    r.status === "fulfilled" ? r.value
      : { model: MODELS[i], success: false, error: String((r as PromiseRejectedResult).reason) }
  );

  console.log("\n" + "─".repeat(70));
  console.log("  최종 결과");
  console.log("─".repeat(70));

  for (const s of summaries) {
    const ok = s.success ? "✅" : "❌";
    const successCount = s.frames?.filter(f => f.ok).length ?? 0;
    const avgMs = s.frames && s.frames.length > 0
      ? Math.round(s.frames.reduce((a, f) => a + f.ms, 0) / s.frames.length)
      : 0;
    console.log(`\n  ${ok} ${s.model}`);
    if (s.success) {
      console.log(`     프레임 성공   : ${successCount}/${FRAME_COUNT}`);
      console.log(`     평균 프레임 ms: ${avgMs}ms`);
      console.log(`     총 생성 시간  : ${s.totalMs}ms`);
      if (s.sheetPath && fs.existsSync(s.sheetPath)) {
        const kb = Math.round(fs.statSync(s.sheetPath).size / 1024);
        console.log(`     시트 크기     : ${kb}KB`);
      }
      console.log(`     시트 경로     : ${s.sheetPath}`);
    } else {
      console.log(`     오류: ${s.error}`);
    }
  }

  console.log("\n" + "─".repeat(70));
  console.log(`  총 소요 시간: ${totalMs}ms (${(totalMs / 1000).toFixed(1)}초)`);

  const ranked = summaries
    .filter(s => s.success)
    .sort((a, b) => (b.frames?.filter(f => f.ok).length ?? 0) - (a.frames?.filter(f => f.ok).length ?? 0));

  if (ranked.length > 0) {
    console.log("\n  📊 결과 순위:");
    ranked.forEach((s, i) => {
      const n = s.frames?.filter(f => f.ok).length ?? 0;
      const avg = s.frames && s.frames.length > 0
        ? Math.round(s.frames.reduce((a, f) => a + f.ms, 0) / s.frames.length) : 0;
      console.log(`    #${i + 1}  ${s.model.padEnd(26)} ${n}/${FRAME_COUNT}프레임  평균 ${avg}ms/frame`);
    });
  }

  console.log(`\n  스켈레톤 시각화 : ${skelDir}`);
  console.log(`  스프라이트 시트 : ${sheetsDir}\n`);
}

main().catch(err => {
  console.error("\n❌ 치명적 오류:", err.message ?? err);
  process.exit(1);
});
