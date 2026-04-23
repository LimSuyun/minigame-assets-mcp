/**
 * 스켈레톤 액션 가이드 → Gemini 스프라이트 시트 생성 + 후처리
 *
 * [캐릭터 참조] + [9프레임 스켈레톤 가이드] 두 장을 Gemini에 동시 전달.
 * 생성된 시트를 프레임 분할 → 배경 제거 → 균일 크기 정규화 → 투명 PNG로 출력.
 *
 * 사용법:
 *   npx tsx scripts/test-sheet-guide.ts [reference_image] [--frames N] [--canvas N]
 *
 * 기본값:
 *   reference : ./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png
 *   --frames  : 9  (Gemini에 요청할 프레임 수, 자동 분할에도 사용)
 *   --canvas  : 256 (최종 각 프레임 캔버스 크기 px)
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import sharpLib from "sharp";

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

// ── 인수 파싱 ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getFlag = (name: string, fallback: number) => {
  const i = args.findIndex(a => a === name);
  return i !== -1 ? parseInt(args[i + 1] ?? String(fallback), 10) : fallback;
};
const DEFAULT_REF = "./test-output/compare/gpt-image-1-mini_2026-04-20T06-07-12.png";
const REF_PATH = args.find(a => !a.startsWith("--") && !/^\d+$/.test(a)) ?? DEFAULT_REF;
const FRAME_COUNT  = getFlag("--frames", 9);
const CANVAS_SIZE  = getFlag("--canvas", 256);
const OUT_DIR = "./test-output/sheet-guide";

// ── 임포트 ───────────────────────────────────────────────────────────────────
import { editImageGemini } from "../src/services/gemini.js";
import { generateSkeletonActionGuide, WAND_SWING_POSES } from "../src/utils/pose-skeleton.js";
import { processFrameBase64 } from "../src/utils/image-process.js";

// ── 유틸 ─────────────────────────────────────────────────────────────────────
function ensureDir(d: string): void {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── 후처리: 생성된 시트를 균일·투명 프레임으로 변환 ────────────────────────────

/**
 * 어두운 수직 구분선을 픽셀 스캔으로 감지합니다.
 * 실제 구분선: 열 전체가 어두운 회색 → darkRatio 높음 (>0.65)
 * 캐릭터 윤곽: 일부만 어두움 → darkRatio 낮음
 */
async function detectSeparatorColumns(
  sheetBuf: Buffer,
  darknessThreshold = 160,  // 이 값 미만이면 "어두운" 픽셀
  darkRatio = 0.65,          // 열의 이 비율 이상이 어두워야 구분선
): Promise<number[]> {
  const { data, info } = await sharpLib(sheetBuf)
    .flatten({ background: { r: 255, g: 255, b: 255 } })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height, channels } = info;
  const separatorCols: number[] = [];

  for (let x = 0; x < width; x++) {
    let darkCount = 0;
    for (let y = 0; y < height; y++) {
      const idx = (y * width + x) * channels;
      const brightness = (data[idx] + data[idx + 1] + data[idx + 2]) / 3;
      if (brightness < darknessThreshold) darkCount++;
    }
    if (darkCount / height >= darkRatio) separatorCols.push(x);
  }

  // 인접한 열들을 하나의 구분선 중심으로 병합 (최대 6px 간격)
  const merged: number[] = [];
  let i = 0;
  while (i < separatorCols.length) {
    let j = i;
    while (j < separatorCols.length - 1 && separatorCols[j + 1] <= separatorCols[j] + 6) j++;
    merged.push(Math.floor((separatorCols[i] + separatorCols[j]) / 2));
    i = j + 1;
  }
  return merged;
}

/**
 * 후보 구분선 중 frameCount-1개를 가장 균등 간격 기준으로 선택합니다.
 * totalWidth를 frameCount등분했을 때의 이상적 위치와의 거리 합이 최소인 조합을 선택.
 * 후보가 많지 않은 경우(<=16)에만 완전 탐색, 그 외엔 그리디.
 */
function selectBestSeparators(candidates: number[], frameCount: number, totalWidth: number): number[] {
  const need = frameCount - 1;
  if (candidates.length === need) return candidates;
  if (candidates.length < need) return candidates; // 부족 시 그대로 반환 (fallback에서 처리)

  // 이상적 구분선 위치
  const idealStep = totalWidth / frameCount;
  const ideal = Array.from({ length: need }, (_, i) => idealStep * (i + 1));

  // 그리디: 각 이상 위치에 가장 가까운 후보 선택 (중복 없이)
  const used = new Set<number>();
  const selected: number[] = [];
  for (const pos of ideal) {
    let best = -1;
    let bestDist = Infinity;
    for (let ci = 0; ci < candidates.length; ci++) {
      if (used.has(ci)) continue;
      const d = Math.abs(candidates[ci] - pos);
      if (d < bestDist) { bestDist = d; best = ci; }
    }
    if (best !== -1) { used.add(best); selected.push(candidates[best]); }
  }
  return selected.sort((a, b) => a - b);
}

/**
 * 가로 스프라이트 시트를 프레임으로 분할합니다.
 * 1) 어두운 수직 구분선 자동 감지 → 정확한 분할
 * 2) 구분선이 충분하지 않으면 N등분 fallback
 */
async function splitSheetIntoFrames(
  sheetBuf: Buffer,
  frameCount: number,
): Promise<Buffer[]> {
  const meta = await sharpLib(sheetBuf).metadata();
  const totalW = meta.width!;
  const totalH = meta.height!;

  // 구분선 감지 시도
  const separators = await detectSeparatorColumns(sheetBuf);
  console.log(`  구분선 감지: ${separators.length}개 → [${separators.join(", ")}]`);

  let cutPoints: number[]; // 각 프레임의 left x 좌표 + 끝점

  // 가장자리 테두리 필터: 이상적 프레임 폭의 30% 이내 가장자리는 제외
  const minFrameW = totalW / frameCount;
  const filtered = separators.filter(x => x > minFrameW * 0.3 && x < totalW - minFrameW * 0.3);
  console.log(`  가장자리 필터 후: ${filtered.length}개 → [${filtered.join(", ")}]`);

  let actualFrameCount: number;

  if (filtered.length >= frameCount - 1) {
    // 요청한 frameCount에 맞게 best N-1개 선택
    const selected = selectBestSeparators(filtered, frameCount, totalW);
    console.log(`  선택된 구분선 (${selected.length}개): [${selected.join(", ")}]`);
    cutPoints = [0, ...selected.map(s => s + 1), totalW];
    actualFrameCount = frameCount;
  } else if (filtered.length > 0) {
    // 감지된 구분선 수로 실제 프레임 수 결정 (Gemini가 적게 생성한 경우)
    cutPoints = [0, ...filtered.map(s => s + 1), totalW];
    actualFrameCount = filtered.length + 1;
    console.log(`  ⚠ 구분선 ${filtered.length}개 감지 → 실제 ${actualFrameCount}프레임으로 처리`);
  } else {
    // 구분선 없음: 균등 분할 fallback
    console.log(`  ⚠ 구분선 미감지 → ${frameCount}등분 fallback`);
    const fw = Math.floor(totalW / frameCount);
    cutPoints = Array.from({ length: frameCount + 1 }, (_, i) =>
      i === frameCount ? totalW : i * fw
    );
    actualFrameCount = frameCount;
  }

  return Promise.all(
    Array.from({ length: actualFrameCount }, (_, i) => {
      const left  = cutPoints[i];
      const width = cutPoints[i + 1] - left;
      return sharpLib(sheetBuf)
        .extract({ left, top: 0, width: Math.max(1, width), height: totalH })
        .png()
        .toBuffer();
    })
  );
}

/**
 * 흰 배경을 flood-fill로 제거하고 콘텐츠 영역에 꽉 차게 자릅니다.
 * 배경 제거 실패(완전 투명) 시 null을 반환합니다.
 */
async function removeBgAndCrop(buf: Buffer, threshold = 250): Promise<Buffer | null> {
  try {
    const base64 = buf.toString("base64");
    const result = await processFrameBase64(base64, threshold);
    const meta = await sharpLib(result).metadata();
    if (!meta.width || !meta.height || meta.width < 8 || meta.height < 8) return null;
    return result;
  } catch {
    return null;
  }
}

/**
 * 모든 프레임에 동일한 스케일을 적용해 균일 크기 투명 캔버스에 배치합니다.
 *
 * - 스케일 결정: 가장 큰 프레임이 (canvasSize - 마진) 안에 딱 맞도록 계산
 * - 정렬: bottom-center (baseline anchor) — 발 위치가 모든 프레임에서 동일
 * - 빈 프레임(null)은 빈 투명 캔버스로 채웁니다
 */
async function normalizeUniformScale(
  frames: Array<Buffer | null>,
  canvasSize = 256,
  hMargin    = 10,   // 좌우 마진 (각각)
  topMargin  = 10,   // 상단 마진
  botMargin  = 14,   // 하단 마진 (발 위치 고정용)
): Promise<Buffer[]> {
  // 유효 프레임의 치수 수집
  const metas = await Promise.all(
    frames.map(f => f ? sharpLib(f).metadata() : Promise.resolve(null))
  );

  const validWidths  = metas.filter(Boolean).map(m => m!.width  ?? 0);
  const validHeights = metas.filter(Boolean).map(m => m!.height ?? 0);

  if (validWidths.length === 0) return frames.map(() => makeEmptyCanvas(canvasSize));

  const maxW = Math.max(...validWidths);
  const maxH = Math.max(...validHeights);

  // 가장 큰 프레임이 콘텐츠 영역 안에 정확히 들어오는 단일 스케일
  const availW = canvasSize - hMargin * 2;
  const availH = canvasSize - topMargin - botMargin;
  const scale  = Math.min(availW / maxW, availH / maxH);

  return Promise.all(
    frames.map(async (frame, _i) => {
      if (!frame) return makeEmptyCanvas(canvasSize);

      const meta = metas[_i];
      if (!meta?.width || !meta.height) return makeEmptyCanvas(canvasSize);

      const newW = Math.max(1, Math.round(meta.width  * scale));
      const newH = Math.max(1, Math.round(meta.height * scale));

      const resized = await sharpLib(frame)
        .resize(newW, newH, { fit: "fill", kernel: "lanczos3" })
        .png()
        .toBuffer();

      // bottom-center 정렬
      const left = Math.max(0, Math.floor((canvasSize - newW) / 2));
      const top  = Math.max(0, canvasSize - newH - botMargin);

      return sharpLib({
        create: {
          width: canvasSize, height: canvasSize,
          channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 },
        },
      })
        .composite([{ input: resized, left, top }])
        .png()
        .toBuffer();
    })
  );
}

function makeEmptyCanvas(size: number): Promise<Buffer> {
  return sharpLib({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  }).png().toBuffer();
}

/**
 * 정규화된 프레임 Buffer 배열을 가로 스프라이트 시트 PNG로 합성해 저장합니다.
 * 배경은 완전 투명입니다.
 */
async function composeFinalSheet(
  frames: Buffer[],
  outputPath: string,
  padding = 2,
): Promise<{ width: number; height: number }> {
  const meta = await sharpLib(frames[0]).metadata();
  const fw = meta.width!;
  const fh = meta.height!;
  const totalW = frames.length * fw + (frames.length - 1) * padding;

  await sharpLib({
    create: { width: totalW, height: fh, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(frames.map((buf, i) => ({ input: buf, left: i * (fw + padding), top: 0 })))
    .png()
    .toFile(outputPath);

  return { width: totalW, height: fh };
}

// ── Gemini 프롬프트 ──────────────────────────────────────────────────────────
const FRAME_LABELS = WAND_SWING_POSES.map((p, i) =>
  `frame ${i + 1}=${p.label.replace(/^f\d+_/, "")}`
).join(", ");

function buildGeminiPrompt(frameCount: number): string {
  return `You have two reference images:

**IMAGE 1 — CHARACTER REFERENCE**: A chibi cat mage with a blue hooded cloak (gold trim), brown leather belt, holding a magic staff with a glowing blue orb. Reproduce this design EXACTLY — same face, same colors, same proportions in every frame.

**IMAGE 2 — ACTION GUIDE**: A horizontal strip with EXACTLY ${frameCount} skeleton cells numbered 1 through ${frameCount}, left to right: ${FRAME_LABELS}. Each cell shows the required body pose for that frame.

**YOUR TASK**: Draw the character in EXACTLY ${frameCount} different poses following the skeletons.

**STRICT OUTPUT FORMAT**:
- ONE single wide image
- EXACTLY ${frameCount} frames — not ${frameCount - 1}, not ${frameCount + 1} — count carefully: ${Array.from({ length: frameCount }, (_, i) => i + 1).join(", ")}
- Each frame is equal width
- Between every pair of adjacent frames: a solid dark gray vertical line (2px wide, full height)
- That means exactly ${frameCount - 1} separator lines total
- Pure WHITE (#FFFFFF) background in every frame — no shadows, no gradients, no color tinting
- Full body (head to feet) visible in EVERY frame — never crop the character
- NO text, NO numbers, NO labels anywhere in the output image`;
}

// ── 메인 ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  console.log("\n" + "═".repeat(68));
  console.log("  스켈레톤 가이드 → Gemini 단일 생성 → 균일·투명 후처리");
  console.log("═".repeat(68));
  console.log(`  참조 이미지  : ${REF_PATH}`);
  console.log(`  프레임 수    : ${FRAME_COUNT}`);
  console.log(`  캔버스 크기  : ${CANVAS_SIZE}×${CANVAS_SIZE} px/frame`);
  console.log(`  저장 경로    : ${OUT_DIR}`);
  console.log("═".repeat(68) + "\n");

  ensureDir(OUT_DIR);
  const framesDir = path.join(OUT_DIR, "frames");
  ensureDir(framesDir);

  // ── Step 1: 캐릭터 참조 로드 ────────────────────────────────────────────
  const refAbs = path.resolve(REF_PATH);
  if (!fs.existsSync(refAbs)) throw new Error(`참조 이미지 없음: ${refAbs}`);
  const charBase64 = fs.readFileSync(refAbs).toString("base64");
  console.log("✓ 캐릭터 참조 이미지 로드됨");

  // ── Step 2: 스켈레톤 액션 가이드 생성 ────────────────────────────────────
  process.stdout.write("⏳ 스켈레톤 액션 가이드 생성...");
  const guideBuffer = await generateSkeletonActionGuide(WAND_SWING_POSES, 256, 3);
  const guidePath   = path.join(OUT_DIR, "skeleton_action_guide.png");
  fs.writeFileSync(guidePath, guideBuffer);
  const guideBase64 = guideBuffer.toString("base64");
  const guideMeta   = await sharpLib(guideBuffer).metadata();
  console.log(` ✓  (${guideMeta.width}×${guideMeta.height}px)`);

  // ── Step 3: Gemini 생성 ──────────────────────────────────────────────────
  console.log("\n⏳ Gemini 생성 중 (캐릭터 참조 + 스켈레톤 가이드)...");
  const t0 = Date.now();

  const raw = await editImageGemini({
    imageBase64: charBase64,
    imageMimeType: "image/png",
    editPrompt: buildGeminiPrompt(FRAME_COUNT),
    model: "gemini-2.5-flash-image",
    referenceImages: [
      { base64: charBase64,  mimeType: "image/png" },
      { base64: guideBase64, mimeType: "image/png" },
    ],
  });

  const genMs = Date.now() - t0;
  const rawBuf = Buffer.from(raw.base64, "base64");
  const rawPath = path.join(OUT_DIR, "gemini_raw.png");
  fs.writeFileSync(rawPath, rawBuf);
  const rawMeta = await sharpLib(rawBuf).metadata();
  console.log(`✅ Gemini 완료  ${genMs}ms  →  원본: ${rawMeta.width}×${rawMeta.height}px`);

  // ── Step 4: 프레임 분할 ──────────────────────────────────────────────────
  console.log(`\n⏳ 프레임 분할 (${FRAME_COUNT}등분)...`);
  const splitFrames = await splitSheetIntoFrames(rawBuf, FRAME_COUNT);
  const actualCount = splitFrames.length;
  console.log(`✓ ${actualCount}개 프레임 분할 완료${actualCount !== FRAME_COUNT ? ` (요청: ${FRAME_COUNT})` : ""}`);;

  // ── Step 5: 흰 배경 제거 + 콘텐츠 크롭 ──────────────────────────────────
  console.log("⏳ 흰 배경 제거 + 크롭...");
  const t1 = Date.now();
  const croppedFrames: Array<Buffer | null> = await Promise.all(
    splitFrames.map((buf, i) =>
      removeBgAndCrop(buf).then(result => {
        const ok = result !== null;
        process.stdout.write(`  [${String(i + 1).padStart(2)}] ${ok ? "✅" : "⬜ (빈 프레임)"}\n`);
        return result;
      })
    )
  );
  const validCount = croppedFrames.filter(Boolean).length;
  console.log(`✓ ${validCount}/${FRAME_COUNT} 프레임 배경 제거 완료  (${Date.now() - t1}ms)`);

  // 개별 크롭 프레임 저장 (디버그용)
  croppedFrames.forEach((buf, i) => {
    if (buf) fs.writeFileSync(path.join(framesDir, `frame_${String(i + 1).padStart(2, "0")}_cropped.png`), buf);
  });

  // ── Step 6: 균일 크기 정규화 (동일 스케일 + bottom-center 정렬) ──────────
  console.log(`\n⏳ 균일 크기 정규화 (캔버스: ${CANVAS_SIZE}×${CANVAS_SIZE})...`);
  const t2 = Date.now();
  const normalizedFrames = await normalizeUniformScale(croppedFrames, CANVAS_SIZE);
  console.log(`✓ 정규화 완료  (${Date.now() - t2}ms)`);

  // 개별 정규화 프레임 저장 (디버그용)
  normalizedFrames.forEach((buf, i) => {
    fs.writeFileSync(path.join(framesDir, `frame_${String(i + 1).padStart(2, "0")}_normalized.png`), buf);
  });

  // ── Step 7: 최종 스프라이트 시트 합성 ────────────────────────────────────
  console.log("\n⏳ 최종 스프라이트 시트 합성...");
  const finalPath = path.join(OUT_DIR, "gemini_sprite_sheet_final.png");
  const { width: finalW, height: finalH } = await composeFinalSheet(normalizedFrames, finalPath, 2);
  const finalKb = Math.round(fs.statSync(finalPath).size / 1024);

  // ── 결과 요약 ────────────────────────────────────────────────────────────
  console.log("\n" + "─".repeat(68));
  console.log("  최종 결과");
  console.log("─".repeat(68));
  console.log(`  스켈레톤 가이드 : ${guidePath}`);
  console.log(`  Gemini 원본     : ${rawPath}  (${rawMeta.width}×${rawMeta.height})`);
  console.log(`  최종 시트       : ${finalPath}`);
  console.log(`    크기          : ${finalW}×${finalH}px  (${FRAME_COUNT}프레임 × ${CANVAS_SIZE}px)`);
  console.log(`    파일 크기     : ${finalKb}KB`);
  console.log(`    배경          : 투명 (PNG alpha)`);
  console.log(`    유효 프레임   : ${validCount}/${FRAME_COUNT}`);
  console.log(`  총 소요 시간    : ${Date.now() - t0}ms\n`);
}

main().catch(err => {
  console.error("\n❌ 오류:", err.message ?? err);
  process.exit(1);
});
