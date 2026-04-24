import sharp from "sharp";
import * as path from "path";
import * as fs from "fs";
import { execFileSync } from "child_process";

// ─── BFS Flood-fill 배경 제거 ─────────────────────────────────────────────────
// 이미지 엣지(테두리)에서 시작해 연결된 픽셀을 투명으로 변환.
// 두 가지 모드:
//   1. 밝기 기반 (기본): 흰색 계열 배경 제거
//   2. 색상 거리 기반 (크로마키): 특정 색상 배경 제거 (magenta 등)
// 캐릭터 내부 픽셀은 엣지에서 연결되지 않으므로 보존됨.

async function floodFillRemove(
  imagePath: string,
  threshold: number,
  targetColor?: [number, number, number]  // 크로마키 색상 (R,G,B)
): Promise<Buffer> {
  const { data, info } = await sharp(imagePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  const { width, height } = info;
  const visited = new Uint8Array(width * height);

  const isBackground = (x: number, y: number): boolean => {
    const idx = (y * width + x) * 4;
    if (targetColor) {
      // 크로마키 모드: 목표 색상과의 유클리드 거리
      const dr = pixels[idx]     - targetColor[0];
      const dg = pixels[idx + 1] - targetColor[1];
      const db = pixels[idx + 2] - targetColor[2];
      return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
    }
    // 밝기 기반 모드: 모든 채널이 threshold 초과 = 밝은 픽셀
    return pixels[idx] > threshold && pixels[idx + 1] > threshold && pixels[idx + 2] > threshold;
  };

  const queue: number[] = [];
  const enqueue = (x: number, y: number) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return;
    const pos = y * width + x;
    if (visited[pos] || !isBackground(x, y)) return;
    visited[pos] = 1;
    queue.push(x, y);
  };

  // 4면 엣지 픽셀 모두 큐에 추가
  for (let x = 0; x < width; x++) { enqueue(x, 0); enqueue(x, height - 1); }
  for (let y = 0; y < height; y++) { enqueue(0, y); enqueue(width - 1, y); }

  let qi = 0;
  while (qi < queue.length) {
    const x = queue[qi++];
    const y = queue[qi++];
    enqueue(x + 1, y); enqueue(x - 1, y);
    enqueue(x, y + 1); enqueue(x, y - 1);
  }

  // 크로마키 모드 전용 residue 패스:
  // 캐릭터 외곽선으로 닫힌 내부 포켓(예: 겨드랑이·다리 사이)은
  // 엣지 BFS가 도달하지 못해 크로마 색 픽셀이 불투명으로 남는다.
  // 프롬프트로 캐릭터에 크로마 색 금지를 강제하므로, 연결성 무관하게
  // 크로마 임계거리 이내 픽셀을 모두 배경으로 마킹해도 안전하다.
  // (밝기 모드에서는 눈 흰자위 등 내부 흰색을 보존해야 하므로 실행하지 않음.)
  if (targetColor) {
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const pos = y * width + x;
        if (!visited[pos] && isBackground(x, y)) {
          visited[pos] = 1;
        }
      }
    }
  }

  // 방문된 픽셀(배경 + 내부 크로마 잔류)만 투명 처리
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (visited[y * width + x]) {
        const idx = (y * width + x) * 4;
        pixels[idx + 3] = 0;
      }
    }
  }

  return sharp(Buffer.from(pixels), {
    raw: { width, height, channels: 4 },
  }).png().toBuffer();
}

// ─── 크로마 잔류 스캔 (품질 검증용) ──────────────────────────────────────────

export interface ChromaResidueReport {
  /** 불투명 픽셀 총 수 */
  totalOpaque: number;
  /** 크로마 거리 ≤ threshold인 픽셀 수 (잔류) */
  residuePixels: number;
  /** residuePixels / totalOpaque × 100 (%) */
  residuePercent: number;
  /** 인접 연결된 가장 큰 잔류 클러스터 크기 (픽셀) */
  largestCluster: number;
}

/**
 * PNG 내부의 크로마 색상 잔류 픽셀을 정량 측정한다.
 * 마젠타 크로마키 제거 후 내부 포켓(겨드랑이 등)에 남은 불투명 마젠타 탐지에 사용.
 *
 * @param filePath PNG 파일 경로
 * @param targetColor 체크할 크로마 색상 [R,G,B], 기본 마젠타 #FF00FF
 * @param threshold 유클리드 거리 임계값, 기본 80
 */
export async function scanChromaResidue(
  filePath: string,
  targetColor: [number, number, number] = [255, 0, 255],
  threshold: number = 80,
): Promise<ChromaResidueReport> {
  const { data, info } = await sharp(filePath)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const { width, height } = info;
  const visited = new Uint8Array(width * height);
  let totalOpaque = 0;
  let residuePixels = 0;

  const isResidue = (idx: number): boolean => {
    if (data[idx + 3] < 250) return false;
    const dr = data[idx] - targetColor[0];
    const dg = data[idx + 1] - targetColor[1];
    const db = data[idx + 2] - targetColor[2];
    return Math.sqrt(dr * dr + dg * dg + db * db) <= threshold;
  };

  // 1차 패스: 카운트
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = (y * width + x) * 4;
      if (data[idx + 3] < 250) continue;
      totalOpaque++;
      if (isResidue(idx)) residuePixels++;
    }
  }

  // 2차 패스: 가장 큰 연결 클러스터 크기 (BFS)
  let largestCluster = 0;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const pos = y * width + x;
      if (visited[pos]) continue;
      const idx = pos * 4;
      if (!isResidue(idx)) continue;
      let size = 0;
      const queue = [pos];
      visited[pos] = 1;
      while (queue.length > 0) {
        const p = queue.shift()!;
        size++;
        const px = p % width;
        const py = (p - px) / width;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const nx = px + dx;
          const ny = py + dy;
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
          const np = ny * width + nx;
          if (visited[np]) continue;
          if (!isResidue(np * 4)) continue;
          visited[np] = 1;
          queue.push(np);
        }
      }
      if (size > largestCluster) largestCluster = size;
    }
  }

  return {
    totalOpaque,
    residuePixels,
    residuePercent: totalOpaque > 0 ? (residuePixels / totalOpaque) * 100 : 0,
    largestCluster,
  };
}

// ─── 콘텐츠 기반 자동 크롭 ───────────────────────────────────────────────────
// 투명하지 않은 픽셀의 bounding box를 찾아서 여백 제거.

async function cropToContent(imageBuffer: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(imageBuffer)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = new Uint8Array(data);
  let minX = info.width, maxX = 0, minY = info.height, maxY = 0;

  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const idx = (y * info.width + x) * 4;
      if (pixels[idx + 3] > 10) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (minX > maxX || minY > maxY) return imageBuffer;

  return sharp(imageBuffer)
    .extract({ left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 })
    .toBuffer();
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

export interface RemoveBackgroundOptions {
  /**
   * 밝기 기반 모드: 배경으로 간주할 밝기 임계값 (0-255). 기본: 240
   * 크로마키 모드: 목표 색상과의 허용 색상 거리 (0-255). 기본: 80
   */
  threshold?: number;
  /**
   * 배경 제거 후 콘텐츠 범위로 자동 크롭. 기본: false
   */
  cropToContent?: boolean;
  /**
   * 크로마키 배경색 [R, G, B]. 지정 시 색상 거리 기반 제거 사용.
   * 예: [255, 0, 255] = 마젠타, [0, 255, 0] = 라임 그린
   */
  chromaKeyColor?: [number, number, number];
}

/**
 * 이미지에서 배경을 flood-fill 방식으로 제거하고 투명 PNG로 저장.
 * - 기본: 흰색 계열 밝기 기반 제거
 * - chromaKeyColor 지정 시: 해당 색상을 크로마키로 제거 (마젠타 등)
 * 캐릭터 내부 픽셀은 엣지에서 연결되지 않으므로 보존됨.
 */
export async function removeBackground(
  inputPath: string,
  outputPath: string,
  options: RemoveBackgroundOptions = {}
): Promise<void> {
  const isChromaKey = !!options.chromaKeyColor;
  const threshold = options.threshold ?? (isChromaKey ? 80 : 240);

  let buffer = await floodFillRemove(inputPath, threshold, options.chromaKeyColor);

  if (options.cropToContent) {
    buffer = await cropToContent(buffer);
  }

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outputPath, buffer);
}

/**
 * 투명 PNG를 단색 배경 위에 합성하여 Buffer 반환.
 * 일부 이미지 edit API는 투명 PNG를 받으면 투명 영역을 체크 무늬로 렌더링하므로,
 * 편집 API에 보내기 전에 단색 배경에 합성해 두면 안정적이다.
 */
export async function compositeOntoSolidBg(
  imagePath: string,
  bgColor: [number, number, number]
): Promise<Buffer> {
  const meta = await sharp(imagePath).metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 1024;

  const charLayer = await sharp(imagePath).ensureAlpha().toBuffer();

  return sharp({
    create: {
      width: w,
      height: h,
      channels: 3,
      background: { r: bgColor[0], g: bgColor[1], b: bgColor[2] },
    },
  })
    .composite([{ input: charLayer }])
    .png()
    .toBuffer();
}

/**
 * Base64 문자열 이미지를 처리: flood-fill 배경 제거 → 콘텐츠 크롭 → Buffer 반환.
 * 스프라이트 생성 파이프라인에서 사용.
 */
export async function processFrameBase64(
  base64: string,
  threshold: number = 240
): Promise<Buffer> {
  const tmpPath = path.join(
    process.env["TMPDIR"] || "/tmp",
    `frame_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
  );
  try {
    fs.writeFileSync(tmpPath, Buffer.from(base64, "base64"));
    const noBg = await floodFillRemove(tmpPath, threshold);
    return await cropToContent(noBg);
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ─── 이미지 패딩 추가 (잘림 방지용) ──────────────────────────────────────────

export async function addPadding(
  inputPath: string,
  outputPath: string,
  paddingPercent = 10
): Promise<void> {
  const meta = await sharp(inputPath).metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 1024;

  const pad = Math.round(Math.min(w, h) * (paddingPercent / 100));

  await sharp(inputPath)
    .extend({
      top: pad,
      bottom: pad,
      left: pad,
      right: pad,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toFile(outputPath);
}

/**
 * 배경 제거 후 저장 (이전 버전 호환용).
 */
export async function processCharacterSprite(
  inputPath: string,
  outputPath: string,
  options: RemoveBackgroundOptions & { addPaddingPercent?: number } = {}
): Promise<void> {
  const tmpPath = inputPath + ".tmp.png";

  try {
    await removeBackground(inputPath, tmpPath, options);

    if (options.addPaddingPercent && options.addPaddingPercent > 0) {
      await addPadding(tmpPath, outputPath, options.addPaddingPercent);
    } else {
      fs.copyFileSync(tmpPath, outputPath);
    }
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ─── AI 기반 배경 제거 (rembg / U2Net) ───────────────────────────────────────
// 배경 색상과 무관하게 전경을 분리. 배경이 불규칙한 경우에도 동작.

const REMBG_SCRIPT = path.resolve(
  new URL(".", import.meta.url).pathname,
  "remove_bg_ai.py"
);

/**
 * rembg(U2Net)로 배경 제거 후 투명 PNG 저장.
 * 배경이 체크무늬/불규칙한 경우에도 안정적으로 동작.
 */
export async function removeBackgroundAI(
  inputPath: string,
  outputPath: string
): Promise<void> {
  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  execFileSync("python3", [REMBG_SCRIPT, inputPath, outputPath], {
    timeout: 60_000,
  });
}

/**
 * Buffer에 사방 균등 패딩 추가 (투명 배경).
 */
export async function addPaddingToBuffer(inputBuffer: Buffer, paddingPixels: number): Promise<Buffer> {
  if (paddingPixels <= 0) return inputBuffer;
  return sharp(inputBuffer)
    .extend({
      top: paddingPixels,
      bottom: paddingPixels,
      left: paddingPixels,
      right: paddingPixels,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer();
}

/**
 * Base64 이미지를 chroma key flood-fill로 배경 제거 → 콘텐츠 크롭 → 패딩 추가 → Buffer 반환.
 * 단색 배경이 있는 편집 결과에서 rembg보다 정확하게 캐릭터를 보존.
 * @param chromaKeyColor 제거할 배경 RGB 색상
 * @param threshold 색상 허용 거리 (기본: 35)
 */
export async function processFrameBase64Chroma(
  base64: string,
  chromaKeyColor: [number, number, number],
  threshold = 35,
  paddingPixels = 0
): Promise<Buffer> {
  const tmpPath = path.join(
    process.env["TMPDIR"] || "/tmp",
    `chroma_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
  );
  try {
    fs.writeFileSync(tmpPath, Buffer.from(base64, "base64"));
    let result = await floodFillRemove(tmpPath, threshold, chromaKeyColor);
    result = await cropToContent(result);
    if (paddingPixels > 0) {
      result = await addPaddingToBuffer(result, paddingPixels);
    }
    return result;
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ─── 타일 이음새 없애기 (Seamless Tiling) ────────────────────────────────────

/**
 * 이미지를 seamless tileable 텍스처로 변환.
 * 표준 "offset" 기법 사용:
 *   1. 이미지를 2×2로 배치
 *   2. 중앙(w/2, h/2)에서 원본 크기만큼 크롭
 * 결과: 타일링 시 가장자리가 이어지는 텍스처.
 *
 * @param imageBuffer  원본 이미지 Buffer (PNG/JPEG)
 * @returns seamless PNG Buffer
 */
export async function makeSeamlessTileable(imageBuffer: Buffer): Promise<Buffer> {
  const meta = await sharp(imageBuffer).metadata();
  const w = meta.width ?? 256;
  const h = meta.height ?? 256;

  // 원본을 RGBA로 통일
  const rgba = await sharp(imageBuffer).ensureAlpha().png().toBuffer();

  // 2×2 모자이크 생성
  const mosaic = await sharp({
    create: {
      width: w * 2,
      height: h * 2,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 255 },
    },
  })
    .composite([
      { input: rgba, left: 0, top: 0 },
      { input: rgba, left: w, top: 0 },
      { input: rgba, left: 0, top: h },
      { input: rgba, left: w, top: h },
    ])
    .png()
    .toBuffer();

  // 중앙(w/2, h/2)에서 원본 크기만큼 크롭 = offset 처리된 tileable 이미지
  return sharp(mosaic)
    .extract({
      left: Math.floor(w / 2),
      top: Math.floor(h / 2),
      width: w,
      height: h,
    })
    .png()
    .toBuffer();
}

/**
 * Base64 이미지를 rembg로 배경 제거 → 콘텐츠 크롭 → 패딩 추가 → Buffer 반환.
 * 스프라이트 생성 파이프라인에서 편집 결과 처리용.
 */
export async function processFrameBase64AI(base64: string, paddingPixels = 0): Promise<Buffer> {
  const tmpIn = path.join(
    process.env["TMPDIR"] || "/tmp",
    `rembg_in_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
  );
  const tmpOut = tmpIn.replace("_in_", "_out_");

  try {
    fs.writeFileSync(tmpIn, Buffer.from(base64, "base64"));
    execFileSync("python3", [REMBG_SCRIPT, tmpIn, tmpOut], { timeout: 60_000 });
    const noBgBuffer = fs.readFileSync(tmpOut);
    let result = await cropToContent(noBgBuffer);
    if (paddingPixels > 0) {
      result = await addPaddingToBuffer(result, paddingPixels);
    }
    return result;
  } finally {
    if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
    if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
  }
}
