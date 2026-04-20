/**
 * 스켈레톤 액션 가이드 → Gemini 스프라이트 시트 생성 테스트
 *
 * 9개 스켈레톤을 하나의 가로 스트립 "액션 가이드"로 합쳐서
 * [캐릭터 참조] + [9프레임 스켈레톤 가이드] 두 장을 Gemini에 동시 전달합니다.
 * Gemini가 스켈레톤 포즈에 맞춰 9프레임 스프라이트 시트를 한 번에 생성합니다.
 *
 * 사용법:
 *   npx tsx scripts/test-sheet-guide.ts [reference_image]
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

// ── 인수 ──────────────────────────────────────────────────────────────────────
const DEFAULT_REF = "./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png";
const REF_PATH = process.argv.find(
  a => !a.startsWith("-") && a !== process.argv[0] && a !== process.argv[1]
) ?? DEFAULT_REF;
const OUT_DIR = "./test-output/sheet-guide";

// ── 임포트 ───────────────────────────────────────────────────────────────────
import { editImageGemini } from "../src/services/gemini.js";
import { generateSkeletonActionGuide, WAND_SWING_POSES } from "../src/utils/pose-skeleton.js";

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── 프롬프트 ─────────────────────────────────────────────────────────────────
const FRAME_LABELS = WAND_SWING_POSES.map((p, i) => `frame ${i + 1} = ${p.label.replace(/^f\d+_/, "")}`).join(", ");

const GEMINI_PROMPT = `You have two reference images:

**IMAGE 1 — CHARACTER REFERENCE**: A chibi cat mage wearing a blue hooded cloak with gold trim and a brown leather belt, holding a magic staff with a glowing blue orb at the top. This is the character design to reproduce exactly.

**IMAGE 2 — 9-FRAME ACTION GUIDE**: A horizontal strip of 9 skeleton poses numbered 1–9 from left to right (${FRAME_LABELS}). Each skeleton cell shows the body pose including arm angles, staff position, and leg stance for that animation frame.

**YOUR TASK**: Generate ONE SINGLE IMAGE — a 9-frame horizontal sprite sheet where:
- Frames are arranged in a SINGLE ROW, left to right, in the same sequence as the action guide (1 → 9)
- Each frame shows the cat mage character performing the EXACT body pose from the corresponding skeleton guide frame
- Pay special attention to: staff angle and direction, arm extension/bend, body lean
- The character's design (face, colors, outfit, staff) is IDENTICAL across all 9 frames
- Each frame has a pure white (#FFFFFF) background — no shadows, no gradients
- The character is FULLY VISIBLE head-to-feet in every frame, never cropped
- Frames are evenly sized, cleanly separated by thin lines
- NO text, NO labels, NO decorative borders inside the frames
- The resulting image should resemble a professional 2D game animation sprite sheet`;

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n" + "═".repeat(68));
  console.log("  스켈레톤 액션 가이드 → Gemini 스프라이트 시트 생성");
  console.log("═".repeat(68));
  console.log(`  참조 이미지 : ${REF_PATH}`);
  console.log(`  저장 경로   : ${OUT_DIR}`);
  console.log("═".repeat(68) + "\n");

  ensureDir(OUT_DIR);

  // ── Step 1: 캐릭터 참조 이미지 로드 ─────────────────────────────────────
  const refAbs = path.resolve(REF_PATH);
  if (!fs.existsSync(refAbs)) throw new Error(`참조 이미지 없음: ${refAbs}`);
  const charBase64 = fs.readFileSync(refAbs).toString("base64");
  console.log("✓ 캐릭터 참조 이미지 로드됨");

  // ── Step 2: 9프레임 스켈레톤 액션 가이드 생성 ────────────────────────────
  console.log("⏳ 스켈레톤 액션 가이드 생성 중...");
  const guideBuffer = await generateSkeletonActionGuide(WAND_SWING_POSES, 256, 3);
  const guidePath = path.join(OUT_DIR, "skeleton_action_guide.png");
  fs.writeFileSync(guidePath, guideBuffer);
  const guideBase64 = guideBuffer.toString("base64");

  const { width: guideW, height: guideH } = await (await import("sharp")).default(guideBuffer).metadata();
  console.log(`✓ 액션 가이드 저장: ${guidePath}  (${guideW}×${guideH}px)\n`);

  // ── Step 3: Gemini에 두 이미지 전달 → 스프라이트 시트 생성 ───────────────
  console.log("⏳ Gemini에 [캐릭터 참조 + 스켈레톤 가이드] 전달 중...");
  console.log("   모델: gemini-2.5-flash-image");
  console.log("   입력: 2장 (캐릭터 참조, 9프레임 스켈레톤 가이드)\n");

  const start = Date.now();

  const result = await editImageGemini({
    // referenceImages 배열에 두 이미지 모두 전달
    imageBase64: charBase64,        // fallback (referenceImages가 우선)
    imageMimeType: "image/png",
    editPrompt: GEMINI_PROMPT,
    model: "gemini-2.5-flash-image",
    referenceImages: [
      { base64: charBase64,  mimeType: "image/png" },  // [1] 캐릭터 참조
      { base64: guideBase64, mimeType: "image/png" },  // [2] 스켈레톤 가이드
    ],
  });

  const ms = Date.now() - start;
  console.log(`✅ Gemini 생성 완료  (${ms}ms)`);

  // ── Step 4: 결과 저장 ────────────────────────────────────────────────────
  const sheetPath = path.join(OUT_DIR, "gemini_sprite_sheet.png");
  fs.writeFileSync(sheetPath, Buffer.from(result.base64, "base64"));

  const { width: sheetW, height: sheetH } = await (await import("sharp")).default(sheetPath).metadata();
  const kb = Math.round(fs.statSync(sheetPath).size / 1024);

  console.log("\n" + "─".repeat(68));
  console.log("  결과");
  console.log("─".repeat(68));
  console.log(`  스켈레톤 가이드  : ${guidePath}  (${guideW}×${guideH})`);
  console.log(`  생성된 시트      : ${sheetPath}  (${sheetW}×${sheetH}, ${kb}KB)`);
  console.log(`  생성 시간        : ${ms}ms\n`);
}

main().catch(err => {
  console.error("\n❌ 오류:", err.message ?? err);
  process.exit(1);
});
