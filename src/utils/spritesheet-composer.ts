import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import { resolveOutputFormat, type ImageFormat } from "./image-output.js";

// ─── 시트 변(dim) 안전 한도 ─────────────────────────────────────────────────
//
// libwebp(VP8)는 16,383px가 절대 한도지만, 모바일 GPU 텍스처 한도가
// 4,096~8,192 사이에서 크게 흔들리므로 게임 런타임에서 실제 사용 가능한
// 안전선은 4,096px이다. 이 값을 기본 가드로 두고, 호출자가 더 넓은
// 한도가 필요하면 maxSheetDim 인자로 override 한다.
export const DEFAULT_MAX_SHEET_DIM = 4096;
/** libwebp 절대 한도 — 이 값 이상이면 인코더 자체가 거부 */
export const WEBP_HARD_LIMIT = 16383;

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface FrameInfo {
  name: string;       // 프레임 식별자 (예: "hero_idle_f00")
  filePath: string;   // 개별 PNG 경로
  action: string;
  frameIndex: number;
}

export interface ComposedSheet {
  sheetPath: string;      // 합성된 스프라이트 시트 PNG 경로
  sheetWidth: number;
  sheetHeight: number;
  frameWidth: number;
  frameHeight: number;
  cols: number;
  rows: number;
  frames: Array<FrameInfo & { x: number; y: number; w: number; h: number }>;
}

// ─── 이미지 합성 ─────────────────────────────────────────────────────────────

export async function composeSpritSheet(
  frames: FrameInfo[],
  outputPath: string,
  padding: number = 0,
  /**
   * 열(column) 수 명시. 지정 시 cols × ceil(N/cols) 그리드에 배치.
   * 미지정 시 정사각형에 가까운 sqrt 그리드(레거시 동작).
   * - 1행 가로 스트립: cols = frames.length
   * - 2행 그리드: cols = Math.ceil(frames.length / 2)
   */
  cols?: number,
  /**
   * Output format — omit to auto-resolve via engine detection (WebP for
   * Phaser/Cocos/Godot, PNG for Unity/unknown). The actual written file
   * path (returned in `ComposedSheet.sheetPath`) will have the chosen
   * extension, which may differ from `outputPath`'s extension.
   */
  format?: ImageFormat,
  /**
   * 시트 한 변(dim)의 픽셀 한도. 미지정 시 DEFAULT_MAX_SHEET_DIM(4096).
   * 계산된 sheetW/sheetH가 이 값을 넘으면 cols을 자동으로 줄여 그리드로
   * 재배치한다. 한도 내에 들어가는 그리드 자체가 불가능하면 throw.
   */
  maxSheetDim: number = DEFAULT_MAX_SHEET_DIM,
): Promise<ComposedSheet> {
  if (frames.length === 0) throw new Error("No frames to compose");

  // 모든 프레임 메타데이터 읽기 → 최대 크기 산출
  const metaList = await Promise.all(frames.map((f) => sharp(f.filePath).metadata()));
  const frameW = Math.max(...metaList.map((m) => m.width ?? 0));
  const frameH = Math.max(...metaList.map((m) => m.height ?? 0));

  // 각 프레임을 frameW × frameH 캔버스에 중앙 정렬하여 정규화
  const paddedBuffers = await Promise.all(
    frames.map(async (f, i) => {
      const w = metaList[i].width ?? frameW;
      const h = metaList[i].height ?? frameH;
      return sharp({
        create: { width: frameW, height: frameH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
      })
        .png()
        .composite([{
          input: f.filePath,
          left: Math.floor((frameW - w) / 2),
          top: Math.floor((frameH - h) / 2),
        }])
        .toBuffer();
    })
  );

  // 레이아웃 결정: cols 인자 우선, 없으면 정사각형 sqrt 그리드
  const cellW = frameW + padding;
  const cellH = frameH + padding;
  let effectiveCols = cols && cols > 0 ? Math.min(cols, frames.length) : Math.ceil(Math.sqrt(frames.length));
  let rows = Math.ceil(frames.length / effectiveCols);
  let sheetW = effectiveCols * cellW - padding;
  let sheetH = rows * cellH - padding;

  // 한도 검사 + 자동 그리드 재배치
  // - 1×N 가로 스트립이 WebP 16,383px 한도를 넘기는 케이스가 가장 흔함
  // - 한도 안에 들어가는 cols로 줄이고 rows를 늘려 재배치
  if (sheetW > maxSheetDim || sheetH > maxSheetDim) {
    const maxColsByWidth = Math.max(1, Math.floor((maxSheetDim + padding) / cellW));
    const maxRowsByHeight = Math.max(1, Math.floor((maxSheetDim + padding) / cellH));
    const capacity = maxColsByWidth * maxRowsByHeight;

    if (frames.length > capacity) {
      throw new Error(
        `spritesheet 합성 실패: 프레임 ${frames.length}개 × ${frameW}×${frameH}는 ` +
        `단일 시트 한도(${maxSheetDim}px)에 들어갈 수 없습니다 ` +
        `(최대 그리드 ${maxColsByWidth}×${maxRowsByHeight}=${capacity}프레임). ` +
        `해결책: (1) frame_render_size로 프레임 다운스케일 (2) maxSheetDim을 ` +
        `WEBP_HARD_LIMIT(${WEBP_HARD_LIMIT})까지 올리되 모바일 GPU 텍스처 한도에 ` +
        `주의 (3) 시트 분할 / 개별 프레임 + manifest로 사용.`
      );
    }

    const oldCols = effectiveCols;
    // 한도 내에서 가능한 가장 정사각형에 가까운 그리드를 선택
    const idealCols = Math.min(maxColsByWidth, Math.ceil(Math.sqrt(frames.length)));
    effectiveCols = Math.max(1, Math.min(maxColsByWidth, idealCols));
    rows = Math.ceil(frames.length / effectiveCols);
    sheetW = effectiveCols * cellW - padding;
    sheetH = rows * cellH - padding;

    // stderr로 안내 — MCP stdout은 오염하면 안 됨
    console.error(
      `[spritesheet-composer] ${oldCols}×${Math.ceil(frames.length / oldCols)} 레이아웃이 ` +
      `한도(${maxSheetDim}px) 초과 → ${effectiveCols}×${rows} 그리드로 자동 재배치 ` +
      `(${sheetW}×${sheetH}px)`
    );
  }

  // 각 프레임의 좌표 계산 + composite 입력 준비
  type SharpComposite = { input: Buffer; left: number; top: number };
  const compositeInputs: SharpComposite[] = [];
  const positionedFrames: ComposedSheet["frames"] = [];

  for (let i = 0; i < frames.length; i++) {
    const col = i % effectiveCols;
    const row = Math.floor(i / effectiveCols);
    const x = col * cellW;
    const y = row * cellH;

    compositeInputs.push({ input: paddedBuffers[i], left: x, top: y });
    positionedFrames.push({ ...frames[i], x, y, w: frameW, h: frameH });
  }

  // Resolve format — engine-aware by default, caller can force via `format`
  const resolvedFormat: ImageFormat = format ?? resolveOutputFormat();
  const parsed = path.parse(outputPath);
  const finalPath = path.join(parsed.dir, `${parsed.name}.${resolvedFormat}`);

  let pipeline = sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  }).composite(compositeInputs);

  if (resolvedFormat === "webp") {
    pipeline = pipeline.webp({
      quality: 90,
      alphaQuality: 100,
      effort: 4,
      smartSubsample: true,
    });
  } else {
    pipeline = pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
    });
  }

  await pipeline.toFile(finalPath);

  return {
    sheetPath: finalPath,
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    frameWidth: frameW,
    frameHeight: frameH,
    cols: effectiveCols,
    rows,
    frames: positionedFrames,
  };
}

// ─── Phaser JSON Atlas ────────────────────────────────────────────────────────

export function exportPhaserAtlas(
  sheet: ComposedSheet,
  outputPath: string
): string {
  const frames: Record<string, unknown> = {};

  for (const f of sheet.frames) {
    frames[f.name] = {
      frame: { x: f.x, y: f.y, w: f.w, h: f.h },
      rotated: false,
      trimmed: false,
      spriteSourceSize: { x: 0, y: 0, w: f.w, h: f.h },
      sourceSize: { w: f.w, h: f.h },
    };
  }

  const atlas = {
    frames,
    meta: {
      app: "minigame-assets-mcp",
      version: "1.0",
      image: path.basename(sheet.sheetPath),
      format: "RGBA8888",
      size: { w: sheet.sheetWidth, h: sheet.sheetHeight },
      scale: "1",
    },
  };

  fs.writeFileSync(outputPath, JSON.stringify(atlas, null, 2));
  return outputPath;
}

// ─── Cocos Creator .plist ─────────────────────────────────────────────────────

export function exportCocosPlist(
  sheet: ComposedSheet,
  outputPath: string
): string {
  // Frame identifier extension conventionally matches the sheet's format
  const sheetExt = path.extname(sheet.sheetPath).slice(1) || "png"; // "webp" or "png"
  const frameEntries = sheet.frames
    .map((f) => {
      // Cocos2d 포맷: {{x,y},{w,h}} (y축은 bottom-up이므로 변환 필요)
      const cocosY = sheet.sheetHeight - f.y - f.h;
      return `
    <key>${f.name}.${sheetExt}</key>
    <dict>
      <key>frame</key>
      <string>{{${f.x},${cocosY}},{${f.w},${f.h}}}</string>
      <key>offset</key>
      <string>{0,0}</string>
      <key>rotated</key>
      <false/>
      <key>sourceColorRect</key>
      <string>{{0,0},{${f.w},${f.h}}}</string>
      <key>sourceSize</key>
      <string>{${f.w},${f.h}}</string>
    </dict>`;
    })
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>frames</key>
  <dict>${frameEntries}
  </dict>
  <key>metadata</key>
  <dict>
    <key>format</key>
    <integer>2</integer>
    <key>realTextureFileName</key>
    <string>${path.basename(sheet.sheetPath)}</string>
    <key>size</key>
    <string>{${sheet.sheetWidth},${sheet.sheetHeight}}</string>
    <key>smartupdate</key>
    <string>$TexturePacker:SmartUpdate:minigame-assets-mcp$</string>
    <key>textureFileName</key>
    <string>${path.basename(sheet.sheetPath)}</string>
  </dict>
</dict>
</plist>`;

  fs.writeFileSync(outputPath, plist);
  return outputPath;
}

// ─── Unity JSON (TexturePacker Unity 포맷 호환) ───────────────────────────────

export function exportUnityJson(
  sheet: ComposedSheet,
  characterName: string,
  outputPath: string
): string {
  // Unity Sprite Editor가 이해하는 TexturePacker Unity 포맷
  // 또는 프로젝트에 포함할 수 있는 커스텀 에디터 스크립트용 JSON
  const sprites = sheet.frames.map((f) => ({
    name: f.name,
    x: f.x,
    y: f.y,             // Unity는 top-down 좌표 (PNG와 동일)
    width: f.w,
    height: f.h,
    pivot: { x: 0.5, y: 0.5 },
    border: { x: 0, y: 0, z: 0, w: 0 },
  }));

  // 액션별 애니메이션 클립 정보
  const animations: Record<string, { frameNames: string[]; frameRate: number }> = {};
  const actionMap = new Map<string, string[]>();
  for (const f of sheet.frames) {
    if (!actionMap.has(f.action)) actionMap.set(f.action, []);
    actionMap.get(f.action)!.push(f.name);
  }
  for (const [action, frameNames] of actionMap) {
    animations[action] = {
      frameNames,
      frameRate: action === "idle" ? 8 : action === "walk" ? 12 : 10,
    };
  }

  const unityData = {
    meta: {
      generator: "minigame-assets-mcp",
      image: path.basename(sheet.sheetPath),
      size: { w: sheet.sheetWidth, h: sheet.sheetHeight },
      characterName,
      // Unity Sprite Editor 가이드
      importInstructions: [
        "1. Import the PNG file into Unity Assets",
        "2. Select the texture, set Texture Type to 'Sprite (2D and UI)'",
        "3. Set Sprite Mode to 'Multiple'",
        "4. Open Sprite Editor > Slice > Type: Grid By Cell Size",
        `5. Cell Size: ${sheet.frameWidth} x ${sheet.frameHeight}`,
        "6. Or use the JSON with a custom Editor script for automatic slicing",
      ],
    },
    sprites,
    animations,
  };

  fs.writeFileSync(outputPath, JSON.stringify(unityData, null, 2));
  return outputPath;
}
