/**
 * 모델 비교 테스트 스크립트
 *
 * 사용법:
 *   npx tsx scripts/test-compare.ts [prompt] [옵션]
 *
 * 옵션:
 *   --quality low|medium|high    생성 품질 (기본: medium)
 *   --background transparent|opaque  배경 (기본: transparent)
 *   --gemini                     Gemini Imagen도 포함
 *   --models gpt-image-1.5,gpt-image-1,gpt-image-1-mini  비교 모델 지정
 *   --out <dir>                  저장 디렉토리 (기본: ./test-output)
 *
 * 예시:
 *   npx tsx scripts/test-compare.ts "chibi warrior character with sword"
 *   npx tsx scripts/test-compare.ts "magic fireball effect" --quality high --gemini
 *   npx tsx scripts/test-compare.ts "forest background" --models gpt-image-1.5,gpt-image-1 --background opaque
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";

// ── .env 로드 (존재 시) ───────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.resolve(__dirname, "../.env");
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf-8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = val;
  }
  console.log("✓ .env 로드됨");
}

// ── CLI 인수 파싱 ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

function getFlag(name: string): string | undefined {
  const idx = args.findIndex(a => a === name);
  return idx !== -1 ? args[idx + 1] : undefined;
}
function hasFlag(name: string): boolean {
  return args.includes(name);
}

// 첫 번째 비-플래그 인수가 프롬프트
const promptArg = args.find(a => !a.startsWith("--"));
const PROMPT = promptArg ?? "chibi cat mage character, holding a magic staff, full body, transparent background";

const QUALITY = (getFlag("--quality") ?? "medium") as "low" | "medium" | "high" | "auto";
const BACKGROUND = (getFlag("--background") ?? "transparent") as "transparent" | "opaque" | "auto";
const INCLUDE_GEMINI = hasFlag("--gemini");
const OUT_DIR = getFlag("--out") ?? "./test-output";
const MODELS_ARG = getFlag("--models");
const MODELS = (MODELS_ARG
  ? MODELS_ARG.split(",").map(m => m.trim())
  : ["gpt-image-1.5", "gpt-image-1", "gpt-image-1-mini"]) as Array<"gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini">;

// ── 서비스 임포트 (빌드된 dist 사용) ─────────────────────────────────────────
import { generateImageOpenAI } from "../src/services/openai.js";
import { generateImageGemini } from "../src/services/gemini.js";

// ── 유틸: 디렉토리 생성 ───────────────────────────────────────────────────────
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── 유틸: 결과 테이블 출력 ────────────────────────────────────────────────────
function printTable(results: ModelResult[]): void {
  const cols = ["모델", "상태", "시간(ms)", "크기(KB)", "파일 경로"];
  const rows = results.map(r => [
    r.model,
    r.success ? "✅ 성공" : "❌ 실패",
    r.generation_ms != null ? String(r.generation_ms) : "-",
    r.file_size_kb != null ? String(r.file_size_kb) : "-",
    r.file_path ?? r.error ?? "",
  ]);

  const widths = cols.map((c, i) =>
    Math.max(c.length, ...rows.map(r => r[i].length))
  );

  const line = widths.map(w => "─".repeat(w + 2)).join("┼");
  const header = cols.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│");

  console.log("┌" + line.replace(/┼/g, "┬") + "┐");
  console.log("│" + header + "│");
  console.log("├" + line + "┤");
  for (const row of rows) {
    console.log("│" + row.map((c, i) => ` ${c.padEnd(widths[i])} `).join("│") + "│");
  }
  console.log("└" + line.replace(/┼/g, "┴") + "┘");
}

// ── 타입 정의 ─────────────────────────────────────────────────────────────────
type ModelResult = {
  model: string;
  success: boolean;
  file_path?: string;
  generation_ms?: number;
  file_size_kb?: number;
  error?: string;
};

// ── 메인 실행 ─────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n" + "═".repeat(60));
  console.log("  모델 비교 테스트");
  console.log("═".repeat(60));
  console.log(`  프롬프트 : ${PROMPT}`);
  console.log(`  모델     : ${MODELS.join(", ")}${INCLUDE_GEMINI ? ", gemini-imagen" : ""}`);
  console.log(`  품질     : ${QUALITY}  배경: ${BACKGROUND}`);
  console.log(`  저장경로 : ${OUT_DIR}`);
  console.log("═".repeat(60) + "\n");

  const saveDir = path.resolve(OUT_DIR, "compare");
  ensureDir(saveDir);

  const batchId = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

  type TaskDef = { label: string; fn: () => Promise<{ base64: string; mimeType: string }> };

  const tasks: TaskDef[] = MODELS.map(model => ({
    label: model,
    fn: () => generateImageOpenAI({
      prompt: PROMPT,
      model,
      quality: QUALITY,
      background: BACKGROUND,
    }).then(r => ({ base64: r.base64, mimeType: r.mimeType })),
  }));

  if (INCLUDE_GEMINI) {
    tasks.push({
      label: "gemini-imagen",
      fn: () => generateImageGemini({ prompt: PROMPT, aspectRatio: "1:1" }),
    });
  }

  console.log(`병렬로 ${tasks.length}개 모델 동시 생성 중...\n`);

  const settled = await Promise.allSettled(
    tasks.map(async (task): Promise<ModelResult> => {
      process.stdout.write(`  [${task.label}] 생성 중...`);
      const start = Date.now();
      const r = await task.fn();
      const ms = Date.now() - start;

      const safeLabel = task.label.replace(/[^a-z0-9.-]/gi, "_");
      const fileName = `${safeLabel}_${batchId}.png`;
      const filePath = path.join(saveDir, fileName);
      fs.writeFileSync(filePath, Buffer.from(r.base64, "base64"));

      const stats = fs.statSync(filePath);
      const kb = Math.round(stats.size / 1024);
      process.stdout.write(` 완료 (${ms}ms, ${kb}KB)\n`);

      return { model: task.label, success: true, file_path: filePath, generation_ms: ms, file_size_kb: kb };
    })
  );

  const results: ModelResult[] = settled.map((s, i) =>
    s.status === "fulfilled"
      ? s.value
      : { model: tasks[i].label, success: false, error: s.reason instanceof Error ? s.reason.message : String(s.reason) }
  );

  console.log("\n" + "─".repeat(60));
  console.log("  결과 요약");
  console.log("─".repeat(60));
  printTable(results);

  const succeeded = results.filter(r => r.success);
  if (succeeded.length > 1) {
    const fastest = [...succeeded].sort((a, b) => (a.generation_ms ?? 0) - (b.generation_ms ?? 0))[0];
    const smallest = [...succeeded].sort((a, b) => (a.file_size_kb ?? 0) - (b.file_size_kb ?? 0))[0];
    console.log(`\n  🏆 가장 빠름  : ${fastest.model} (${fastest.generation_ms}ms)`);
    console.log(`  💾 가장 작음  : ${smallest.model} (${smallest.file_size_kb}KB)`);
  }

  console.log(`\n  저장 위치: ${saveDir}`);
  console.log(`  배치 ID : ${batchId}\n`);
}

main().catch(err => {
  console.error("\n❌ 오류:", err.message ?? err);
  process.exit(1);
});
