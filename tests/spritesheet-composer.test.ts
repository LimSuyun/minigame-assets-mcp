/**
 * spritesheet-composer.ts 단위 테스트
 *
 * 핵심 검증:
 * - 1×N 가로 스트립이 maxSheetDim 한도 초과 시 자동 그리드 재배치
 * - 한도 안에 들어갈 수 있는 그리드 자체가 없으면 명확한 에러
 * - 정상 범위 입력은 사용자가 지정한 cols 그대로 유지
 */
import { afterEach, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import sharp from "sharp";
import {
  composeSpritSheet,
  DEFAULT_MAX_SHEET_DIM,
  type FrameInfo,
} from "../src/utils/spritesheet-composer.js";

const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

async function makeFrames(count: number, w: number, h: number): Promise<FrameInfo[]> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sheet-test-"));
  tmpDirs.push(dir);
  const frames: FrameInfo[] = [];
  for (let i = 0; i < count; i++) {
    const p = path.join(dir, `f${String(i).padStart(3, "0")}.png`);
    await sharp({
      create: { width: w, height: h, channels: 4, background: { r: i * 10, g: 0, b: 0, alpha: 255 } },
    }).png().toFile(p);
    frames.push({ name: `frame_${i}`, filePath: p, action: "idle", frameIndex: i });
  }
  return frames;
}

describe("composeSpritSheet — 한도 자동 재배치", () => {
  it("정상 범위 (8×128, 4096 한도): 사용자 cols=8 그대로 유지", async () => {
    const frames = await makeFrames(8, 128, 128);
    const out = path.join(path.dirname(frames[0].filePath), "_sheet.png");
    const sheet = await composeSpritSheet(frames, out, 0, 8, "png");
    expect(sheet.cols).toBe(8);
    expect(sheet.rows).toBe(1);
    expect(sheet.sheetWidth).toBe(8 * 128);
    expect(sheet.sheetHeight).toBe(128);
    expect(fs.existsSync(sheet.sheetPath)).toBe(true);
  });

  it("1×N 스트립이 한도 초과 → 자동 그리드 재배치 (20×512 frames, max 4096)", async () => {
    // 20프레임 × 512px → 1행 스트립이면 10240px (4096 초과)
    const frames = await makeFrames(20, 512, 512);
    const out = path.join(path.dirname(frames[0].filePath), "_sheet.png");
    const sheet = await composeSpritSheet(frames, out, 0, 20 /* 명시적 1행 요청 */, "png");
    expect(sheet.cols).toBeLessThan(20);
    expect(sheet.rows).toBeGreaterThan(1);
    expect(sheet.sheetWidth).toBeLessThanOrEqual(DEFAULT_MAX_SHEET_DIM);
    expect(sheet.sheetHeight).toBeLessThanOrEqual(DEFAULT_MAX_SHEET_DIM);
    // 모든 프레임이 시트 안에 위치
    expect(sheet.frames).toHaveLength(20);
    for (const f of sheet.frames) {
      expect(f.x + f.w).toBeLessThanOrEqual(sheet.sheetWidth);
      expect(f.y + f.h).toBeLessThanOrEqual(sheet.sheetHeight);
    }
  });

  it("default cols (sqrt) — 16프레임 256px는 한도 안에서 4×4로 배치", async () => {
    const frames = await makeFrames(16, 256, 256);
    const out = path.join(path.dirname(frames[0].filePath), "_sheet.png");
    // cols 미지정 → composer 내부 default (sqrt)
    const sheet = await composeSpritSheet(frames, out, 0, undefined, "png");
    expect(sheet.cols).toBe(4);
    expect(sheet.rows).toBe(4);
    expect(sheet.sheetWidth).toBe(4 * 256);
    expect(sheet.sheetHeight).toBe(4 * 256);
  });

  it("프레임이 한도 안에 어떻게 배치해도 안 들어가면 throw — 명확한 메시지", async () => {
    // 단일 프레임이 한도(4096)보다 큼: 1×1 그리드 자체가 불가능
    const frames = await makeFrames(2, 5000, 5000);
    const out = path.join(path.dirname(frames[0].filePath), "_sheet.png");
    await expect(composeSpritSheet(frames, out, 0, 2, "png"))
      .rejects.toThrow(/한도|단일 시트/);
  });
});
