/**
 * gpt-image-2 로 베이스 캐릭터 생성 (투명 배경).
 *
 * gpt-image-2 는 background: "transparent" 를 지원하지 않으므로,
 * 마젠타(#FF00FF) 크로마키 방식으로 우회한다:
 *   1) 프롬프트에 "solid magenta background" 명시
 *   2) background 파라미터는 shim 에 의해 "auto" 로 자동 강등
 *   3) 생성된 raw PNG 를 removeBackground(chromaKey=마젠타)로 투명화
 *
 * 산출물:
 *   test-output/walk-compare/base.png           (투명 배경, 최종)
 *   test-output/walk-compare/base_gpt2_raw.png  (마젠타 원본, 디버그용)
 *
 * 사용법:
 *   npx tsx scripts/test-gen-base-gpt2.ts
 *   npx tsx scripts/test-gen-base-gpt2.ts --character "chibi fox mage in purple robe"
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

import { generateImageOpenAI } from "../src/services/openai.js";
import { removeBackground } from "../src/utils/image-process.js";

// ── CLI ───────────────────────────────────────────────────────────────────────
function parseArg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : undefined;
}

const CHAR_DESC =
  parseArg("--character") ??
  "chibi boy adventurer — short stocky build, spiky brown hair, " +
    "red tunic with brown leather belt, dark green pants, brown boots, " +
    "empty hands, cute round face with big expressive eyes, facing camera, " +
    "standing neutral pose with both feet on the ground";

const OUT_DIR = path.resolve("./test-output/walk-compare");
const RAW_PATH = path.join(OUT_DIR, "base_gpt2_raw.png");
const FINAL_PATH = path.join(OUT_DIR, "base.png");

// ── 프롬프트 조각 ─────────────────────────────────────────────────────────────
const CHIBI_STYLE =
  "chibi art style: large round head (~1/3 body height), short stubby limbs, " +
  "big expressive eyes, vibrant saturated colors, thick 2-3px black outlines, flat cel-shading.";

const MAGENTA_BG_PROMPT =
  "Background MUST be a perfectly uniform, solid, flat pure magenta (#FF00FF, hex FF00FF) color — " +
  "no gradients, no shadows, no texture, no scene elements, no other colors anywhere in the background. " +
  "CRITICAL: the character itself must NOT contain any magenta, pink, hot-pink, or fuchsia pixels — " +
  "use only natural character colors (browns, reds, greens, skin tones). " +
  "The magenta is ONLY the background; the character is on top of it fully visible.";

const NO_SHADOW =
  "CRITICAL — NO SHADOWS on the character: no drop shadow, no cast shadow, no ground shadow.";

const NO_TEXT =
  "CRITICAL — NO TEXT: no letters, numbers, words, or writing anywhere in the image.";

function buildBasePrompt(charDesc: string): string {
  return (
    `${charDesc}. ` +
    `Full body from the top of the head to the tips of the feet must be fully visible. ` +
    `Character stands upright, front-facing (camera view), arms relaxed at sides, both feet on the ground. ` +
    `Character occupies no more than 70% of the image height with at least 15% empty margin on all sides. ` +
    `${CHIBI_STYLE} ${MAGENTA_BG_PROMPT} ${NO_SHADOW} ${NO_TEXT}`
  );
}

// ── 메인 ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n" + "═".repeat(72));
  console.log("  gpt-image-2 베이스 캐릭터 생성 (마젠타 크로마키 → 투명)");
  console.log("═".repeat(72));
  console.log(`  캐릭터 : ${CHAR_DESC.slice(0, 68)}${CHAR_DESC.length > 68 ? "…" : ""}`);
  console.log(`  모델   : gpt-image-2 (1024×1024, quality=high)`);
  console.log(`  투명화 : 마젠타 #FF00FF chroma key`);
  console.log("═".repeat(72));

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const t0 = Date.now();
  console.log(`\n[1/2] gpt-image-2 이미지 생성 요청 중...`);
  const res = await generateImageOpenAI({
    prompt: buildBasePrompt(CHAR_DESC),
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "high",
    // background: "transparent" 요청해도 shim 이 auto 로 강등함.
    // 프롬프트로 마젠타를 유도하는 것이 더 결정적이므로 명시적 전달은 생략.
  });
  const genMs = Date.now() - t0;
  fs.writeFileSync(RAW_PATH, Buffer.from(res.base64, "base64"));
  console.log(`  ✓ raw 저장: ${RAW_PATH}  (${genMs}ms)`);

  const t1 = Date.now();
  console.log(`\n[2/2] 마젠타 배경 크로마키 제거 + crop-to-content...`);
  await removeBackground(RAW_PATH, FINAL_PATH, {
    chromaKeyColor: [255, 0, 255],
    cropToContent: true,
  });
  const postMs = Date.now() - t1;
  const finalSize = Math.round(fs.statSync(FINAL_PATH).size / 1024);
  console.log(`  ✓ 최종 저장: ${FINAL_PATH}  (${postMs}ms, ${finalSize}KB)`);

  console.log("\n" + "─".repeat(72));
  console.log(`  총 소요: ${Date.now() - t0}ms (생성 ${genMs}ms + 후처리 ${postMs}ms)`);
  console.log(`  raw (디버그) : ${RAW_PATH}`);
  console.log(`  최종 (투명)  : ${FINAL_PATH}`);
  console.log(`\n  다음 단계: 이 베이스로 walk 비교 재실행`);
  console.log(`    npx tsx scripts/test-walk-compare.ts --ref ${FINAL_PATH}`);
  console.log("");
}

main().catch((err) => {
  console.error("\n❌ 실패:", err instanceof Error ? err.message : err);
  process.exit(1);
});
