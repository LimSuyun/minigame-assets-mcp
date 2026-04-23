/**
 * 걷기(walk) 8-프레임 스프라이트 시트 — Gemini vs gpt-image-2 비교
 *
 * 절차:
 *   1) gpt-image-1 (투명 배경)으로 정면 베이스 캐릭터 1장 생성
 *   2) 그 베이스를 참조 이미지로 전달하여:
 *        - Gemini (gemini-2.5-flash-image) edit
 *        - OpenAI gpt-image-2 edit
 *      각각 8 프레임(walk cycle) 병렬 생성
 *   3) 각 프레임 흰 배경 flood-fill → 투명 PNG
 *   4) 4×2 스프라이트 시트 2장 합성, 타이밍/성공률 비교 출력
 *
 * 사용법:
 *   npx tsx scripts/test-walk-compare.ts
 *   npx tsx scripts/test-walk-compare.ts --ref ./test-output/some_existing_base.png
 *   npx tsx scripts/test-walk-compare.ts --character "chibi fox mage in purple robe"
 *
 * 산출물:
 *   test-output/walk-compare/
 *   ├─ base.png                                              (gpt-image-1 베이스)
 *   ├─ frames/{model}/f0{0..7}.png                           (투명 배경 프레임)
 *   └─ sheets/{model}_walk_sheet.png                         (4×2 스프라이트 시트)
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

// ── 서비스 / 유틸 임포트 ──────────────────────────────────────────────────────
import { generateImageOpenAI, editImageOpenAI } from "../src/services/openai.js";
import { editImageGemini } from "../src/services/gemini.js";
import { composeSpritSheet } from "../src/utils/spritesheet-composer.js";
import { processFrameBase64 } from "../src/utils/image-process.js";
import type { FrameInfo } from "../src/utils/spritesheet-composer.js";

// ── CLI 인수 파싱 ─────────────────────────────────────────────────────────────
function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const REF_OVERRIDE = parseArg("--ref");
const CHAR_DESC =
  parseArg("--character") ??
  "chibi boy adventurer — short stocky build, spiky brown hair, " +
    "red tunic with brown leather belt, dark green pants, brown boots, " +
    "empty hands, cute round face with big expressive eyes, facing camera, " +
    "standing neutral pose with both feet on the ground";

const OUT_DIR = path.resolve("./test-output/walk-compare");
const FRAME_COUNT = 8;
const GRID_COLS = 4;
const BASE_MODEL = "gpt-image-1" as const;

// ── 공통 프롬프트 조각 ────────────────────────────────────────────────────────
const WHITE_BG_PROMPT =
  "pure white (#FFFFFF) background — perfectly uniform solid white, " +
  "absolutely no gradients, no shadows, no texture on the background. " +
  "CRITICAL: the character itself must NOT contain any pure white (#FFFFFF) pixels — " +
  "use off-white or light cream (at most rgb(220,220,220)) for any light-colored areas on the character.";

const NO_SHADOW =
  "CRITICAL — NO SHADOWS: no drop shadow, no cast shadow, no ground shadow, no contact shadow.";

const NO_TEXT =
  "CRITICAL — NO TEXT: no letters, numbers, words, or writing anywhere in the image.";

const CHIBI_STYLE =
  "chibi art style: large round head (~1/3 body height), short stubby limbs, " +
  "big expressive eyes, vibrant saturated colors, thick 2-3px black outlines, flat cel-shading.";

// ── 8-프레임 걷기 사이클 (측면, 오른쪽을 향한 상태) ────────────────────────────
/**
 * 정통 2D 걷기 사이클 키포즈 (side-view, facing right):
 *  f00 contact R    : 오른발이 앞에 막 착지, 왼발은 뒤 끝점
 *  f01 down R       : 오른발 체중 지지, 몸통 최저점, 왼발 들리며 앞으로
 *  f02 passing      : 두 다리 수직으로 교차, 몸통 상승 중
 *  f03 high R       : 오른발로 밀어내며 몸통 최고점, 왼발 앞으로 뻗음
 *  f04 contact L    : 왼발이 앞에 막 착지 (f00의 거울상)
 *  f05 down L       : 왼발 체중 지지, 몸통 최저점 (f01 거울상)
 *  f06 passing 2    : 두 다리 교차, 몸통 상승 (f02 거울상)
 *  f07 high L       : 왼발로 밀어내며 최고점, 오른발 앞으로 뻗음
 * 팔은 다리와 반대 방향으로 스윙.
 */
const WALK_FRAMES: Array<{ id: string; name: string; pose: string }> = [
  {
    id: "f00",
    name: "contact_right",
    pose:
      "walking — side view facing right, RIGHT FOOT just landing forward with heel touching the ground, " +
      "LEFT FOOT fully extended behind at the toe-off position, " +
      "LEFT ARM swinging forward at waist height, RIGHT ARM swinging back, " +
      "body upright, weight transferring onto right foot",
  },
  {
    id: "f01",
    name: "down_right",
    pose:
      "walking — side view facing right, RIGHT FOOT flat on the ground supporting full body weight, " +
      "LEFT LEG lifted and swinging forward, knee bent, foot clearing the ground, " +
      "torso at the LOWEST point of the cycle (slightly compressed), " +
      "LEFT ARM pulling back slightly, RIGHT ARM swinging forward",
  },
  {
    id: "f02",
    name: "passing_1",
    pose:
      "walking — side view facing right, BOTH LEGS passing each other vertically, " +
      "RIGHT LEG straight supporting the body, LEFT LEG passing through vertically with knee slightly bent, " +
      "torso rising up from the low point, arms passing through vertical (close to the body)",
  },
  {
    id: "f03",
    name: "high_right",
    pose:
      "walking — side view facing right, LEFT LEG extending forward ready to land, heel leading, " +
      "RIGHT LEG pushing off from toes behind, nearly straight, " +
      "torso at the HIGHEST point of the cycle, " +
      "RIGHT ARM swinging forward, LEFT ARM swinging back",
  },
  {
    id: "f04",
    name: "contact_left",
    pose:
      "walking — side view facing right, LEFT FOOT just landing forward with heel touching the ground, " +
      "RIGHT FOOT fully extended behind at the toe-off position, " +
      "RIGHT ARM swinging forward at waist height, LEFT ARM swinging back, " +
      "body upright, weight transferring onto left foot",
  },
  {
    id: "f05",
    name: "down_left",
    pose:
      "walking — side view facing right, LEFT FOOT flat on the ground supporting full body weight, " +
      "RIGHT LEG lifted and swinging forward, knee bent, foot clearing the ground, " +
      "torso at the LOWEST point of the cycle, " +
      "RIGHT ARM pulling back slightly, LEFT ARM swinging forward",
  },
  {
    id: "f06",
    name: "passing_2",
    pose:
      "walking — side view facing right, BOTH LEGS passing each other vertically, " +
      "LEFT LEG straight supporting the body, RIGHT LEG passing through vertically with knee slightly bent, " +
      "torso rising up from the low point, arms passing through vertical",
  },
  {
    id: "f07",
    name: "high_left",
    pose:
      "walking — side view facing right, RIGHT LEG extending forward ready to land, heel leading, " +
      "LEFT LEG pushing off from toes behind, nearly straight, " +
      "torso at the HIGHEST point of the cycle, " +
      "LEFT ARM swinging forward, RIGHT ARM swinging back",
  },
];

// ── 프롬프트 빌더 ─────────────────────────────────────────────────────────────
function buildBasePrompt(charDesc: string): string {
  return (
    `${charDesc}. ` +
    `Full body from the top of the head to the tips of the feet must be fully visible. ` +
    `Character stands upright, front-facing (camera view), arms relaxed at sides, both feet on the ground. ` +
    `Character occupies no more than 70% of the image height with at least 15% empty margin on all sides. ` +
    `${CHIBI_STYLE} ` +
    `transparent background. ${NO_SHADOW} ${NO_TEXT}`
  );
}

function buildEditPromptOpenAI(pose: string): string {
  return (
    `Redraw this exact character in the following pose: ${pose}. ` +
    `Preserve every visual detail from the reference image — ` +
    `same face, same body proportions, same outfit and colors, same accessories. ` +
    `Only the pose changes. Nothing is added or removed. ` +
    `CRITICAL FRAMING: the ENTIRE body from the very top of the head to the very tips of the feet MUST be fully visible. ` +
    `Never clip or cut off any body part. If the pose requires more room, make the character SMALLER — do NOT crop. ` +
    `Character must not exceed 70% of image height; leave ≥15% margin on all sides. ` +
    `${WHITE_BG_PROMPT} ${NO_SHADOW} ${NO_TEXT}`
  );
}

function buildEditPromptGemini(pose: string, charDesc: string): string {
  return (
    `This is a ${charDesc}. ` +
    `Redraw this exact character in the following walk-cycle pose: ${pose}. ` +
    `Keep the exact same character design, colors, and chibi art style. ` +
    `CRITICAL: full body from head to feet must be visible, character no taller than 70% of image, margin ≥15% on all sides. ` +
    `${WHITE_BG_PROMPT} ${NO_SHADOW} ${NO_TEXT}`
  );
}

// ── 유틸 ──────────────────────────────────────────────────────────────────────
function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

async function postProcessFrame(base64: string, framePath: string): Promise<void> {
  const buf = await processFrameBase64(base64, 245);
  fs.writeFileSync(framePath, buf);
}

function readRef(refPath: string): { base64: string; mimeType: string; absPath: string } {
  const absPath = path.resolve(refPath);
  if (!fs.existsSync(absPath)) throw new Error(`참조 이미지 없음: ${absPath}`);
  const base64 = fs.readFileSync(absPath).toString("base64");
  const ext = path.extname(absPath).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" : ext === ".webp" ? "image/webp" : "image/png";
  return { base64, mimeType, absPath };
}

// ── 베이스 생성 ───────────────────────────────────────────────────────────────
async function generateBase(outDir: string): Promise<string> {
  const basePath = path.join(outDir, "base.png");
  ensureDir(outDir);

  console.log(`\n[1/3] 베이스 캐릭터 생성 중 (모델: ${BASE_MODEL}, 투명 배경)...`);
  const t0 = Date.now();
  const res = await generateImageOpenAI({
    prompt: buildBasePrompt(CHAR_DESC),
    model: BASE_MODEL,
    size: "1024x1024",
    quality: "high",
    background: "transparent",
  });
  fs.writeFileSync(basePath, Buffer.from(res.base64, "base64"));
  console.log(`  ✓ ${basePath}  (${Date.now() - t0}ms)`);
  return basePath;
}

// ── 모델별 프레임 생성 ────────────────────────────────────────────────────────
type ModelLabel = "gemini-2.5-flash-image" | "gpt-image-2";

async function generateWalkFrames(
  model: ModelLabel,
  ref: { base64: string; mimeType: string; absPath: string },
  frameDir: string,
  onFrame: (frameId: string, ok: boolean, ms: number, err?: string) => void,
): Promise<Array<{ frameId: string; framePath: string | null; ms: number; error?: string }>> {
  ensureDir(frameDir);

  const tasks = WALK_FRAMES.map(async (def) => {
    const start = Date.now();
    const framePath = path.join(frameDir, `${def.id}.png`);
    try {
      let base64: string;

      if (model === "gemini-2.5-flash-image") {
        const r = await editImageGemini({
          imageBase64: ref.base64,
          imageMimeType: ref.mimeType,
          editPrompt: buildEditPromptGemini(def.pose, CHAR_DESC),
          model: "gemini-2.5-flash-image",
        });
        base64 = r.base64;
      } else {
        // gpt-image-2 — edits endpoint는 background 파라미터 미지원.
        // 프롬프트에 WHITE_BG 명시 후 flood-fill 후처리로 투명 PNG 화.
        const r = await editImageOpenAI({
          imagePath: ref.absPath,
          prompt: buildEditPromptOpenAI(def.pose),
          model: "gpt-image-2",
          size: "1024x1024",
        });
        base64 = r.base64;
      }

      await postProcessFrame(base64, framePath);
      const ms = Date.now() - start;
      onFrame(def.id, true, ms);
      return { frameId: def.id, framePath, ms };
    } catch (err) {
      const ms = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);
      onFrame(def.id, false, ms, error);
      return { frameId: def.id, framePath: null, ms, error };
    }
  });

  return Promise.all(tasks);
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n" + "═".repeat(72));
  console.log("  걷기 8-프레임 스프라이트 시트 — Gemini vs gpt-image-2 비교");
  console.log("═".repeat(72));
  console.log(`  캐릭터   : ${CHAR_DESC.slice(0, 70)}${CHAR_DESC.length > 70 ? "…" : ""}`);
  console.log(`  베이스   : ${BASE_MODEL} (투명 배경)`);
  console.log(`  비교     : gemini-2.5-flash-image  |  gpt-image-2`);
  console.log(`  프레임   : ${FRAME_COUNT}개 (${GRID_COLS}×${FRAME_COUNT / GRID_COLS} 그리드)`);
  console.log(`  출력     : ${OUT_DIR}`);
  console.log("═".repeat(72));

  ensureDir(OUT_DIR);
  ensureDir(path.join(OUT_DIR, "sheets"));

  // 1) 베이스 이미지 준비
  let basePath: string;
  if (REF_OVERRIDE) {
    basePath = path.resolve(REF_OVERRIDE);
    if (!fs.existsSync(basePath)) throw new Error(`--ref 경로 없음: ${basePath}`);
    console.log(`\n[1/3] 베이스 이미지 재사용: ${basePath}`);
  } else {
    basePath = await generateBase(OUT_DIR);
  }

  const ref = readRef(basePath);

  // 2) 두 모델 병렬 생성
  console.log(`\n[2/3] 두 모델 × ${FRAME_COUNT}프레임 병렬 편집 생성...`);
  const progress: Record<ModelLabel, Record<string, { ok: boolean; ms: number }>> = {
    "gemini-2.5-flash-image": {},
    "gpt-image-2": {},
  };

  function onFrame(model: ModelLabel): (frameId: string, ok: boolean, ms: number, err?: string) => void {
    return (frameId, ok, ms, err) => {
      progress[model][frameId] = { ok, ms };
      const done = Object.keys(progress[model]).length;
      const symbol = ok ? "✅" : "❌";
      const errMsg = err ? `  — ${err.slice(0, 60)}` : "";
      process.stdout.write(
        `  [${model.padEnd(24)}] ${symbol} ${frameId}  ${String(ms).padStart(5)}ms  (${done}/${FRAME_COUNT})${errMsg}\n`,
      );
    };
  }

  const totalStart = Date.now();
  const [geminiFrames, gpt2Frames] = await Promise.all([
    generateWalkFrames(
      "gemini-2.5-flash-image",
      ref,
      path.join(OUT_DIR, "frames", "gemini-2.5-flash-image"),
      onFrame("gemini-2.5-flash-image"),
    ),
    generateWalkFrames(
      "gpt-image-2",
      ref,
      path.join(OUT_DIR, "frames", "gpt-image-2"),
      onFrame("gpt-image-2"),
    ),
  ]);
  const totalMs = Date.now() - totalStart;

  // 3) 스프라이트 시트 합성
  console.log(`\n[3/3] 스프라이트 시트 합성 (${GRID_COLS}×${FRAME_COUNT / GRID_COLS})...`);
  type Summary = {
    model: ModelLabel;
    successCount: number;
    sheetPath?: string;
    sheetKB?: number;
    avgMs: number;
    maxMs: number;
  };

  async function composeSheet(
    model: ModelLabel,
    frames: Array<{ frameId: string; framePath: string | null; ms: number }>,
  ): Promise<Summary> {
    const valid: FrameInfo[] = frames
      .filter((f) => f.framePath !== null)
      .map((f) => ({
        name: `${model}_${f.frameId}`,
        filePath: f.framePath!,
        action: "walk",
        frameIndex: WALK_FRAMES.findIndex((d) => d.id === f.frameId),
      }))
      .sort((a, b) => a.frameIndex - b.frameIndex);

    const avgMs = Math.round(frames.reduce((a, f) => a + f.ms, 0) / frames.length);
    const maxMs = Math.max(...frames.map((f) => f.ms));

    if (valid.length === 0) {
      return { model, successCount: 0, avgMs, maxMs };
    }

    const sheetPath = path.join(OUT_DIR, "sheets", `${model}_walk_sheet.png`);
    await composeSpritSheet(valid, sheetPath, 4);
    const sheetKB = Math.round(fs.statSync(sheetPath).size / 1024);
    console.log(`  ✓ ${model.padEnd(24)} → ${sheetPath}  (${sheetKB}KB, ${valid.length}/${FRAME_COUNT} 프레임)`);
    return { model, successCount: valid.length, sheetPath, sheetKB, avgMs, maxMs };
  }

  const summaries: Summary[] = [
    await composeSheet("gemini-2.5-flash-image", geminiFrames),
    await composeSheet("gpt-image-2", gpt2Frames),
  ];

  // ── 최종 결과 표 ────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(72));
  console.log("  비교 요약");
  console.log("─".repeat(72));
  console.log(
    `  ${"model".padEnd(26)} ${"success".padStart(9)}  ${"avg ms".padStart(8)}  ${"max ms".padStart(8)}  ${"sheet KB".padStart(9)}`,
  );
  for (const s of summaries) {
    console.log(
      `  ${s.model.padEnd(26)} ${`${s.successCount}/${FRAME_COUNT}`.padStart(9)}  ` +
        `${String(s.avgMs).padStart(8)}  ${String(s.maxMs).padStart(8)}  ` +
        `${String(s.sheetKB ?? "-").padStart(9)}`,
    );
  }
  console.log("─".repeat(72));
  console.log(`  총 소요: ${totalMs}ms (${(totalMs / 1000).toFixed(1)}초)`);
  console.log(`\n  베이스    : ${basePath}`);
  console.log(`  시트 폴더 : ${path.join(OUT_DIR, "sheets")}`);
  console.log(`  프레임 폴더: ${path.join(OUT_DIR, "frames")}`);
  console.log("");

  // 실패 프레임이 있으면 에러 메시지 요약
  const failures: Array<{ model: string; frameId: string; error: string }> = [];
  for (const f of geminiFrames) {
    if (!f.framePath && f.error)
      failures.push({ model: "gemini-2.5-flash-image", frameId: f.frameId, error: f.error });
  }
  for (const f of gpt2Frames) {
    if (!f.framePath && f.error)
      failures.push({ model: "gpt-image-2", frameId: f.frameId, error: f.error });
  }
  if (failures.length > 0) {
    console.log("  ⚠️  실패한 프레임:");
    for (const f of failures) console.log(`    [${f.model}] ${f.frameId}: ${f.error.slice(0, 100)}`);
  }
}

main().catch((err) => {
  console.error("\n❌ 치명적 오류:", err instanceof Error ? err.message : err);
  process.exit(1);
});
