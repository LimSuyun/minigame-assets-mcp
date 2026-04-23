/**
 * image-process.ts 단위 테스트
 *
 * 대상:
 *   - scanChromaResidue — 크로마 잔류 픽셀 정량 측정
 *   - removeBackground — 엣지 BFS + 크로마 residue 패스 통합 검증
 *
 * 전략: sharp로 프로그래매틱 PNG 생성 → 임시 파일로 저장 → 함수 실행 → 픽셀 검증
 * 외부 API 호출 없음.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { scanChromaResidue, removeBackground } from "../src/utils/image-process.js";

const TMP_DIR = path.join(os.tmpdir(), `image-process-test-${Date.now()}`);

beforeAll(() => {
  if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  if (fs.existsSync(TMP_DIR)) fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ─── 헬퍼: 테스트용 PNG 생성 ─────────────────────────────────────────────────

/**
 * 지정 크기의 단색 PNG 생성.
 * RGBA 지정 가능. alpha=0이면 완전 투명.
 */
async function makeSolidPng(
  filePath: string,
  width: number,
  height: number,
  rgba: [number, number, number, number] = [255, 0, 255, 255],
): Promise<void> {
  const [r, g, b, a] = rgba;
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    buf[i * 4 + 0] = r;
    buf[i * 4 + 1] = g;
    buf[i * 4 + 2] = b;
    buf[i * 4 + 3] = a;
  }
  await sharp(buf, { raw: { width, height, channels: 4 } }).png().toFile(filePath);
}

/**
 * "캐릭터 + 마젠타 배경" 이미지 생성.
 * - 전체 마젠타(#FF00FF)
 * - 중앙의 rectSize × rectSize 영역은 검은색 사각형 (캐릭터 대신)
 */
async function makeCharOnMagenta(
  filePath: string,
  size: number,
  rectSize: number,
): Promise<void> {
  const buf = Buffer.alloc(size * size * 4);
  const rectStart = Math.floor((size - rectSize) / 2);
  const rectEnd = rectStart + rectSize;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const isChar = x >= rectStart && x < rectEnd && y >= rectStart && y < rectEnd;
      if (isChar) {
        buf[idx + 0] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 255;
      } else {
        buf[idx + 0] = 255; // R
        buf[idx + 1] = 0;   // G
        buf[idx + 2] = 255; // B (마젠타)
        buf[idx + 3] = 255; // 불투명
      }
    }
  }
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(filePath);
}

/**
 * "캐릭터가 마젠타 포켓을 감싼" 이미지 — residue 패스 테스트의 핵심 케이스.
 * - 전체 마젠타
 * - 외곽 링(검은색)이 내부 마젠타 영역을 완전히 둘러쌈
 * 엣지 BFS만으로는 내부 포켓 도달 불가 → residue 패스가 없으면 내부 마젠타 잔류.
 */
async function makeEnclosedMagentaPocket(filePath: string, size: number): Promise<void> {
  const buf = Buffer.alloc(size * size * 4);
  const ringOuter = Math.floor(size * 0.25);
  const ringInner = Math.floor(size * 0.35);
  const pocketStart = Math.floor(size * 0.45);
  const pocketEnd = Math.floor(size * 0.55);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;
      const distFromCenter = Math.max(Math.abs(x - size / 2), Math.abs(y - size / 2));
      const normalized = distFromCenter / (size / 2);

      // 외곽(마젠타) - 링(검은색, 캐릭터 외곽선) - 내부(마젠타 포켓, 캐릭터 내부)
      const inRing = normalized >= 0.35 && normalized < 0.55;
      const inPocket =
        x >= pocketStart && x < pocketEnd && y >= pocketStart && y < pocketEnd;

      if (inRing && !inPocket) {
        // 캐릭터 외곽선
        buf[idx + 0] = 0;
        buf[idx + 1] = 0;
        buf[idx + 2] = 0;
        buf[idx + 3] = 255;
      } else {
        // 외곽 마젠타 배경 OR 내부 포켓 마젠타
        buf[idx + 0] = 255;
        buf[idx + 1] = 0;
        buf[idx + 2] = 255;
        buf[idx + 3] = 255;
      }
    }
  }
  await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(filePath);
}

// ─── scanChromaResidue 테스트 ────────────────────────────────────────────────

describe("scanChromaResidue", () => {
  it("완전 투명 이미지는 totalOpaque=0, residue=0", async () => {
    const f = path.join(TMP_DIR, "transparent.png");
    await makeSolidPng(f, 32, 32, [255, 0, 255, 0]); // 마젠타지만 alpha=0

    const r = await scanChromaResidue(f);
    expect(r.totalOpaque).toBe(0);
    expect(r.residuePixels).toBe(0);
    expect(r.residuePercent).toBe(0);
    expect(r.largestCluster).toBe(0);
  });

  it("완전 불투명 마젠타 이미지는 모든 픽셀이 residue", async () => {
    const f = path.join(TMP_DIR, "all-magenta.png");
    await makeSolidPng(f, 10, 10, [255, 0, 255, 255]);

    const r = await scanChromaResidue(f);
    expect(r.totalOpaque).toBe(100);
    expect(r.residuePixels).toBe(100);
    expect(r.residuePercent).toBeCloseTo(100, 1);
    expect(r.largestCluster).toBe(100); // 하나의 큰 연결 클러스터
  });

  it("캐릭터(검은색)만 있는 이미지는 residue=0", async () => {
    const f = path.join(TMP_DIR, "black-char.png");
    await makeSolidPng(f, 20, 20, [0, 0, 0, 255]);

    const r = await scanChromaResidue(f);
    expect(r.totalOpaque).toBe(400);
    expect(r.residuePixels).toBe(0);
    expect(r.largestCluster).toBe(0);
  });

  it("마젠타 배경 + 검은 캐릭터 혼합 — 둘 다 카운트됨", async () => {
    const f = path.join(TMP_DIR, "mixed.png");
    await makeCharOnMagenta(f, 20, 10); // 20×20 중 10×10 검은 영역

    const r = await scanChromaResidue(f);
    expect(r.totalOpaque).toBe(400);
    expect(r.residuePixels).toBe(300); // 400 - 100(char)
    expect(r.residuePercent).toBeCloseTo(75, 1);
    expect(r.largestCluster).toBe(300); // 마젠타가 가장자리 전체로 연결됨
  });

  it("threshold 조절로 민감도 변경 가능", async () => {
    const f = path.join(TMP_DIR, "near-magenta.png");
    // 마젠타에서 살짝 벗어난 색 — (240, 10, 245). 거리 ~= sqrt(225+100+100) ~= 21
    await makeSolidPng(f, 10, 10, [240, 10, 245, 255]);

    const strictLow = await scanChromaResidue(f, [255, 0, 255], 10);
    expect(strictLow.residuePixels).toBe(0); // 거리 21 > 10

    const relaxed = await scanChromaResidue(f, [255, 0, 255], 50);
    expect(relaxed.residuePixels).toBe(100); // 거리 21 ≤ 50
  });

  it("다른 크로마 색상도 지원 (lime 등)", async () => {
    const f = path.join(TMP_DIR, "lime.png");
    await makeSolidPng(f, 10, 10, [0, 255, 0, 255]);

    const magentaScan = await scanChromaResidue(f, [255, 0, 255], 80);
    expect(magentaScan.residuePixels).toBe(0); // 거리 매우 큼

    const limeScan = await scanChromaResidue(f, [0, 255, 0], 80);
    expect(limeScan.residuePixels).toBe(100); // 정확히 매칭
  });
});

// ─── removeBackground (residue 패스 통합) 테스트 ─────────────────────────────

describe("removeBackground — chroma-key + residue pass", () => {
  it("단순 마젠타 배경 제거 — 배경이 엣지에서 연결되어 모두 제거", async () => {
    const input = path.join(TMP_DIR, "simple-bg-in.png");
    const output = path.join(TMP_DIR, "simple-bg-out.png");
    await makeCharOnMagenta(input, 20, 8);

    await removeBackground(input, output, {
      chromaKeyColor: [255, 0, 255],
    });

    // 결과 스캔 — 마젠타 전무 기대
    const residue = await scanChromaResidue(output);
    expect(residue.residuePixels).toBe(0);
  });

  it("🔑 내부 포켓 마젠타 — residue 패스가 작동해야 0이 됨", async () => {
    // 이 테스트가 핵심: 외곽선(검은색)이 내부 마젠타 포켓을 완전히 둘러싸고 있을 때,
    // 엣지 BFS만으로는 내부 도달 불가. residue 패스가 있어야 제거됨.
    const input = path.join(TMP_DIR, "enclosed-in.png");
    const output = path.join(TMP_DIR, "enclosed-out.png");
    await makeEnclosedMagentaPocket(input, 40);

    // 사전 확인: 입력에는 마젠타가 많이 있어야 함
    const before = await scanChromaResidue(input);
    expect(before.residuePixels).toBeGreaterThan(0);

    await removeBackground(input, output, {
      chromaKeyColor: [255, 0, 255],
    });

    // 사후 검증: 마젠타 0
    const after = await scanChromaResidue(output);
    expect(after.residuePixels).toBe(0);
    expect(after.largestCluster).toBe(0);
  });

  it("cropToContent 옵션으로 바운딩 박스로 잘림", async () => {
    const input = path.join(TMP_DIR, "crop-in.png");
    const output = path.join(TMP_DIR, "crop-out.png");

    // 40×40 이미지, 중앙 10×10 검은색 캐릭터, 나머지 마젠타
    await makeCharOnMagenta(input, 40, 10);

    await removeBackground(input, output, {
      chromaKeyColor: [255, 0, 255],
      cropToContent: true,
    });

    const meta = await sharp(output).metadata();
    // 크롭 후 너비/높이는 캐릭터 크기(10×10)에 근접해야 함 (≤ 입력 크기)
    expect(meta.width).toBeLessThanOrEqual(40);
    expect(meta.height).toBeLessThanOrEqual(40);
    expect(meta.width).toBeGreaterThanOrEqual(10);
    expect(meta.height).toBeGreaterThanOrEqual(10);
  });

  it("밝기 모드 (targetColor 없음)에서는 residue 패스 미실행 — 내부 흰 픽셀 보존", async () => {
    // 눈 흰자위·치아 등 내부 흰색이 보존되어야 하는 케이스 시뮬레이션:
    // 엣지(마젠타 대신 흰색) + 중앙 검은 링 + 내부 흰 포켓
    const input = path.join(TMP_DIR, "brightness-mode-in.png");
    const output = path.join(TMP_DIR, "brightness-mode-out.png");
    const size = 40;
    const buf = Buffer.alloc(size * size * 4);

    const ringOuter = 0.35, ringInner = 0.55;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const idx = (y * size + x) * 4;
        const normalized = Math.max(Math.abs(x - size / 2), Math.abs(y - size / 2)) / (size / 2);
        const inRing = normalized >= ringOuter && normalized < ringInner;
        buf[idx + 3] = 255;
        if (inRing) {
          // 검은 링 (외곽선)
          buf[idx] = 0; buf[idx + 1] = 0; buf[idx + 2] = 0;
        } else {
          // 흰색 (외곽 배경 OR 내부 포켓)
          buf[idx] = 255; buf[idx + 1] = 255; buf[idx + 2] = 255;
        }
      }
    }
    await sharp(buf, { raw: { width: size, height: size, channels: 4 } }).png().toFile(input);

    // targetColor 미지정 = 밝기 모드
    await removeBackground(input, output, { threshold: 240 });

    // 결과: 외곽 흰색은 제거되지만 내부 포켓 흰색은 보존 (눈 흰자위 로직)
    const { data, info } = await sharp(output).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const centerIdx = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    // 중앙(내부 포켓)은 불투명 흰색으로 남아있어야 함
    expect(data[centerIdx + 3]).toBeGreaterThan(250);
    expect(data[centerIdx]).toBeGreaterThan(240); // R
    expect(data[centerIdx + 1]).toBeGreaterThan(240); // G
    expect(data[centerIdx + 2]).toBeGreaterThan(240); // B
  });
});
