/**
 * sheet-slicer.ts
 *
 * 디자인 시트(단색 크로마 배경 위에 N개 아이템) → 연결 성분 검출 → 개별 슬라이스.
 *
 * "일관성은 한 장 안에서 공짜"라는 원리를 파이프라인화하는 핵심 유틸:
 * 여러 아이템을 한 번의 생성으로 시트에 담아 상호 비례·형태 언어를 통일하고,
 * 여기서 각 아이템을 분리해 개별 에셋으로 만든다.
 */

import sharp from "sharp";
import { processFrameBase64Chroma } from "./image-process.js";

export interface ComponentBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  area: number;
}

export interface SliceOptions {
  /** 크로마 배경색 (기본: 마젠타) */
  chromaColor?: [number, number, number];
  /** 크로마 판정 허용치 — 채널별 근접 기준 (기본: 75) */
  chromaTolerance?: number;
  /** 검출할 성분 수. 지정 시 상위 N개만 반환 */
  expectedCount?: number;
  /** 이 면적(px) 미만 성분은 노이즈로 무시 (기본: 400) */
  minArea?: number;
  /** bbox 주변 여유 px (기본: 12) */
  padding?: number;
}

function isChroma(
  r: number, g: number, b: number,
  chroma: [number, number, number], tol: number,
): boolean {
  return Math.abs(r - chroma[0]) <= tol
    && Math.abs(g - chroma[1]) <= tol
    && Math.abs(b - chroma[2]) <= tol;
}

/**
 * 시트에서 비크로마 연결 성분들의 bbox 검출.
 * 반환: 행(위→아래) → 열(왼→오른쪽) 순으로 정렬된 박스 목록.
 */
export async function detectSheetComponents(
  input: string | Buffer,
  opts: SliceOptions = {},
): Promise<ComponentBox[]> {
  const chroma = opts.chromaColor ?? [255, 0, 255];
  const tol = opts.chromaTolerance ?? 75;
  const minArea = opts.minArea ?? 400;

  const { data, info } = await sharp(input).raw().toBuffer({ resolveWithObject: true });
  const { width: W, height: H, channels: C } = info;

  const mask = new Uint8Array(W * H);
  for (let i = 0; i < W * H; i++) {
    mask[i] = isChroma(data[i * C], data[i * C + 1], data[i * C + 2], chroma, tol) ? 0 : 1;
  }

  // BFS 연결 성분 (4방향)
  const label = new Int32Array(W * H).fill(-1);
  const boxes: ComponentBox[] = [];
  const qx = new Int32Array(W * H);
  const qy = new Int32Array(W * H);
  let next = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const idx = y * W + x;
      if (!mask[idx] || label[idx] >= 0) continue;
      let head = 0, tail = 0;
      qx[tail] = x; qy[tail] = y; tail++;
      label[idx] = next;
      const box: ComponentBox = { x0: x, y0: y, x1: x, y1: y, area: 0 };
      while (head < tail) {
        const cx = qx[head], cy = qy[head]; head++;
        box.area++;
        if (cx < box.x0) box.x0 = cx;
        if (cx > box.x1) box.x1 = cx;
        if (cy < box.y0) box.y0 = cy;
        if (cy > box.y1) box.y1 = cy;
        if (cx + 1 < W) { const n = cy * W + cx + 1; if (mask[n] && label[n] < 0) { label[n] = next; qx[tail] = cx + 1; qy[tail] = cy; tail++; } }
        if (cx - 1 >= 0) { const n = cy * W + cx - 1; if (mask[n] && label[n] < 0) { label[n] = next; qx[tail] = cx - 1; qy[tail] = cy; tail++; } }
        if (cy + 1 < H) { const n = (cy + 1) * W + cx; if (mask[n] && label[n] < 0) { label[n] = next; qx[tail] = cx; qy[tail] = cy + 1; tail++; } }
        if (cy - 1 >= 0) { const n = (cy - 1) * W + cx; if (mask[n] && label[n] < 0) { label[n] = next; qx[tail] = cx; qy[tail] = cy - 1; tail++; } }
      }
      if (box.area >= minArea) boxes.push(box);
      next++;
    }
  }

  // 면적 상위 N개 (지정 시)
  let selected = boxes.sort((a, b) => b.area - a.area);
  if (opts.expectedCount) selected = selected.slice(0, opts.expectedCount);

  // 행 클러스터링: y중심 정렬 후, 간격이 중앙값 높이의 절반보다 크면 새 행
  const withCenter = selected.map((b) => ({ b, cy: (b.y0 + b.y1) / 2, h: b.y1 - b.y0 }));
  withCenter.sort((a, bb) => a.cy - bb.cy);
  const medianH = withCenter.map((c) => c.h).sort((a, b) => a - b)[Math.floor(withCenter.length / 2)] ?? 0;
  const rows: Array<typeof withCenter> = [];
  for (const c of withCenter) {
    const last = rows[rows.length - 1];
    if (last && Math.abs(c.cy - last[last.length - 1].cy) < Math.max(medianH / 2, 40)) {
      last.push(c);
    } else {
      rows.push([c]);
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.b.x0 - b.b.x0).map((c) => c.b));
}

export interface SlicedItem {
  index: number;
  box: ComponentBox;
  /** 크로마 제거 + 리사이즈 완료된 투명 PNG */
  buffer: Buffer;
}

/**
 * 시트에서 성분들을 슬라이스 → 크로마 제거 → 최대변 maxSize 리사이즈.
 * 성분 순서는 detectSheetComponents의 행→열 순서.
 */
export async function sliceSheetComponents(
  input: string | Buffer,
  boxes: ComponentBox[],
  opts: { chromaColor?: [number, number, number]; padding?: number; maxSize?: number } = {},
): Promise<SlicedItem[]> {
  const chroma = opts.chromaColor ?? [255, 0, 255];
  const padding = opts.padding ?? 12;
  const maxSize = opts.maxSize ?? 256;

  const meta = await sharp(input).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;

  const items: SlicedItem[] = [];
  for (let i = 0; i < boxes.length; i++) {
    const b = boxes[i];
    const x0 = Math.max(0, b.x0 - padding);
    const y0 = Math.max(0, b.y0 - padding);
    const w = Math.min(W, b.x1 + padding) - x0;
    const h = Math.min(H, b.y1 + padding) - y0;
    const crop = await sharp(input).extract({ left: x0, top: y0, width: w, height: h }).png().toBuffer();
    const noBg = await processFrameBase64Chroma(crop.toString("base64"), chroma, 80, 0);
    const resized = await sharp(noBg)
      .resize(maxSize, maxSize, { fit: "inside", withoutEnlargement: true, background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    items.push({ index: i, box: b, buffer: resized });
  }
  return items;
}
