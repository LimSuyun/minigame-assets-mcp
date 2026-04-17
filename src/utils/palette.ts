/**
 * palette.ts
 *
 * 이미지에서 색상 팔레트 추출 (k-means 클러스터링).
 * 색상 비교 시 CIE76 ΔE 거리 사용 (인간 시각에 가까운 색상 차이).
 *
 * 의존성: sharp (이미 프로젝트에 포함됨)
 */

import sharp from "sharp";

// ─── RGB → CIE Lab 변환 ──────────────────────────────────────────────────────

function linearize(c: number): number {
  const s = c / 255;
  return s > 0.04045 ? Math.pow((s + 0.055) / 1.055, 2.4) : s / 12.92;
}

/**
 * sRGB [0,255] → CIE Lab [L, a, b]
 * 기준 백색점: D65
 */
export function rgbToLab(r: number, g: number, b: number): [number, number, number] {
  const rLin = linearize(r);
  const gLin = linearize(g);
  const bLin = linearize(b);

  // Linear RGB → XYZ (D65)
  const x = (rLin * 0.4124564 + gLin * 0.3575761 + bLin * 0.1804375) / 0.95047;
  const y = (rLin * 0.2126729 + gLin * 0.7151522 + bLin * 0.0721750) / 1.00000;
  const z = (rLin * 0.0193339 + gLin * 0.1191920 + bLin * 0.9503041) / 1.08883;

  const f = (t: number): number =>
    t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116;

  const L = 116 * f(y) - 16;
  const a = 500 * (f(x) - f(y));
  const bVal = 200 * (f(y) - f(z));

  return [L, a, bVal];
}

/**
 * CIE76 ΔE — 두 RGB 색상의 지각적 거리.
 * ΔE < 2: 거의 구별 불가
 * ΔE 2~10: 주의 깊게 보면 구별 가능
 * ΔE > 10: 명확히 다른 색상
 */
export function colorDistanceCIE76(
  c1: [number, number, number],
  c2: [number, number, number]
): number {
  const lab1 = rgbToLab(c1[0], c1[1], c1[2]);
  const lab2 = rgbToLab(c2[0], c2[1], c2[2]);
  const dL = lab1[0] - lab2[0];
  const da = lab1[1] - lab2[1];
  const db = lab1[2] - lab2[2];
  return Math.sqrt(dL * dL + da * da + db * db);
}

// ─── K-means 클러스터링 ────────────────────────────────────────────────────────

type RGB = [number, number, number];

/**
 * 이미지에서 dominant color k개 추출.
 * k-means++ 초기화로 수렴 속도 향상.
 *
 * @param imageBuffer  PNG/JPEG Buffer
 * @param colorCount   추출할 색상 수 (기본: 8)
 * @returns            dominant 색상 배열 (count 내림차순 정렬)
 */
export async function extractPalette(
  imageBuffer: Buffer,
  colorCount = 8
): Promise<Array<{ rgb: RGB; hex: string; count: number; percentage: number }>> {
  // 성능을 위해 100×100으로 리사이즈 후 픽셀 추출
  const { data } = await sharp(imageBuffer)
    .resize(100, 100, { fit: "inside" })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // 불투명 픽셀만 수집
  const pixels: RGB[] = [];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! > 128) {
      pixels.push([data[i]!, data[i + 1]!, data[i + 2]!]);
    }
  }

  if (pixels.length === 0) return [];

  const k = Math.min(colorCount, pixels.length);

  // k-means++ 초기화
  const centroids: RGB[] = [pixels[Math.floor(Math.random() * pixels.length)]!];

  while (centroids.length < k) {
    const distances = pixels.map((px) => {
      let minDist = Infinity;
      for (const c of centroids) {
        const dr = px[0] - c[0];
        const dg = px[1] - c[1];
        const db = px[2] - c[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minDist) minDist = d;
      }
      return minDist;
    });

    const total = distances.reduce((a, b) => a + b, 0);
    let rand = Math.random() * total;
    let chosen = pixels[pixels.length - 1]!;
    for (let i = 0; i < distances.length; i++) {
      rand -= distances[i]!;
      if (rand <= 0) {
        chosen = pixels[i]!;
        break;
      }
    }
    centroids.push(chosen);
  }

  // K-means 반복 (최대 30회)
  const MAX_ITER = 30;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const clusters: RGB[][] = Array.from({ length: k }, () => []);

    for (const px of pixels) {
      let minDist = Infinity;
      let minIdx = 0;
      for (let ci = 0; ci < centroids.length; ci++) {
        const c = centroids[ci]!;
        const dr = px[0] - c[0];
        const dg = px[1] - c[1];
        const db = px[2] - c[2];
        const d = dr * dr + dg * dg + db * db;
        if (d < minDist) { minDist = d; minIdx = ci; }
      }
      clusters[minIdx]!.push(px);
    }

    let changed = false;
    for (let ci = 0; ci < k; ci++) {
      const cluster = clusters[ci]!;
      if (cluster.length === 0) continue;
      const newCentroid: RGB = [
        Math.round(cluster.reduce((s, p) => s + p[0], 0) / cluster.length),
        Math.round(cluster.reduce((s, p) => s + p[1], 0) / cluster.length),
        Math.round(cluster.reduce((s, p) => s + p[2], 0) / cluster.length),
      ];
      const c = centroids[ci]!;
      if (newCentroid[0] !== c[0] || newCentroid[1] !== c[1] || newCentroid[2] !== c[2]) {
        centroids[ci] = newCentroid;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // 각 센트로이드에 속하는 픽셀 수 카운트
  const counts = new Array(k).fill(0) as number[];
  for (const px of pixels) {
    let minDist = Infinity;
    let minIdx = 0;
    for (let ci = 0; ci < centroids.length; ci++) {
      const c = centroids[ci]!;
      const dr = px[0] - c[0];
      const dg = px[1] - c[1];
      const db = px[2] - c[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < minDist) { minDist = d; minIdx = ci; }
    }
    counts[minIdx]!++;
  }

  const total = pixels.length;
  const result = centroids.map((c, i) => ({
    rgb: c,
    hex: `#${c[0].toString(16).padStart(2, "0")}${c[1].toString(16).padStart(2, "0")}${c[2].toString(16).padStart(2, "0")}`.toUpperCase(),
    count: counts[i]!,
    percentage: Math.round((counts[i]! / total) * 1000) / 10,
  }));

  return result.sort((a, b) => b.count - a.count);
}

/**
 * 두 팔레트의 평균 CIE76 ΔE 거리 계산.
 * 팔레트 일관성 검증에 사용.
 *
 * @param palette1  기준 팔레트 (hex 문자열 배열)
 * @param palette2  비교 팔레트 (hex 문자열 배열)
 * @returns 평균 ΔE 거리 (낮을수록 유사)
 */
export function comparePalettes(palette1: string[], palette2: string[]): number {
  if (palette1.length === 0 || palette2.length === 0) return 999;

  const toRgb = (hex: string): RGB => {
    const h = hex.replace("#", "");
    return [
      parseInt(h.slice(0, 2), 16),
      parseInt(h.slice(2, 4), 16),
      parseInt(h.slice(4, 6), 16),
    ];
  };

  const rgbs1 = palette1.map(toRgb);
  const rgbs2 = palette2.map(toRgb);

  let totalDist = 0;
  let count = 0;

  for (const c1 of rgbs1) {
    // palette2에서 가장 가까운 색상과의 거리
    const minDist = Math.min(...rgbs2.map((c2) => colorDistanceCIE76(c1, c2)));
    totalDist += minDist;
    count++;
  }

  return count > 0 ? totalDist / count : 999;
}
