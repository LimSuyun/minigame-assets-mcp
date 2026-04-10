import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";

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
  padding: number = 0
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

  // 정사각형에 가까운 그리드 계산
  const cols = Math.ceil(Math.sqrt(frames.length));
  const rows = Math.ceil(frames.length / cols);

  const cellW = frameW + padding;
  const cellH = frameH + padding;
  const sheetW = cols * cellW - padding;
  const sheetH = rows * cellH - padding;

  // 각 프레임의 좌표 계산 + composite 입력 준비
  type SharpComposite = { input: Buffer; left: number; top: number };
  const compositeInputs: SharpComposite[] = [];
  const positionedFrames: ComposedSheet["frames"] = [];

  for (let i = 0; i < frames.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = col * cellW;
    const y = row * cellH;

    compositeInputs.push({ input: paddedBuffers[i], left: x, top: y });
    positionedFrames.push({ ...frames[i], x, y, w: frameW, h: frameH });
  }

  // 투명 배경 캔버스에 정규화된 프레임 합성
  await sharp({
    create: {
      width: sheetW,
      height: sheetH,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    },
  })
    .composite(compositeInputs)
    .png()
    .toFile(outputPath);

  return {
    sheetPath: outputPath,
    sheetWidth: sheetW,
    sheetHeight: sheetH,
    frameWidth: frameW,
    frameHeight: frameH,
    cols,
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
  const frameEntries = sheet.frames
    .map((f) => {
      // Cocos2d 포맷: {{x,y},{w,h}} (y축은 bottom-up이므로 변환 필요)
      const cocosY = sheet.sheetHeight - f.y - f.h;
      return `
    <key>${f.name}.png</key>
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
