/**
 * pose-skeleton.ts
 *
 * OpenPose-스타일 스켈레톤 PNG를 순수 SVG + Sharp로 생성합니다.
 * 외부 API 호출 없이 동작합니다.
 *
 * 좌표계: 모두 0.0~1.0 정규화값. (0,0) = 좌상단, (1,1) = 우하단.
 * 렌더링 시 canvasSize(px)에 곱해 픽셀 좌표로 변환합니다.
 *
 * 치비 비율 기준값:
 *   - 머리 중심 y ≈ 0.18, 반지름 ≈ 0.10 (머리가 전체의 ~40%)
 *   - 목        y ≈ 0.32
 *   - 어깨      y ≈ 0.38 (L x=0.36, R x=0.64)
 *   - 엉덩이    y ≈ 0.62 (L x=0.44, R x=0.56)
 *   - 무릎      y ≈ 0.74
 *   - 발목      y ≈ 0.86
 */

import sharp from "sharp";

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export interface PoseKeypoints {
  label: string;             // 프레임 이름 (표시용)
  promptHint: string;        // 이 포즈에 대한 한 줄 설명 (프롬프트에 주입)
  head: [number, number];    // [cx, cy]
  neck: [number, number];
  rShoulder: [number, number];
  lShoulder: [number, number];
  rElbow: [number, number];
  lElbow: [number, number];
  rWrist: [number, number];
  lWrist: [number, number];
  rHip: [number, number];
  lHip: [number, number];
  rKnee: [number, number];
  lKnee: [number, number];
  rAnkle: [number, number];
  lAnkle: [number, number];
  staffTip: [number, number];   // 오브(발광체) 끝
  staffGrip: [number, number];  // 손이 잡는 지점
  staffBase: [number, number];  // 지팡이 하단
}

// ─── 9프레임 마법봉 스윙 포즈 정의 ──────────────────────────────────────────

export const WAND_SWING_POSES: PoseKeypoints[] = [
  {
    label: "f00_ready",
    promptHint: "idle ready stance — holding staff diagonally at right side, body relaxed, both feet flat on ground",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.38], lShoulder: [0.36, 0.38],
    rElbow:    [0.73, 0.46], lElbow:    [0.28, 0.50],
    rWrist:    [0.78, 0.36], lWrist:    [0.22, 0.62],
    rHip: [0.56, 0.62], lHip: [0.44, 0.62],
    rKnee: [0.55, 0.74], lKnee: [0.43, 0.74],
    rAnkle: [0.54, 0.86], lAnkle: [0.42, 0.86],
    staffTip: [0.90, 0.10], staffGrip: [0.78, 0.36], staffBase: [0.62, 0.70],
  },
  {
    label: "f01_windup_start",
    promptHint: "beginning wind-up — right arm pulling back and upward, staff going behind and above the head",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.66, 0.36], lShoulder: [0.36, 0.40],
    rElbow:    [0.80, 0.30], lElbow:    [0.30, 0.52],
    rWrist:    [0.86, 0.18], lWrist:    [0.24, 0.64],
    rHip: [0.56, 0.62], lHip: [0.44, 0.62],
    rKnee: [0.56, 0.74], lKnee: [0.44, 0.74],
    rAnkle: [0.55, 0.86], lAnkle: [0.43, 0.86],
    staffTip: [0.96, 0.06], staffGrip: [0.86, 0.18], staffBase: [0.70, 0.54],
  },
  {
    label: "f02_windup_peak",
    promptHint: "full wind-up at peak — staff raised completely overhead, right arm fully extended upward, body coiled",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.36], lShoulder: [0.38, 0.40],
    rElbow:    [0.72, 0.18], lElbow:    [0.32, 0.52],
    rWrist:    [0.62, 0.05], lWrist:    [0.26, 0.64],
    rHip: [0.57, 0.64], lHip: [0.43, 0.64],
    rKnee: [0.58, 0.76], lKnee: [0.42, 0.76],
    rAnkle: [0.58, 0.86], lAnkle: [0.40, 0.86],
    staffTip: [0.64, 0.02], staffGrip: [0.62, 0.05], staffBase: [0.56, 0.44],
  },
  {
    label: "f03_swing_start",
    promptHint: "swing initiated — staff arcing forward at 45 degrees above horizontal, arm driving forward aggressively",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.38], lShoulder: [0.36, 0.40],
    rElbow:    [0.74, 0.26], lElbow:    [0.30, 0.52],
    rWrist:    [0.82, 0.36], lWrist:    [0.24, 0.62],
    rHip: [0.56, 0.62], lHip: [0.44, 0.62],
    rKnee: [0.56, 0.74], lKnee: [0.44, 0.74],
    rAnkle: [0.55, 0.86], lAnkle: [0.43, 0.86],
    staffTip: [0.94, 0.22], staffGrip: [0.82, 0.36], staffBase: [0.62, 0.64],
  },
  {
    label: "f04_swing_mid",
    promptHint: "mid-swing — staff horizontal at chest height, right arm fully extended to the right",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.38], lShoulder: [0.36, 0.40],
    rElbow:    [0.76, 0.38], lElbow:    [0.30, 0.52],
    rWrist:    [0.88, 0.40], lWrist:    [0.24, 0.62],
    rHip: [0.56, 0.62], lHip: [0.44, 0.62],
    rKnee: [0.56, 0.74], lKnee: [0.44, 0.74],
    rAnkle: [0.55, 0.86], lAnkle: [0.43, 0.86],
    staffTip: [0.98, 0.36], staffGrip: [0.88, 0.40], staffBase: [0.68, 0.48],
  },
  {
    label: "f05_impact",
    promptHint: "impact moment — staff fully extended forward at waist height, magical energy burst exploding from the staff tip",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.40], lShoulder: [0.36, 0.40],
    rElbow:    [0.76, 0.46], lElbow:    [0.30, 0.50],
    rWrist:    [0.86, 0.50], lWrist:    [0.24, 0.60],
    rHip: [0.56, 0.63], lHip: [0.44, 0.63],
    rKnee: [0.56, 0.74], lKnee: [0.44, 0.74],
    rAnkle: [0.55, 0.86], lAnkle: [0.43, 0.86],
    staffTip: [0.96, 0.46], staffGrip: [0.86, 0.50], staffBase: [0.64, 0.60],
  },
  {
    label: "f06_magic_release",
    promptHint: "magic projectile/orb shooting from staff tip — large glowing magical sphere launching forward, sparks and particles radiating outward, same forward stance as impact",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.40], lShoulder: [0.36, 0.40],
    rElbow:    [0.76, 0.46], lElbow:    [0.30, 0.50],
    rWrist:    [0.86, 0.50], lWrist:    [0.24, 0.60],
    rHip: [0.56, 0.63], lHip: [0.44, 0.63],
    rKnee: [0.56, 0.74], lKnee: [0.44, 0.74],
    rAnkle: [0.55, 0.86], lAnkle: [0.43, 0.86],
    staffTip: [0.96, 0.46], staffGrip: [0.86, 0.50], staffBase: [0.64, 0.60],
  },
  {
    label: "f07_follow_through",
    promptHint: "follow-through — staff swinging past forward and angling downward, arm momentum continuing, residual magic sparks dissipating",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.40], lShoulder: [0.36, 0.40],
    rElbow:    [0.74, 0.52], lElbow:    [0.30, 0.50],
    rWrist:    [0.78, 0.62], lWrist:    [0.24, 0.60],
    rHip: [0.56, 0.63], lHip: [0.44, 0.63],
    rKnee: [0.56, 0.74], lKnee: [0.44, 0.74],
    rAnkle: [0.55, 0.86], lAnkle: [0.43, 0.86],
    staffTip: [0.84, 0.58], staffGrip: [0.78, 0.62], staffBase: [0.58, 0.72],
  },
  {
    label: "f08_recovery",
    promptHint: "recovery — returning to guard/ready stance, staff rising back to diagonal position, body straightening, expression calm",
    head: [0.50, 0.18], neck: [0.50, 0.32],
    rShoulder: [0.64, 0.38], lShoulder: [0.36, 0.38],
    rElbow:    [0.72, 0.48], lElbow:    [0.28, 0.50],
    rWrist:    [0.76, 0.40], lWrist:    [0.22, 0.62],
    rHip: [0.56, 0.62], lHip: [0.44, 0.62],
    rKnee: [0.55, 0.74], lKnee: [0.43, 0.74],
    rAnkle: [0.54, 0.86], lAnkle: [0.42, 0.86],
    staffTip: [0.88, 0.14], staffGrip: [0.76, 0.40], staffBase: [0.60, 0.72],
  },
];

// ─── SVG 생성 ─────────────────────────────────────────────────────────────────

const COLORS = {
  bg: "#000000",
  head: "#FFD700",      // 황금색 — 머리
  spine: "#FFFFFF",     // 흰색   — 척추
  rArm: "#FF6600",      // 주황색 — 오른팔
  lArm: "#4FC3F7",      // 하늘색 — 왼팔
  rLeg: "#66BB6A",      // 초록색 — 오른다리
  lLeg: "#CE93D8",      // 보라색 — 왼다리
  staff: "#A0522D",     // 갈색   — 지팡이
  staffOrb: "#00FFFF",  // 시안색 — 지팡이 오브
  magicBurst: "#FFFF00", // 노란색 — 마법 폭발 (f05, f06)
};

function px(norm: number, size: number): number {
  return Math.round(norm * size);
}

function line(
  x1: number, y1: number, x2: number, y2: number,
  color: string, width: number
): string {
  return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
}

function circle(cx: number, cy: number, r: number, fill: string): string {
  return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${fill}"/>`;
}

function buildSkeletonSVG(pose: PoseKeypoints, size: number): string {
  const s = (n: number) => px(n, size);
  const bw = Math.max(4, Math.round(size * 0.022));   // bone line width
  const aw = Math.max(3, Math.round(size * 0.016));   // arm line width
  const jr = Math.max(5, Math.round(size * 0.018));   // joint radius
  const hr = Math.max(20, Math.round(size * 0.095));  // head radius
  const sw = Math.max(4, Math.round(size * 0.020));   // staff width

  const [hx, hy] = pose.head.map(n => s(n));
  const [nx, ny] = pose.neck.map(n => s(n));
  const [rsx, rsy] = pose.rShoulder.map(n => s(n));
  const [lsx, lsy] = pose.lShoulder.map(n => s(n));
  const [rex, rey] = pose.rElbow.map(n => s(n));
  const [lex, ley] = pose.lElbow.map(n => s(n));
  const [rwx, rwy] = pose.rWrist.map(n => s(n));
  const [lwx, lwy] = pose.lWrist.map(n => s(n));
  const [rhx, rhy] = pose.rHip.map(n => s(n));
  const [lhx, lhy] = pose.lHip.map(n => s(n));
  const [rkx, rky] = pose.rKnee.map(n => s(n));
  const [lkx, lky] = pose.lKnee.map(n => s(n));
  const [rax, ray] = pose.rAnkle.map(n => s(n));
  const [lax, lay] = pose.lAnkle.map(n => s(n));
  const [stx, sty] = pose.staffTip.map(n => s(n));
  const [sgx, sgy] = pose.staffGrip.map(n => s(n));
  const [sbx, sby] = pose.staffBase.map(n => s(n));

  const hipCx = Math.round((rhx + lhx) / 2);
  const hipCy = Math.round((rhy + lhy) / 2);

  // f05/f06: 마법 폭발 표시
  const isMagicFrame = pose.label.includes("impact") || pose.label.includes("magic");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <!-- 배경 -->
  <rect width="${size}" height="${size}" fill="${COLORS.bg}"/>

  <!-- 지팡이 -->
  ${line(stx, sty, sbx, sby, COLORS.staff, sw)}

  <!-- 척추 (목 → 엉덩이 중심) -->
  ${line(nx, ny, hipCx, hipCy, COLORS.spine, bw)}
  <!-- 어깨 라인 -->
  ${line(lsx, lsy, rsx, rsy, COLORS.spine, Math.round(bw * 0.7))}
  <!-- 엉덩이 라인 -->
  ${line(lhx, lhy, rhx, rhy, COLORS.spine, Math.round(bw * 0.7))}

  <!-- 오른팔 (주황) -->
  ${line(rsx, rsy, rex, rey, COLORS.rArm, aw)}
  ${line(rex, rey, rwx, rwy, COLORS.rArm, aw)}

  <!-- 왼팔 (하늘) -->
  ${line(lsx, lsy, lex, ley, COLORS.lArm, aw)}
  ${line(lex, ley, lwx, lwy, COLORS.lArm, aw)}

  <!-- 오른다리 (초록) -->
  ${line(rhx, rhy, rkx, rky, COLORS.rLeg, bw)}
  ${line(rkx, rky, rax, ray, COLORS.rLeg, bw)}

  <!-- 왼다리 (보라) -->
  ${line(lhx, lhy, lkx, lky, COLORS.lLeg, bw)}
  ${line(lkx, lky, lax, lay, COLORS.lLeg, bw)}

  <!-- 관절 원 -->
  ${circle(rsx, rsy, jr, COLORS.rArm)}
  ${circle(lsx, lsy, jr, COLORS.lArm)}
  ${circle(rex, rey, jr, COLORS.rArm)}
  ${circle(lex, ley, jr, COLORS.lArm)}
  ${circle(rwx, rwy, jr, COLORS.rArm)}
  ${circle(lwx, lwy, jr, COLORS.lArm)}
  ${circle(rhx, rhy, jr, COLORS.rLeg)}
  ${circle(lhx, lhy, jr, COLORS.lLeg)}
  ${circle(rkx, rky, jr, COLORS.rLeg)}
  ${circle(lkx, lky, jr, COLORS.lLeg)}
  ${circle(rax, ray, jr, COLORS.rLeg)}
  ${circle(lax, lay, jr, COLORS.lLeg)}
  ${circle(nx, ny, Math.round(jr * 0.8), COLORS.spine)}

  <!-- 지팡이 오브 (시안 원) -->
  ${circle(stx, sty, Math.round(jr * 1.4), COLORS.staffOrb)}
  <!-- 지팡이 그립 -->
  ${circle(sgx, sgy, Math.round(jr * 0.8), COLORS.staff)}

  <!-- 마법 폭발 표시 (f05, f06) -->
  ${isMagicFrame ? `
  <circle cx="${stx}" cy="${sty}" r="${Math.round(size * 0.06)}" fill="none" stroke="${COLORS.magicBurst}" stroke-width="${Math.round(bw * 0.8)}" stroke-dasharray="6,4" opacity="0.8"/>
  <circle cx="${stx}" cy="${sty}" r="${Math.round(size * 0.10)}" fill="none" stroke="${COLORS.magicBurst}" stroke-width="${Math.round(bw * 0.5)}" stroke-dasharray="4,6" opacity="0.5"/>` : ""}

  <!-- 머리 (황금 원, 마지막에 렌더링) -->
  ${circle(hx, hy, hr, COLORS.head)}
  <!-- 얼굴 방향 표시 (오른쪽 눈 위치) -->
  ${circle(Math.round(hx + hr * 0.28), Math.round(hy - hr * 0.08), Math.round(jr * 0.7), "#000000")}

  <!-- 프레임 레이블 -->
  <text x="8" y="${size - 8}" font-family="monospace" font-size="${Math.round(size * 0.028)}" fill="white" opacity="0.7">${pose.label}</text>
</svg>`;
}

// ─── 공개 API ─────────────────────────────────────────────────────────────────

/**
 * PoseKeypoints를 기반으로 OpenPose-스타일 스켈레톤 PNG Buffer를 생성합니다.
 * @param pose   포즈 정의
 * @param size   캔버스 크기(px), 기본 512
 */
export async function generateSkeletonPng(
  pose: PoseKeypoints,
  size: number = 512
): Promise<Buffer> {
  const svg = buildSkeletonSVG(pose, size);
  return sharp(Buffer.from(svg))
    .resize(size, size)
    .png()
    .toBuffer();
}

/**
 * WAND_SWING_POSES 전체를 PNG Buffer 배열로 반환합니다.
 */
export async function generateAllSkeletonPngs(
  size: number = 512
): Promise<Array<{ pose: PoseKeypoints; buffer: Buffer }>> {
  return Promise.all(
    WAND_SWING_POSES.map(async (pose) => ({
      pose,
      buffer: await generateSkeletonPng(pose, size),
    }))
  );
}

/**
 * 9개 스켈레톤을 하나의 가로 스트립 "액션 가이드" 이미지로 합성합니다.
 *
 * 레이아웃: [f00][sep][f01][sep]...[f08]  (1행 9열)
 * 상단에 프레임 번호, 하단에 포즈 이름을 표시합니다.
 *
 * @param poses      포즈 배열 (기본: WAND_SWING_POSES)
 * @param frameSize  각 스켈레톤 셀 크기(px), 기본 256
 * @param sepWidth   프레임 간 구분선 너비(px), 기본 3
 */
export async function generateSkeletonActionGuide(
  poses: PoseKeypoints[] = WAND_SWING_POSES,
  frameSize: number = 256,
  sepWidth: number = 3,
): Promise<Buffer> {
  const labelH = Math.round(frameSize * 0.16);  // 상단 레이블 영역 높이
  const cellH = frameSize + labelH;
  const totalW = poses.length * frameSize + (poses.length - 1) * sepWidth;
  const totalH = cellH;

  // 개별 스켈레톤 생성
  const skelBuffers = await Promise.all(poses.map(p => generateSkeletonPng(p, frameSize)));

  // 상단 레이블 SVG (프레임 번호 + 포즈명) 를 각 셀에 추가
  const labeledCells = await Promise.all(
    skelBuffers.map(async (skelBuf, i) => {
      const pose = poses[i];
      const fontSize = Math.max(10, Math.round(frameSize * 0.055));
      const labelSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="${frameSize}" height="${labelH}">
        <rect width="${frameSize}" height="${labelH}" fill="#111111"/>
        <text x="${Math.round(frameSize / 2)}" y="${Math.round(labelH * 0.52)}"
          font-family="monospace" font-size="${fontSize}" font-weight="bold"
          fill="#FFD700" text-anchor="middle" dominant-baseline="middle">${i + 1}</text>
        <text x="${Math.round(frameSize / 2)}" y="${Math.round(labelH * 0.85)}"
          font-family="monospace" font-size="${Math.round(fontSize * 0.72)}"
          fill="#AAAAAA" text-anchor="middle" dominant-baseline="middle"
        >${pose.label.replace(/^f\d+_/, "")}</text>
      </svg>`;
      const labelBuf = await sharp(Buffer.from(labelSvg)).png().toBuffer();

      // 레이블 위 + 스켈레톤 아래로 수직 합성
      return sharp({
        create: { width: frameSize, height: cellH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
      })
        .composite([
          { input: labelBuf, left: 0, top: 0 },
          { input: skelBuf, left: 0, top: labelH },
        ])
        .png()
        .toBuffer();
    })
  );

  // 구분선 버퍼
  const sepBuf = await sharp({
    create: { width: sepWidth, height: cellH, channels: 4, background: { r: 60, g: 60, b: 60, alpha: 255 } },
  }).png().toBuffer();

  // 가로로 합성
  const composites: Array<{ input: Buffer; left: number; top: number }> = [];
  for (let i = 0; i < labeledCells.length; i++) {
    composites.push({ input: labeledCells[i], left: i * (frameSize + sepWidth), top: 0 });
    if (i < labeledCells.length - 1) {
      composites.push({ input: sepBuf, left: i * (frameSize + sepWidth) + frameSize, top: 0 });
    }
  }

  return sharp({
    create: { width: totalW, height: totalH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 255 } },
  })
    .composite(composites)
    .png()
    .toBuffer();
}
