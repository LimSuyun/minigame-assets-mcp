import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { execFileSync } from "child_process";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, NO_TEXT_IN_IMAGE, NO_SHADOW_IN_IMAGE, CHIBI_STYLE_DEFAULT, CLEAN_LINE_STYLE_DEFAULT } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";

import {
  buildAssetPath,
  generateFileName,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import {
  composeSpritSheet,
  exportPhaserAtlas,
  exportCocosPlist,
  exportUnityJson,
  exportGodotTres,
  type FrameInfo,
} from "../utils/spritesheet-composer.js";
import { handleApiError } from "../utils/errors.js";
import { processFrameBase64, removeBackground, compositeOntoSolidBg, processFrameBase64AI, processFrameBase64Chroma, addPaddingToBuffer, sliceGridIntoFrames } from "../utils/image-process.js";
import { writeOptimized, resolveOutputFormat } from "../utils/image-output.js";
import { loadConceptHint, hasSoftStyle } from "../utils/concept-loader.js";
import { checkSpriteFrameQuality } from "../services/vision-qc.js";
import { editImageOpenAI } from "../services/openai.js";
import { safeRefinePrompt, type PromptTargetModel } from "../services/gpt5-prompt.js";
import { startLatencyTracker, buildCostTelemetry, buildEditCostTelemetry } from "../utils/cost-tracking.js";
import type { GeneratedAsset } from "../types.js";

// ─── 기본 액션 세트 ──────────────────────────────────────────────────────────

export const DEFAULT_ACTIONS = [
  "idle",
  "walk",
  "run",
  "jump",
  "attack",
  "hurt",
  "die",
] as const;

export type DefaultAction = (typeof DEFAULT_ACTIONS)[number];

// 각 액션별 포즈 설명 (buildActionEditPrompt 및 sequential 2번째+ 프레임에서 사용)
export const ACTION_PROMPTS: Record<DefaultAction, string> = {
  idle: "neutral idle standing pose, body relaxed, subtle weight shift to one side",
  walk: "mid-walk pose, one leg stepping forward, arms naturally swinging in opposition",
  run: "running pose, body leaning slightly forward, legs in a full running stride",
  jump: "at the peak of a jump, body slightly curled, legs bent upward",
  attack: "attack pose — arm or weapon raised and thrusting forward with force",
  hurt: "hurt/damaged reaction — leaning back slightly, grimacing expression, arms up defensively",
  die: "falling or knocked-down pose, body going limp toward the ground",
};

// 각 액션 첫 프레임 전용: "관찰 가능한 증거(you must see)" 언어로 모델이 추상적 해석으로
// 중립 자세를 그대로 복사하는 anchor-copy 경향을 억제.
// ACTION_PROMPTS보다 훨씬 구체적이고 시각적인 묘사 사용.
export const ACTION_FRAME0_PROMPTS: Record<DefaultAction, string> = {
  idle:
    "relaxed standing: both feet planted shoulder-width apart, arms hanging loosely at sides — " +
    "baseline resting pose, no action",
  walk:
    "mid-stride walking — you must see: one foot FORWARD and planted, other foot BEHIND and pushing off, " +
    "legs clearly separated in a stride. Left arm swings forward as right leg steps forward, " +
    "right arm swings back — clear left-right asymmetry between limbs",
  run:
    "sprinting at full pace — you must see: body pitched FORWARD 15–25 degrees, " +
    "leading knee RAISED to waist level, trailing leg FULLY EXTENDED behind, " +
    "both arms bent at ~90 degrees and pumping — unmistakable high-speed running posture",
  jump:
    "peak of a jump — you must see: BOTH FEET completely off the ground with visible air beneath them, " +
    "knees pulled UP toward the chest, arms raised or spread wide for balance — " +
    "the character is unambiguously airborne, not touching any surface",
  attack:
    "moment of attack impact — you must see: attack arm or weapon FULLY EXTENDED at maximum forward reach, " +
    "torso twisted into the strike, non-attacking arm pulled backward as counterbalance, " +
    "feet planted wide apart for power — fist or weapon is at its absolute farthest point",
  hurt:
    "hit reaction — you must see: torso snapping BACKWARD from impact, " +
    "head thrown back or to the side, both arms raised DEFENSIVELY in front of the face — " +
    "entire upper body leans backward, opposite of normal upright stance",
  die:
    "actively collapsing — you must see: body losing vertical balance, " +
    "knees buckling DOWNWARD, torso pitching forward or sideways, " +
    "arms going limp or flailing outward — character is clearly in the act of falling, not standing",
};

// ─── Grid 모드 전용: 프레임 단계 묘사 ─────────────────────────────────────────
//
// 액션당 한 번의 API 호출로 N×N 그리드 이미지를 생성할 때 사용하는 각 셀(프레임)의 포즈 묘사.
// 4프레임(2×2)과 9프레임(3×3) 두 가지 세트를 제공한다.
// 각 묘사는 "관찰 가능한 시각 증거(you must see)" 패턴으로 작성해
// 모델이 추상적 해석 대신 구체적 포즈를 생성하도록 강제한다.

const GRID_FRAMES_4: Record<string, string[]> = {
  idle: [
    "f1 — neutral baseline: feet shoulder-width apart, arms loosely at sides, weight evenly on both feet, eyes forward",
    "f2 — subtle weight shift right: left heel barely lifted (1-2 px), body tilted ~2° to the right, right knee very slightly bent",
    "f3 — subtle weight shift left: right heel barely lifted, body tilted ~2° to the left, left knee very slightly bent",
    "f4 — back to neutral: posture IDENTICAL to f1 — this is a seamless loop, so f4 must match f1 exactly",
  ],
  walk: [
    "f1 — LEFT foot heel striking the ground forward, RIGHT foot back on toes pushing off, RIGHT arm swings forward",
    "f2 — weight fully transferred to LEFT foot, RIGHT leg swinging forward past center, both arms near neutral crossing",
    "f3 — RIGHT foot heel striking the ground forward, LEFT foot back on toes pushing off, LEFT arm swings forward",
    "f4 — weight fully transferred to RIGHT foot, LEFT leg swinging forward past center — completing one full walk cycle",
  ],
  run: [
    "f1 — LEFT foot explosive push-off, body pitched 20° forward, RIGHT knee raised HIGH to waist level",
    "f2 — full airborne phase: BOTH feet off ground, body nearly horizontal, both arms pumping at ~90°",
    "f3 — RIGHT foot landing, knee bent DEEP absorbing impact, LEFT leg trailing behind",
    "f4 — RIGHT foot explosive push-off mirror, body pitched forward, LEFT knee raised HIGH — ready to loop back",
  ],
  jump: [
    "f1 — pre-jump crouch: knees bent 45°, hips lowered, arms pulled back and bent for momentum",
    "f2 — launch: legs fully extended pushing off, feet JUST leaving the ground, arms rising",
    "f3 — apex: feet at MAXIMUM height off ground, knees pulled UP toward chest, arms spread wide for balance",
    "f4 — landing: feet touching ground, knees bent DEEP absorbing impact, arms dropping for balance",
  ],
  attack: [
    "f1 — wind-up: weapon or dominant arm pulled FAR back behind body, weight on rear foot, torso twisted away",
    "f2 — strike initiation: weight transferring forward, arm beginning forward arc, torso unwinding",
    "f3 — IMPACT: arm/weapon at FULL EXTENSION at maximum forward reach, torso fully rotated into strike",
    "f4 — follow-through: arm continuing past impact, weight forward, body beginning to recover toward neutral",
  ],
  hurt: [
    "f1 — impact instant: torso SNAPPING backward from the hit, head thrown back or to the side",
    "f2 — recoil peak: body leaned back ~30°, BOTH arms raised DEFENSIVELY shielding the face",
    "f3 — arms lowering, torso starting to straighten, regaining balance",
    "f4 — recovered: near-upright posture, arms down, slightly tense but stable",
  ],
  die: [
    "f1 — first stagger: ONE knee beginning to buckle inward, torso pitching forward ~20°, arms losing control",
    "f2 — collapse: BOTH knees near the floor, torso at ~45°, arms reaching toward the ground",
    "f3 — falling: body near-horizontal, hands and knees touching the floor, head drooping down",
    "f4 — FINAL REST: entire body completely HORIZONTAL and motionless on the floor, all limbs limp and spread",
  ],
};

const GRID_FRAMES_9: Record<string, string[]> = {
  idle: [
    "f1 — neutral baseline: feet shoulder-width, arms at sides, weight centered, eyes forward",
    "f2 — inhale beginning: chest rising slightly, shoulders lifting a fraction",
    "f3 — full inhale: chest at peak rise, chin slightly lifted",
    "f4 — exhale beginning: chest starting to lower, shoulders relaxing",
    "f5 — full exhale: body at natural rest low-point, slight shoulder drop",
    "f6 — weight shift right starting: left heel micro-lift, body gently leaning 1°",
    "f7 — weight shift right peak: left heel slightly raised, right foot flat",
    "f8 — weight returning to center: both feet flat, body vertical again",
    "f9 — back to neutral: IDENTICAL to f1 — seamless loop",
  ],
  walk: [
    "f1 — LEFT heel striking down forward, RIGHT foot back on toes, RIGHT arm forward",
    "f2 — LEFT foot fully flat, weight on it, RIGHT leg swinging past LEFT",
    "f3 — RIGHT heel striking down forward, LEFT foot back on toes, LEFT arm forward",
    "f4 — RIGHT foot fully flat, weight on it, LEFT leg swinging past RIGHT",
    "f5 — LEFT heel striking again (second cycle start), RIGHT arm forward",
    "f6 — LEFT foot flat, weight on it, RIGHT leg beginning to swing",
    "f7 — mid-step: RIGHT foot passing LEFT, arms crossing center",
    "f8 — RIGHT heel preparing to strike, LEFT arm coming forward",
    "f9 — RIGHT heel touching down — ready to loop seamlessly back to f1",
  ],
  run: [
    "f1 — LEFT foot push-off: body 20° lean, RIGHT knee at waist",
    "f2 — airborne: both feet off ground, knees pulled up, arms at 90°",
    "f3 — RIGHT foot landing: knee bent deep, LEFT foot trailing",
    "f4 — RIGHT foot push-off: body 20° lean, LEFT knee at waist",
    "f5 — airborne again: both feet off, body near-horizontal",
    "f6 — LEFT foot landing: knee bent deep, RIGHT foot trailing",
    "f7 — LEFT foot push-off (third cycle): RIGHT knee rising",
    "f8 — peak airborne: maximum height, both knees pulled up",
    "f9 — landing approach: feet descending, knees prepared — loops back",
  ],
  jump: [
    "f1 — standing relaxed: anticipating the jump",
    "f2 — deep crouch: knees at ~90°, hips at lowest point, arms pulling back",
    "f3 — explosive extension: legs straightening fast, just leaving the ground",
    "f4 — low ascent: feet ~15% above ground, arms rising",
    "f5 — mid ascent: feet ~35% above ground, knees bending up",
    "f6 — apex: feet at MAXIMUM height, knees fully pulled up, arms spread wide",
    "f7 — mid descent: feet ~35% above ground, preparing to land",
    "f8 — low descent: feet ~15% above ground, legs extending downward",
    "f9 — landing: feet touching ground, knees bent DEEP, arms stabilizing",
  ],
  attack: [
    "f1 — battle stance: feet wide apart, weapon or arm ready at side",
    "f2 — wind-up starts: arm drawing back, weight shifting to rear foot",
    "f3 — full wind-up: arm at MAXIMUM retraction, torso twisted away from target",
    "f4 — swing initiation: arm starting forward arc, torso beginning to unwind",
    "f5 — mid swing: arm at 90° angle, torso halfway rotated, weight transferring",
    "f6 — IMPACT: arm at FULL EXTENSION, torso fully rotated into strike, peak force",
    "f7 — immediate follow-through: arm continuing past the impact point",
    "f8 — follow-through complete: arm at end of arc, weight fully forward",
    "f9 — recovery: returning to battle stance, ready again",
  ],
  hurt: [
    "f1 — neutral standing: no damage yet",
    "f2 — impact instant: torso snapping backward, head thrown back",
    "f3 — recoil: body bent backward ~20°, arms starting to raise",
    "f4 — recoil peak: maximum backward lean ~30°, arms at full shield position",
    "f5 — trembling: body slightly shaking, arms still raised defensively",
    "f6 — recovery beginning: arms lowering slightly, torso tilting forward",
    "f7 — mid-recovery: arms at chest height, more upright",
    "f8 — nearly recovered: arms down, slight defensive tension remains",
    "f9 — recovered: upright stance, arms at sides, slightly tense",
  ],
  die: [
    "f1 — upright standing: normal pose, one moment before collapse",
    "f2 — first buckle: one knee giving way inward, body pitching forward 15°",
    "f3 — double buckle: both knees bending, hips dropping, body at 30°",
    "f4 — heavy stumble: knees near floor, torso at 45°, arms flailing for balance",
    "f5 — knees hit floor: both knees on the floor, upper body still falling forward",
    "f6 — chest falling: upper body pitching toward floor, arms out to catch weight",
    "f7 — on all fours: hands and knees on floor, head still up",
    "f8 — sliding down: body sliding forward, arms giving out, head dropping",
    "f9 — FINAL REST: body completely HORIZONTAL and still on the floor, all limbs limp",
  ],
};

/** 액션별 지면선 특이사항 주석 — 그리드 프롬프트에 삽입됨 */
function getGroundPlaneNote(action: string): string {
  switch (action) {
    case "die":
      return (
        "GROUND PLANE CRITICAL: The floor is at 88% from the cell top (lower than other actions to " +
        "accommodate the fallen body). As the character collapses, all movement stays above this floor — " +
        "nothing goes below it. The FINAL frame must show the character lying COMPLETELY HORIZONTAL with " +
        "the body resting ON this floor line. The floor is invisible but absolute."
      );
    case "jump":
      return (
        "JUMP GROUND EXCEPTION: Feet START at the 82% ground line in f1 (crouch), RISE ABOVE it during " +
        "ascent frames, reaching maximum height at the apex, then RETURN to 82% at landing. " +
        "The feet must never go below 82%."
      );
    case "hurt":
      return (
        "HURT GROUND NOTE: Feet remain PLANTED at the 82% ground line in ALL frames — only the upper " +
        "body rocks backward during the hurt reaction. The feet must not leave the ground."
      );
    case "walk":
    case "run":
      return (
        "LOCOMOTION GROUND NOTE: The ground line is at 82%. Feet alternate touching this line — one " +
        "foot is always near 82%, the other swings forward or backward. No foot goes below 82%."
      );
    default:
      return "GROUND LINE: character's feet must be at the 82% line from the top of each cell in all frames.";
  }
}

/**
 * 그리드 모드 전용 프롬프트 빌더.
 * 단일 API 호출로 N×N 그리드 이미지를 생성하도록 설계됨.
 * 모든 프레임이 동일 컨텍스트에서 생성되어 크기·지면선 일관성이 sequential 방식보다 높다.
 */
function buildGridGenerationPrompt(
  action: string,
  gridSize: 2 | 3,
  characterHint?: string,
  bgRulesOverride?: string,
): string {
  const totalFrames = gridSize * gridSize;
  const cellPx = Math.floor(1024 / gridSize);
  const frameDescsMap = gridSize === 2 ? GRID_FRAMES_4 : GRID_FRAMES_9;
  const isPreset = DEFAULT_ACTIONS.includes(action as DefaultAction);
  const frameDescs: string[] = frameDescsMap[action]
    ?? Array.from({ length: totalFrames }, (_, i) =>
      `f${i + 1} — ${action} animation at ${Math.round((i / (totalFrames - 1)) * 100)}% through the motion cycle`
    );

  const rowNames = ["top", "middle", "bottom"];
  const colNames = gridSize === 2 ? ["left", "right"] : ["left", "center", "right"];
  const cellLines: string[] = [];
  for (let r = 0; r < gridSize; r++) {
    for (let c = 0; c < gridSize; c++) {
      const idx = r * gridSize + c;
      cellLines.push(`  Cell ${idx + 1} (${rowNames[r]}-${colNames[c]}): ${frameDescs[idx] ?? `frame ${idx + 1}`}`);
    }
  }

  const bgRules = bgRulesOverride
    ? `${bgRulesOverride}. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`
    : `${WHITE_BG_PROMPT}. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

  const groundNote = getGroundPlaneNote(action);

  return [
    `Generate a ${gridSize}×${gridSize} sprite animation grid for a 2D game character.`,
    ``,
    `REFERENCE IMAGE ROLE: The reference shows this character in a NEUTRAL STANDING POSE.`,
    `Copy from it ONLY: face design, body proportions, hair/eye/skin colors, outfit, accessories.`,
    `Do NOT copy the standing pose into any cell — each cell has a specific animation pose described below.`,
    ``,
    `OUTPUT FORMAT (mandatory):`,
    `- Output image: 1024×1024 pixels total`,
    `- Grid: ${gridSize} columns × ${gridSize} rows = ${totalFrames} cells`,
    `- Each cell: exactly ${cellPx}×${cellPx} pixels`,
    `- NO gaps, NO borders, NO labels between cells — pure edge-to-edge grid`,
    `- Cells ordered left-to-right, top-to-bottom`,
    ``,
    `CHARACTER CONSISTENCY — ALL ${totalFrames} CELLS MUST MATCH:`,
    `- Character HEIGHT: must be PIXEL-IDENTICAL in every cell — absolutely NO shrinking or growing`,
    `- Character SCALE: the same body occupies the same proportion of each cell in all frames`,
    `- ${groundNote}`,
    `- HEAD CLEARANCE: head top must stay below 12% from the cell top — leave top margin`,
    `- FULL BODY: entire body from head to feet visible in every cell — no clipping allowed`,
    `- ONE CHARACTER per cell — no duplicates, no extra figures`,
    ...(isPreset ? [] : [`- This is a custom action: "${action}" — show the character clearly performing it`]),
    ``,
    `ANIMATION CONTENT — "${action}" cycle:`,
    ...cellLines,
    ``,
    characterHint ? `Character context: ${characterHint}.` : "",
    bgRules,
  ].filter(Boolean).join("\n");
}

/**
 * 단일 API 호출로 모든 액션을 한 장의 그리드 이미지에 생성하는 프롬프트.
 * 각 셀 = 서로 다른 액션의 대표 포즈.
 * 모든 액션이 동일 컨텍스트에서 생성 → 캐릭터 일관성 최고, API 1회 호출.
 */
function buildMultiActionSheetPrompt(
  actions: string[],
  gridSize: 2 | 3,
  characterHint?: string,
  bgRulesOverride?: string,
): string {
  const totalCells = gridSize * gridSize;
  const cellPx = Math.floor(1024 / gridSize);
  const rowNames = ["top", "middle", "bottom"];
  const colNames = gridSize === 2 ? ["left", "right"] : ["left", "center", "right"];

  const cellLines: string[] = [];
  for (let i = 0; i < Math.min(actions.length, totalCells); i++) {
    const action = actions[i];
    const r = Math.floor(i / gridSize);
    const c = i % gridSize;
    const isPreset = DEFAULT_ACTIONS.includes(action as DefaultAction);
    const poseDesc = isPreset
      ? ACTION_FRAME0_PROMPTS[action as DefaultAction]
      : action;
    cellLines.push(
      `  Cell ${i + 1} (${rowNames[r]}-${colNames[c]}) [${action.toUpperCase()}]: ${poseDesc}`,
    );
  }
  for (let i = actions.length; i < totalCells; i++) {
    const r = Math.floor(i / gridSize);
    const c = i % gridSize;
    cellLines.push(
      `  Cell ${i + 1} (${rowNames[r]}-${colNames[c]}): EMPTY — background only, no character`,
    );
  }

  const bgRules = bgRulesOverride
    ? `${bgRulesOverride}. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`
    : `${WHITE_BG_PROMPT}. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

  return [
    `Generate a ${gridSize}×${gridSize} multi-action sprite sheet for a 2D game character.`,
    ``,
    `REFERENCE IMAGE ROLE: The reference shows this character in a neutral standing pose.`,
    `Copy from it ONLY: exact face design, body proportions, colors, outfit, accessories.`,
    `Do NOT copy the standing pose — each cell has a specific different action described below.`,
    ``,
    `OUTPUT FORMAT (mandatory):`,
    `- Total image: 1024×1024 pixels`,
    `- Grid: ${gridSize} columns × ${gridSize} rows = ${totalCells} cells, each exactly ${cellPx}×${cellPx} pixels`,
    `- NO gaps, NO borders, NO labels between cells — pure seamless edge-to-edge grid`,
    `- Cells ordered: left-to-right, top-to-bottom`,
    ``,
    `CHARACTER CONSISTENCY (CRITICAL — all non-empty cells):`,
    `- IDENTICAL character design in every cell — same face, same outfit, same colors, same proportions`,
    `- Character HEIGHT must be PIXEL-IDENTICAL in every cell — absolutely no scale variation`,
    `- Ground line at 82% from cell top — feet anchor at this line (except jump apex, die final pose)`,
    `- FULL BODY visible in every cell — head, ears, paws, tail — nothing clipped`,
    `- ONE character per cell — no duplicates, no extra figures`,
    ``,
    `CELL CONTENTS (each cell shows a DIFFERENT action):`,
    ...cellLines,
    ``,
    characterHint ? `Character context: ${characterHint}.` : "",
    bgRules,
  ].filter(Boolean).join("\n");
}

/**
 * 일관성 유지 특화 편집 프롬프트 생성.
 * gpt_image_gen_mcp 방식: "Redraw this exact character..." 패턴.
 * 투명 배경 지시어 포함 (흰 배경만 제거, 캐릭터 내부 흰색은 보존).
 */
// 순백 배경 방식 — 배경은 순백(#FFFFFF), 캐릭터 내 순백 사용 금지
const WHITE_BG_COLOR: [number, number, number] = [255, 255, 255];
// flood-fill 제거 임계값: R,G,B 모두 이 값 초과 픽셀만 배경으로 제거 (순백에 가까운 픽셀만 제거)
const WHITE_BG_THRESHOLD = 250;
const WHITE_BG_PROMPT =
  "pure white (#FFFFFF) background — perfectly uniform solid white, " +
  "absolutely no gradients, no shadows, no texture on the background. " +
  "CRITICAL: the character itself must NOT contain any pure white (#FFFFFF) pixels — " +
  "use off-white or light cream (at most rgb(220,220,220)) for any light-colored areas on the character";

function buildActionEditPrompt(
  poseDescription: string,
  characterHint?: string,
  bgPromptOverride?: string,
): string {
  const bgInstruction = bgPromptOverride ?? WHITE_BG_PROMPT;
  return (
    `Redraw this exact character in the following pose or action: ${poseDescription}. ` +
    `Preserve every visual detail from the reference image exactly — ` +
    `same face, same body shape and proportions, same outfit and colors, same accessories and items. ` +
    `Only the pose or action changes. Nothing is added or removed. ` +
    (characterHint ? `Character description for reference: ${characterHint}. ` : "") +
    `CRITICAL — framing and body visibility: ` +
    `The ENTIRE body from the very top of the head to the very tips of the feet MUST be fully visible — NEVER clip or cut off any body part. ` +
    `If the action requires more space, make the character SMALLER to fit — do NOT crop. ` +
    `The character must NOT exceed 70% of the total image height. ` +
    `Leave at least 15% empty margin at the top and 15% at the bottom. ` +
    `Keep the same camera distance and framing as the reference. ` +
    `${bgInstruction}. ` +
    `${NO_SHADOW_IN_IMAGE} ` +
    `${NO_TEXT_IN_IMAGE}`
  );
}

// ─── Sequential 프레임 (Anchor + Prev) 패턴 헬퍼 ─────────────────────────────
//
// 시퀀스 모드 전용. 각 프레임이 (a) 디자인 anchor 와 (b) 직전 프레임 두 reference
// 를 동시에 받아 디자인 동결 + 모션 연속성을 동시에 확보한다.

/**
 * 액션별 디폴트 프레임 수 — 의미 있는 애니메이션 사이클을 위한 권장값.
 * 사용자가 frames_per_action 또는 prompt_file 로 명시하지 않을 때 사용.
 */
export const ACTION_FRAME_DEFAULTS: Record<string, number> = {
  idle:   5,
  walk:   6,
  run:    6,
  jump:   5,
  attack: 5,
  hurt:   5,
  die:    6,
};

/** 시퀀스 모드 글로벌 최소 프레임 (사용자 직접 지정도 이 값 미만으로 강등되진 않음). */
export const SEQUENTIAL_MIN_FRAMES = 5;

/**
 * 액션·프레임 위치별 모션 단계 묘사. 모델에게 "30% through" 같은 모호한 비율 대신
 * 구체적 단계 (wind-up, mid-stride, impact 등) 를 제공해 일관성 향상.
 */
function describeMotionStage(action: string, frameIdx: number, total: number): string {
  if (total <= 1) return "static pose";
  const ratio = frameIdx / (total - 1);
  switch (action) {
    case "walk":
      if (ratio < 0.2) return "left foot starting to step forward, weight on right";
      if (ratio < 0.4) return "left foot mid-step, body weight transferring forward";
      if (ratio < 0.6) return "weight centered, both feet near ground";
      if (ratio < 0.8) return "right foot starting to step forward, weight on left";
      return "right foot mid-step, returning toward starting cycle";
    case "run":
      if (ratio < 0.2) return "left foot push-off, body forward lean";
      if (ratio < 0.4) return "airborne phase, both feet off ground";
      if (ratio < 0.6) return "right foot strike, knee bent absorbing impact";
      if (ratio < 0.8) return "right foot push-off";
      return "left foot strike, returning toward cycle start";
    case "jump":
      if (ratio < 0.2) return "crouch wind-up, knees bent deep";
      if (ratio < 0.4) return "leaping upward, legs extending";
      if (ratio < 0.6) return "peak of jump, body slightly curled";
      if (ratio < 0.8) return "descending, legs preparing to land";
      return "landing, knees absorbing impact";
    case "attack":
      if (ratio < 0.2) return "wind-up, weapon or arm pulled back for strike";
      if (ratio < 0.4) return "swing trajectory, weapon mid-motion";
      if (ratio < 0.6) return "impact moment, peak force";
      if (ratio < 0.8) return "follow-through after the hit";
      return "recovery to neutral stance";
    case "hurt":
      if (ratio < 0.25) return "moment of impact, body recoiling backward";
      if (ratio < 0.5) return "leaning back, arms up defensively, grimacing";
      if (ratio < 0.75) return "starting to recover, weight returning forward";
      return "back to balanced stance, slightly tensed";
    case "die":
      if (ratio < 0.2) return "first impact, body buckling";
      if (ratio < 0.4) return "knees giving way, falling forward";
      if (ratio < 0.6) return "body falling, arms loose";
      if (ratio < 0.8) return "near ground, body collapsed";
      return "rest on ground, completely limp";
    case "idle":
    default:
      if (ratio < 0.2) return "neutral baseline stance";
      if (ratio < 0.4) return "subtle inhale, chest slightly raised";
      if (ratio < 0.6) return "weight shifting slightly to one side";
      if (ratio < 0.8) return "exhale, chest lowering";
      return "returning to baseline";
  }
}

interface SequentialPromptArgs {
  action: string;
  frameIdx: number;
  totalFrames: number;
  isFirst: boolean;
  characterHint?: string;
  customAction?: string; // 프리셋 외 액션 이름이면 그대로 사용
  bgRulesOverride?: string; // 미지정 시 WHITE_BG_PROMPT 사용. 크로마키 모드에서는 buildChromaBgPrompt() 결과 전달
}

/**
 * Sequential anchor+prev 프롬프트 빌더.
 *  - isFirst=true: 1개 reference (anchor) — 시퀀스 시작 포즈 생성
 *  - isFirst=false: 2개 reference (anchor + prev) — 디자인 동결 + 모션 연속
 */
function buildSequentialFramePrompt(args: SequentialPromptArgs): string {
  const { action, frameIdx, totalFrames, isFirst, characterHint } = args;
  const isPreset = DEFAULT_ACTIONS.includes(action as DefaultAction);
  const poseDesc = isPreset ? ACTION_PROMPTS[action as DefaultAction] : action;
  const stage = describeMotionStage(action, frameIdx, totalFrames);
  const progressPct = totalFrames > 1
    ? Math.round((frameIdx / (totalFrames - 1)) * 100)
    : 0;

  const framingRules =
    `FRAMING (mandatory): the ENTIRE body — top of head to tips of feet — must be fully visible, ` +
    `never clipped. Character ≤ 70% of image height, ≥ 15% margin top and bottom. ` +
    `Same camera distance and framing as the references.`;

  const bgRules = args.bgRulesOverride
    ? `${args.bgRulesOverride}. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`
    : `${WHITE_BG_PROMPT}. ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

  if (isFirst) {
    // 첫 프레임은 ACTION_FRAME0_PROMPTS의 "you must see" 언어를 사용해
    // anchor-copy 경향(레퍼런스 포즈를 그대로 복사하는 현상)을 억제한다.
    const frame0Pose = isPreset
      ? ACTION_FRAME0_PROMPTS[action as DefaultAction]
      : action;

    return [
      `Generate Frame 1 of ${totalFrames} for the "${action}" animation cycle.`,
      ``,
      `REFERENCE IMAGE ROLE: The reference shows this character in a NEUTRAL STANDING POSE.`,
      `Copy from the reference ONLY: face appearance, body proportions, hair/skin/eye colors, outfit design, accessories.`,
      `Do NOT copy the body stance or pose from the reference — the pose comes from the instructions below.`,
      ``,
      `POSE TO GENERATE (this takes priority over whatever pose the reference shows):`,
      frame0Pose,
      ``,
      characterHint ? `Character description: ${characterHint}.` : "",
      framingRules,
      bgRules,
    ].filter(Boolean).join(" ");
  }

  return [
    `Generate Frame ${frameIdx + 1} of ${totalFrames} for the "${action}" animation cycle.`,
    `Pose progress: ${progressPct}% — ${stage}.`,
    ``,
    `INPUTS:`,
    `- FIRST reference image is the CHARACTER ANCHOR. Use it ONLY to preserve every visual detail of the character: face, body shape and proportions, outfit and colors, accessories. The character design must be IDENTICAL to this reference, regardless of the second reference's quality.`,
    `- SECOND reference image is the IMMEDIATELY PREVIOUS FRAME of this same animation cycle. Use it ONLY to determine the smooth motion transition. Advance the pose by a SMALL natural step from this previous state — do not skip stages.`,
    ``,
    `Target pose for this frame: ${poseDesc} at the "${stage}" stage.`,
    `Progress smoothly from the previous frame; the pose should look like a single tween step forward in time, not a fresh redraw.`,
    characterHint ? `Character description: ${characterHint}.` : "",
    ``,
    framingRules,
    bgRules,
  ].filter(Boolean).join(" ");
}

/**
 * 처리된 transparent buffer 를 단색 배경(보통 magenta) 위에 합성해 임시 PNG 로 저장.
 * 다음 sequential 프레임 호출의 reference 로 사용된다.
 */
async function writeBufferOnSolidBgToTmp(
  buf: Buffer,
  bgColor: [number, number, number],
  outPath: string,
): Promise<void> {
  const { default: sharp } = await import("sharp");
  const meta = await sharp(buf).metadata();
  const w = meta.width ?? 1024;
  const h = meta.height ?? 1024;
  const composed = await sharp({
    create: {
      width: w,
      height: h,
      channels: 4,
      background: { r: bgColor[0], g: bgColor[1], b: bgColor[2], alpha: 1 },
    },
  })
    .composite([{ input: buf, blend: "over" }])
    .png()
    .toBuffer();
  fs.writeFileSync(outPath, composed);
}

// 크로마키 색상 목록 (캐릭터에 사용되지 않을 색상 권장)
export const CHROMA_KEY_COLORS: Record<string, [number, number, number]> = {
  magenta:   [255,   0, 255],
  lime:      [  0, 255,   0],
  cyan:      [  0, 255, 255],
  blue:      [  0,   0, 255],
};

export const DEFAULT_CHROMA_KEY = "magenta";

function chromaKeyColorToName(color: [number, number, number]): string {
  const [r, g, b] = color;
  return `rgb(${r},${g},${b}) — solid flat color, no gradients, no shadows, no texture`;
}

/**
 * 크로마키 색상에 맞는 배경 지시 프롬프트 생성.
 * buildBaseCharacterPrompt의 chromaKey 분기와 동일 패턴.
 * WHITE_BG_PROMPT 대신 이 값을 사용하면 배경 제거(processFrameBase64Chroma)와 정합.
 */
function buildChromaBgPrompt(color: [number, number, number]): string {
  const [r, g, b] = color;
  return (
    `Solid flat rgb(${r},${g},${b}) background — perfectly uniform single color, ` +
    `absolutely no gradients, no shadows, no texture on the background. ` +
    `CRITICAL: the character must NOT contain any rgb(${r},${g},${b}) or visually similar colored pixels — ` +
    `use only natural character colors (skin, cloth, metal, leather, and organic tones)`
  );
}

// ─── 헬퍼 함수 ───────────────────────────────────────────────────────────────

function readImageAsBase64(filePath: string): { base64: string; mimeType: string } {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Character base image not found: ${resolved}`);
  }
  const data = fs.readFileSync(resolved);
  const base64 = data.toString("base64");
  const ext = path.extname(resolved).toLowerCase();
  const mimeType =
    ext === ".jpg" || ext === ".jpeg" ? "image/jpeg" :
    ext === ".webp" ? "image/webp" :
    "image/png";
  return { base64, mimeType };
}

export type CharacterRole = "player" | "enemy" | "monster" | "npc" | "generic";

const ROLE_GUIDANCE: Record<CharacterRole, string> = {
  player:
    "Heroic protagonist — distinctive appealing silhouette players want to embody. " +
    "Balanced proportions, confident neutral stance, hero-grade detailing on outfit and accessories.",
  enemy:
    "Antagonistic humanoid opponent — threatening silhouette with contrasting color palette to typical hero colors. " +
    "Hostile but not grotesque, clear visual threat readability, battle-worn attire.",
  monster:
    "Creature or beast — non-humanoid forms allowed (quadruped, winged, amorphous, etc.). " +
    "Organic menacing presence, natural textures (fur, scales, chitin), expressive hostile features. " +
    "Full body visible including all limbs/tails/wings.",
  npc:
    "Supporting background character — approachable neutral design, distinctive enough to remember " +
    "but visually quieter than hero characters. Profession or role visible through attire. " +
    "Friendly or merchant-like demeanor.",
  generic: "",
};

function buildBaseCharacterPrompt(
  description: string,
  conceptHint: string,
  chromaKeyColor?: [number, number, number],
  role: CharacterRole = "generic"
): string {
  const bgInstruction = chromaKeyColor
    ? `Solid flat ${chromaKeyColorToName(chromaKeyColor)} background — uniform single color, no gradients, no shadows on the background itself.`
    : `transparent background.`;

  const roleGuidance = ROLE_GUIDANCE[role];

  // 컨셉에 soft/watercolor 스타일이 없으면 CHIBI_STYLE_DEFAULT 위에 clean line 기본 주입.
  const cleanLineNote = hasSoftStyle(conceptHint) ? "" : `${CLEAN_LINE_STYLE_DEFAULT}. `;

  return (
    `A single 2D game character sprite on a ${bgInstruction} ` +
    `${CHIBI_STYLE_DEFAULT} ` +
    cleanLineNote +
    (roleGuidance ? `CHARACTER ROLE: ${roleGuidance} ` : "") +
    `Character: ${description}. ` +
    `Neutral front-facing stance, body relaxed, arms at sides. ` +
    `ENTIRE full body visible — top of head to very tips of feet, all accessories included. ` +
    `Character must NOT exceed 65% of image height — leave at least 15% margin at top and 20% at bottom. ` +
    (conceptHint ? `Color palette reference: ${conceptHint} ` : "") +
    `${NO_SHADOW_IN_IMAGE} ` +
    `${NO_TEXT_IN_IMAGE}`
  );
}

// ─── 스프라이트 매니페스트 ────────────────────────────────────────────────────

interface SpriteFrame {
  name: string;
  file_path: string;
  file_name: string;
  action: string;
  frame_index: number;
}

interface SpriteSheetManifest {
  character_name: string;
  base_character_path: string;
  frames: SpriteFrame[];
  animations: Record<string, string[]>;
  created_at: string;
  provider: string;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerSpriteTools(server: McpServer): void {
  // ── 1. 기본 캐릭터 생성 ────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_character_base",
    {
      title: "Generate Base Character Sprite",
      description: `Generate the original base character sprite for a game (default: OpenAI gpt-image-2 + 마젠타 크로마키).

**Target Layer**: GameScene **Layer 2 (유닛)** — 플레이어/적/몬스터/NPC 공통. 자세한 레이어 매핑은 \`templates/docs/layer-system.md\` 참조.

**CONCEPT.md 우선 확인:** 에셋 생성 요청 시 .minigame-assets/CONCEPT.md 파일이 있는지 확인하세요.
파일이 있으면 아트 스타일, 색상 팔레트, 존 테마, 프롬프트 파일 경로를 읽고 추가 질문 없이 바로 생성을 진행하세요.

This creates the "master" character image that all action sprites will be derived from.
After generating, use asset_generate_sprite_sheet
to create action variants using gpt-image-2 image editing (preserving the original design).

gpt-image-2는 투명 배경을 지원하지 않으므로 내부적으로 마젠타(#FF00FF) 배경 위에 생성 후
크로마키 제거(residue 패스 포함) → 투명 PNG로 저장됩니다. 네이티브 투명이 필요하면
\`model\`에 \`gpt-image-1\` 계열을 명시하세요 (예: "gpt-image-1", "gpt-image-1-mini").

**Performance note**: gpt-image-2 high-quality는 ~90~120초 소요 (gpt-image-1 ~40초 대비 2~3× 느림).
베이스는 캐릭터당 1회만 생성하므로 실용적이며, 디테일 품질 향상이 큰 편.

Args:
  - character_name (string): Identifier for this character (used in file names)
  - description (string): Detailed character description (appearance, clothing, style, etc.)
  - model (string, optional): Model override. Defaults to "gpt-image-2". Alternatives: "gpt-image-1", "gpt-image-1-mini" (네이티브 투명), "gpt-image-1.5"
  - size (string, optional): For OpenAI — "1024x1024" (default), "1024x1792"
  - aspect_ratio (string, optional): "1:1" (default) or "3:4"
  - chroma_key_bg (string, optional): 크로마키 색상 override. gpt-image-2에서는 미지정 시 "magenta" 자동 적용.
  - bg_threshold (number, optional): White background removal threshold 0-255 (default: 240)
  - use_concept (boolean, optional): Inject game concept into prompt (default: true)
  - concept_file (string, optional): Path to game concept JSON
  - output_dir (string, optional): Output directory

Returns:
  File path of the saved base character image (transparent PNG) and asset metadata.
  Save the file_path — you will pass it to sprite generation tools.`,
      inputSchema: z.object({
        character_name: z.string().min(1).max(100).describe("Character identifier (e.g., hero, enemy_slime)"),
        description: z.string().min(10).max(3000).describe("Detailed character appearance description"),
        role: z.enum(["player", "enemy", "monster", "npc", "generic"]).default("generic")
          .describe("캐릭터 역할. player(주인공)·enemy(인간형 적)·monster(생물/괴수)·npc(주변 캐릭터)에 맞는 실루엣·컬러팔레트·디테일 가이던스 자동 주입. generic은 중립."),
        model: z.string().optional().describe("Model override. Default: gpt-image-2 (최고 품질, 마젠타 크로마키 자동 적용). 대안: gpt-image-1, gpt-image-1-mini (네이티브 투명, 빠름) | gpt-image-1.5"),
        size: z.enum(["1024x1024", "1024x1792", "1536x1024", "1024x1536"]).default("1024x1024").describe("Image size (OpenAI only)"),
        aspect_ratio: z.enum(["1:1", "3:4"]).default("1:1").describe("Aspect ratio"),
        bg_threshold: z.number().int().min(0).max(255).default(240).describe("White background removal threshold (0-255). Ignored when using gpt-image-1 native transparent or any chroma_key_bg."),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("Chroma key background color override. gpt-image-2 기본 경로는 'magenta' 자동 적용(residue 패스로 내부 포켓까지 제거). gpt-image-1 계열은 미지정 시 네이티브 투명."),
        refine_prompt: z.boolean().default(false)
          .describe("GPT-5(기본: gpt-5.4-nano)로 description을 상세 영문 프롬프트로 확장 후 이미지 생성. 짧은 한국어 입력이나 디테일이 부족한 경우 권장. 추가 지연 ~3초 + 소량 토큰 비용. 기본: false"),
        use_concept: z.boolean().default(true).describe("Inject game concept into prompt"),
        concept_file: z.string().optional().describe("Path to game concept JSON"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const latency = startLatencyTracker();
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const conceptFile = params.concept_file || DEFAULT_CONCEPT_FILE;
        const conceptHint = params.use_concept ? loadConceptHint(conceptFile) : "";

        // 기본 모델: gpt-image-2 (투명 미지원 → 마젠타 크로마키 자동 적용).
        // 사용자가 gpt-image-1 계열을 명시하면 네이티브 투명 경로 유지.
        const effectiveModel = params.model ?? "gpt-image-2";
        const supportsNativeTransparent = effectiveModel.startsWith("gpt-image-1");

        // gpt-image-2는 투명 미지원이라 chroma_key_bg 미지정 시 magenta 자동 적용.
        // 그러면 프롬프트에 magenta 배경 지시어가 들어가고 removeBackground(chromaKey)로 제거됨.
        const effectiveChromaBgKey: keyof typeof CHROMA_KEY_COLORS | undefined =
          params.chroma_key_bg ?? (supportsNativeTransparent ? undefined : "magenta");
        const chromaKeyColor = effectiveChromaBgKey
          ? CHROMA_KEY_COLORS[effectiveChromaBgKey] as [number, number, number]
          : undefined;

        // GPT-5 프롬프트 리파인 (opt-in)
        const { text: descriptionForPrompt, refined: refinedByGPT5 } = await safeRefinePrompt({
          enabled: params.refine_prompt,
          text: params.description,
          targetModel: effectiveModel as PromptTargetModel,
          assetType: "character",
          conceptHint,
          toolName: "character_base",
        });

        const prompt = buildBaseCharacterPrompt(
          `${descriptionForPrompt}. This is the BASE reference character — all details must be precise and consistent.`,
          conceptHint,
          chromaKeyColor,
          params.role
        );

        let base64: string;
        let mimeType: string;

        const r = await generateImageOpenAI({
            prompt,
            model: effectiveModel as
              | "gpt-image-2"
              | "gpt-image-1.5"
              | "gpt-image-1"
              | "gpt-image-1-mini",
            size: params.size,
            quality: "high",
            // gpt-image-2는 resolveBackground shim이 "auto"로 자동 강등함.
            // gpt-image-1 계열은 그대로 "transparent" 전송됨.
            background: "transparent",
        });
        base64 = r.base64;
        mimeType = r.mimeType;

        // gpt-image-1 계열만 네이티브 투명 PNG 반환 → 후처리 생략.
        // gpt-image-2는 chromaKeyColor(기본 magenta) 경로로 크로마키 제거 + residue 패스.
        let processedBuffer: Buffer;
        let processedBase64: string;
        if (supportsNativeTransparent) {
          processedBuffer = Buffer.from(base64, "base64");
          processedBase64 = base64;
        } else if (chromaKeyColor) {
          // 크로마키 모드: 임시 파일에 저장 후 색상 거리 기반 배경 제거
          const tmpIn = path.join(
            process.env["TMPDIR"] || "/tmp",
            `chroma_in_${Date.now()}_${Math.random().toString(36).slice(2)}.png`
          );
          const tmpOut = tmpIn.replace("_in_", "_out_");
          try {
            fs.writeFileSync(tmpIn, Buffer.from(base64, "base64"));
            await removeBackground(tmpIn, tmpOut, {
              chromaKeyColor,
              cropToContent: true,
            });
            processedBuffer = fs.readFileSync(tmpOut);
            processedBase64 = processedBuffer.toString("base64");
          } finally {
            if (fs.existsSync(tmpIn)) fs.unlinkSync(tmpIn);
            if (fs.existsSync(tmpOut)) fs.unlinkSync(tmpOut);
          }
        } else {
          processedBuffer = await processFrameBase64(base64, params.bg_threshold);
          processedBase64 = processedBuffer.toString("base64");
        }

        const safeCharName = params.character_name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const pathBase = buildAssetPath(outputDir, `sprites/${safeCharName}`, `${safeCharName}_base.png`);
        const written = await writeOptimized(processedBuffer, pathBase);
        const filePath = written.path;
        const fileName = path.basename(filePath);

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "image",
          asset_type: "character",
          provider: "openai",
          prompt: params.description,
          file_path: filePath,
          file_name: fileName,
          mime_type: written.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            character_name: params.character_name,
            is_base_character: true,
            role: params.role,
            role_guidance_injected: params.role !== "generic",
            refined_by_gpt5: refinedByGPT5,
            ...(refinedByGPT5 ? { refined_prompt: descriptionForPrompt } : {}),
            ...buildCostTelemetry(effectiveModel, "high", params.size, latency.elapsed()),
          },
        };

        saveAssetToRegistry(asset, outputDir);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                success: true,
                character_name: params.character_name,
                file_path: filePath,
                asset_id: asset.id,
                provider: "openai",
                model: effectiveModel,
                refined_by_gpt5: refinedByGPT5,
                note: "Transparent PNG saved. Pass file_path to asset_generate_sprite_sheet.",
              }, null, 2),
            },
          ],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Base") }],
          isError: true,
        };
      }
    }
  );

  // ── 1-b. 장비 결합 베이스 (Base + Equipment → Equipped Base) ────────────
  server.registerTool(
    "asset_generate_character_equipped",
    {
      title: "Generate Character with Equipment (Equipped Base)",
      description: `베이스 캐릭터에 장비(무기, 방어구, 악세서리)를 장착한 **새 베이스 이미지**를 생성합니다.
결과물은 투명 배경 PNG로 저장되어 \`asset_generate_sprite_sheet\`에 그대로 재사용 가능합니다.

**Target Layer**: GameScene **Layer 2 (유닛)** — base character와 동일 레이어. 자세한 레이어 매핑은 \`templates/docs/layer-system.md\` 참조.

**생성 방식** (gpt-image-2 edit + 마젠타 크로마키):
1. \`base_character_path\` (원본 베이스)와 \`equipment_image_paths\` (실제 무기/방어구 PNG들, 최대 4개)를
   gpt-image-2 edit API에 다중 레퍼런스로 전달
2. AI가 캐릭터 디자인 보존 + 장비 자연스럽게 착용한 새 씬 생성 (마젠타 배경으로 유도)
3. removeBackground(chromaKey=magenta) + residue 패스로 겨드랑이·팔 포켓까지 깔끔 제거
4. 출력: \`sprites/{character_name}/{character_name}_{variant_name}_base.png\`

**사용 예**:
1. 먼저 \`asset_generate_character_base\`로 맨몸 베이스 생성 → hero_base.png
2. \`asset_generate_weapons\`로 무기 아이콘 생성 → sword.png
3. \`asset_generate_character_equipped\` 호출:
   - base_character_path: hero_base.png
   - equipment_image_paths: [sword.png]
   - equipment_description: "wielding the sword in right hand"
   → hero_equipped_base.png 생성
4. \`asset_generate_sprite_sheet\`에 \`base_character_path: hero_equipped_base.png\`로 전달하여 장비 착용 상태 스프라이트 시트 생성

Args:
  - base_character_path (string): 원본 베이스 캐릭터 이미지 경로 (투명 PNG)
  - character_name (string): 캐릭터 식별자 (파일 네이밍용)
  - equipment_description (string): 장비 착용 방법 설명 (예: "holding a wooden bow in left hand, leather helmet on head")
  - equipment_image_paths (array, optional): 장비 PNG 파일 경로들 (최대 4개). 제공 시 캐릭터와 함께 gpt-image-2 edit 레퍼런스로 전달
  - variant_name (string, optional): 파일명 접미사 (기본: "equipped")
  - model (string, optional): OpenAI 모델. 기본: gpt-image-2
  - refine_prompt (boolean, optional): GPT-5로 equipment_description 확장 (기본: false)
  - output_dir (string, optional): 출력 디렉토리

Returns:
  새 베이스 이미지 경로 + 스프라이트 시트 호출 예시.`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("원본 베이스 캐릭터 PNG 경로"),
        character_name: z.string().min(1).max(100).describe("캐릭터 식별자"),
        equipment_description: z.string().min(5).max(1500)
          .describe("장비 착용 설명 (영문 권장). 예: 'wielding long sword in right hand, round steel shield in left hand, chainmail armor'"),
        equipment_image_paths: z.array(z.string()).max(4).optional()
          .describe("장비 레퍼런스 PNG 경로들 (무기/방어구 etc., 최대 4개). 제공 시 AI가 해당 장비 시각을 참고해 일관성 유지"),
        variant_name: z.string().min(1).max(50).default("equipped")
          .describe("출력 파일명 접미사 (예: 'equipped', 'sword_shield', 'heavy_armor')"),
        model: z.string().optional()
          .describe("OpenAI 모델 override. 기본: gpt-image-2"),
        refine_prompt: z.boolean().default(false)
          .describe("GPT-5로 equipment_description을 확장 후 적용. 짧은 한국어 입력에 유용."),
        output_dir: z.string().optional().describe("출력 디렉토리"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const latency = startLatencyTracker();
      try {
        if (!fs.existsSync(params.base_character_path)) {
          throw new Error(`base_character_path 파일 없음: ${params.base_character_path}`);
        }
        for (const p of params.equipment_image_paths ?? []) {
          if (!fs.existsSync(p)) throw new Error(`equipment_image_paths 파일 없음: ${p}`);
        }

        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const safeCharName = params.character_name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const safeVariant = params.variant_name.replace(/[^a-zA-Z0-9_-]/g, "_");

        // GPT-5 리파인 (opt-in)
        const { text: equipmentDesc, refined: refinedByGPT5 } = await safeRefinePrompt({
          enabled: params.refine_prompt,
          text: params.equipment_description,
          targetModel: "gpt-image-2",
          assetType: "character",
          conceptHint: "Equipment combination — preserve base character exactly, only add/show equipped gear.",
          toolName: "character_equipped",
        });

        // 편집 프롬프트 구성
        // 마젠타 배경 + 캐릭터 보존 + 장비 자연스럽게 착용
        const editPrompt =
          `Redraw this exact character with the following equipment naturally equipped: ${equipmentDesc}. ` +
          `Preserve every detail from the base character reference — ` +
          `same face, same body shape and proportions, same skin/hair/eyes color, same outfit/armor ` +
          `(equipment is ADDED on top of existing design, NOT replacing the character's own appearance). ` +
          `Equipment should be visually consistent with the provided equipment reference images (if any). ` +
          `The character's stance is neutral front-facing, body relaxed, arms positioned naturally to hold/wear the equipment. ` +
          `ENTIRE full body visible — top of head to tips of feet, including all equipment extending outward. ` +
          `Character + equipment together must NOT exceed 70% of image height — leave ≥15% margin on all sides. ` +
          `Solid flat pure magenta (#FF00FF) background — uniform single color, no gradients, no shadows on the background. ` +
          `CRITICAL: neither character nor equipment may contain any magenta/pink/hot-pink pixels — ` +
          `use only natural character/gear colors (browns, greys, metal tones, leather, skin tones). ` +
          `${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

        const refPaths: string[] = [params.base_character_path, ...(params.equipment_image_paths ?? [])];
        const effectiveModel = (params.model ?? "gpt-image-2") as
          | "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini";

        // edit API 호출
        const editResult = await editImageOpenAI({
          imagePaths: refPaths,
          prompt: editPrompt,
          model: effectiveModel,
          size: "1024x1024",
        });

        // 마젠타 크로마키 제거 + residue 패스 → writeOptimized로 엔진 인식 포맷 저장
        const spriteDir = path.resolve(outputDir, `sprites/${safeCharName}`);
        ensureDir(spriteDir);
        const rawPath = path.join(spriteDir, `_tmp_equipped_raw_${Date.now()}.png`);
        const bgRemovedPath = path.join(spriteDir, `_tmp_equipped_noBg_${Date.now()}.png`);
        const finalPathBase = path.join(spriteDir, `${safeCharName}_${safeVariant}_base.png`);

        fs.writeFileSync(rawPath, Buffer.from(editResult.base64, "base64"));
        try {
          await removeBackground(rawPath, bgRemovedPath, {
            chromaKeyColor: [255, 0, 255],
            cropToContent: true,
          });
        } finally {
          try { if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath); } catch { /* ignore */ }
        }
        const bgRemovedBuffer = fs.readFileSync(bgRemovedPath);
        try { if (fs.existsSync(bgRemovedPath)) fs.unlinkSync(bgRemovedPath); } catch { /* ignore */ }
        const equippedWritten = await writeOptimized(bgRemovedBuffer, finalPathBase);
        const finalPath = equippedWritten.path;

        const asset: GeneratedAsset = {
          id: generateAssetId(), type: "image", asset_type: "character",
          provider: "openai", prompt: editPrompt, file_path: finalPath,
          file_name: path.basename(finalPath),
          mime_type: equippedWritten.format === "webp" ? "image/webp" : "image/png",
          created_at: new Date().toISOString(),
          metadata: {
            character_name: params.character_name,
            variant_name: params.variant_name,
            is_base_character: true,
            is_equipped_variant: true,
            base_character_path: path.resolve(params.base_character_path),
            equipment_image_paths: (params.equipment_image_paths ?? []).map((p) => path.resolve(p)),
            equipment_description: params.equipment_description,
            refined_by_gpt5: refinedByGPT5,
            ...(refinedByGPT5 ? { refined_equipment_description: equipmentDesc } : {}),
            ...buildEditCostTelemetry(effectiveModel, "1024x1024", latency.elapsed(), refPaths.length),
          },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              character_name: params.character_name,
              variant_name: params.variant_name,
              file_path: finalPath,
              asset_id: asset.id,
              model: effectiveModel,
              reference_images_used: refPaths.length,
              refined_by_gpt5: refinedByGPT5,
              note: "투명 PNG 저장됨. 이 파일을 asset_generate_sprite_sheet의 base_character_path 또는 pose_image로 전달하면 장비 착용 상태 스프라이트 시트가 생성됩니다.",
              next_step_example: `asset_generate_sprite_sheet(base_character_path="${finalPath}", character_name="${params.character_name}_${params.variant_name}")`,
            }, null, 2),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Equipped Base") }],
          isError: true,
        };
      }
    }
  );


  // ── 3. 스프라이트 시트 (여러 액션 일괄 생성 + 엔진별 내보내기) ───────────
  server.registerTool(
    "asset_generate_sprite_sheet",
    {
      title: "Generate Full Sprite Sheet (gpt-image-2 Edit, Sequential Anchor+Prev)",
      description: `Generate a complete sprite sheet by creating multiple action frame sprites
from a base character image using OpenAI gpt-image-2 image editing, then export in game engine formats.

**Target Layer**: GameScene **Layer 2 (유닛 애니메이션)** — 생성된 프레임들은 런타임에 depth 2로 렌더링.

**신규 시퀀스 패턴 (sequential_mode: "anchor_prev", 기본값)**:
  각 프레임이 두 reference 를 동시에 받습니다 —
  (a) anchor (= pose_image ?? base_character_path): 디자인 동결
  (b) 직전 프레임: 모션 연속성
  → 디자인이 흔들리지 않으면서 자연스러운 모션 곡선 형성. 5+ 프레임에서도 drift 누적 ~2% 이내.

  첫 프레임은 anchor 1개 reference 로만 시작 (시퀀스의 시작 포즈).
  두 번째 프레임부터는 [anchor, prev] 두 reference 로 자연스럽게 이어집니다.
  액션 단위는 병렬 처리되지만 액션 내부는 직전 프레임 의존성 때문에 직렬입니다.

**디폴트 프레임 수 결정 (우선순위 순)**:
  1) prompt_file 객체 맵의 액션별 frames
  2) 도구 명시 인자 frames_per_action
  3) prompt_file 글로벌 frames_per_action
  4) sequential_mode='anchor_prev' 일 때 액션별 매트릭스 (idle:5, walk:6, run:6, jump:5, attack:5, hurt:5, die:6)
     sequential_mode='off' 일 때 1 (옛 디폴트)
  sequential_mode='anchor_prev' 에서는 모든 결과를 max(value, 5) 로 강등 보호 (의미 있는 애니메이션 보장).

All action sprites are generated via gpt-image-2 edit to preserve the original
character's colors, proportions, and art style. gpt-image-2는 투명 배경을 지원하지 않으므로
내부적으로 단색 배경(마젠타 권장) 위에 편집 후 크로마키로 제거합니다.

**Performance note**: gpt-image-2는 편집 요청당 ~30-60초 소요.
신규 시퀀스 패턴 + 5프레임 디폴트 기준: 1캐릭터 7액션 ≈ 35콜, 액션 간 병렬·액션 내 직렬 처리로 5~10분 소요.
비용은 ~$1.5~2.0/캐릭터 수준 (구 1프레임 기본 대비 5×).
시퀀스가 부담스러우면 sequential_mode: "off" 로 옛 독립 패턴 사용 (병렬 가능, 일관성↓).

**Pose-First Pattern (권장)**:
  1. asset_generate_character_base → 베이스 캐릭터 생성
  2. (선택) asset_generate_character_pose → 포즈 승인 이미지 생성
  3. asset_generate_sprite_sheet (pose_image 파라미터) → 포즈 이미지 기준으로 시트 생성
  pose_image를 제공하면 편집 기준(=anchor)이 base_character_path 대신 pose_image로 교체됩니다.
  base_character_path는 메타데이터/매니페스트 참조용으로만 사용됩니다.

Args:
  - base_character_path (string): File path to the base character image (메타데이터 참조용)
  - pose_image (string, optional): Pose-First 패턴용. 포즈 승인 이미지 경로.
      제공 시 anchor 로 사용 (base_character_path 대체).
  - character_name (string): Character identifier for file naming and manifest
  - actions (string[], optional): Actions to generate. Default: all 7 presets.
  - frames_per_action (number, optional, max 8): 미명시 시 sequential_mode='anchor_prev' 에서는 액션별 매트릭스
      (idle:5, walk:6, run:6, jump:5, attack:5, hurt:5, die:6), 'off' 에서는 1.
      sequential_mode='anchor_prev' 에서는 글로벌 최소 5 강제.
  - custom_action_prompts (object, optional): Override edit prompts per action.
  - generation_mode (string, optional, default "sequential"):
      "sequential" — anchor+prev 패턴 프레임별 생성 (세밀 제어, 기존 방식).
      "grid" — 액션당 1회 API 호출로 2×2/3×3 그리드 생성 후 슬라이스.
              모든 프레임이 한 컨텍스트에서 생성 → 크기·지면선 일관성이 sequential보다 높음.
              머리 잘림, 크기 변화, 지면선 불일치 문제 방지에 권장.
  - grid_size (2|3, optional, default 2): grid 모드에서 그리드 크기.
      2 = 2×2 = 4프레임, 3 = 3×3 = 9프레임.
  - sequential_mode (string, optional): sequential 모드 전용. "anchor_prev" (기본) — 직전 프레임을 reference 로 함께 투입.
      "off" — 옛 독립 패턴 (각 프레임이 anchor 만 reference, 액션 내 병렬 가능).
  - first_frame_quality_check (boolean, optional, default true): 첫 프레임만 자동 Claude Vision 검증
      + 미달 시 OpenAI fallback. 시퀀스의 토대를 보호합니다.
  - quality_check (boolean, optional, default false): 모든 프레임에 대한 검증.
      first_frame_quality_check 와 독립적.
  - auto_compose_sheet (boolean, optional, default true): 개별 PNG에 더해 합성 시트 자동 생성.
  - export_formats (string[], optional): Engine-specific export formats.
      "individual" / "phaser" / "cocos" / "unity". Default: ["individual", "phaser"].
  - sheet_padding (number, optional): Pixel gap between frames (default: 0)
  - sheet_cols (number, optional): 미지정 시 ceil(sqrt(N)) 정사각 그리드 (모바일 GPU 안전).
      composer는 4096px 한도 초과 시 자동으로 그리드로 재배치하므로 1행 스트립을
      강제하려면 sheet_cols=N을 넣더라도 한도 초과 시 자동 재배치됨.
  - frame_padding (number, optional): Padding around each frame (default: 20)
  - chroma_key_bg (string, optional): gpt-image-2 기본 경로는 'magenta' 자동 적용 (asset_generate_character_base와 동일). gpt-image-1 계열은 미지정 시 네이티브 투명.
  - output_dir (string, optional)

Returns:
  Individual frame files + composed sprite sheet + engine-specific metadata files.
  Output: {output_dir}/sprites/{character_name}/`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("Path to base character image file (메타데이터/매니페스트 참조용. pose_image 제공 시 편집에 사용되지 않음)"),
        pose_image: z.string().optional().describe(
          "Pose-First 패턴: 포즈 승인 이미지 경로. 제공 시 편집 기준 이미지로 사용 (base_character_path 대체). " +
          "asset_generate_character_pose 결과물을 여기에 넣으세요."
        ),
        character_name: z.string().min(1).max(100).describe("Character identifier"),
        prompt_file: z.string().optional().describe(
          "Path to sprite prompt JSON file. If provided, loads actions / custom_action_prompts / frames_per_action / edit_model from it. Explicit params take precedence."
        ),
        actions: z.array(z.string()).min(1).max(20)
          .default(["idle", "walk", "run", "jump", "attack", "hurt", "die"])
          .describe("Actions to generate (overrides prompt_file if set)"),
        frames_per_action: z.number().int().min(1).max(8).optional()
          .describe("Frames per action. 미명시 시 sequential_mode='anchor_prev' 에서는 액션별 매트릭스 (idle:5, walk:6, run:6, jump:5, attack:5, hurt:5, die:6), 'off' 에서는 1. prompt_file 객체 맵의 액션별 frames 가 더 우선."),
        generation_mode: z.enum(["sequential", "grid"]).default("sequential")
          .describe(
            "'sequential' (기본): anchor+prev 패턴으로 프레임별 순차 생성 — 세밀한 제어, 액션당 N회 API 호출. " +
            "'grid': 액션당 1회 API 호출로 N×N 그리드 이미지를 생성 후 슬라이스 — " +
            "grid_size=2이면 2×2=4프레임/액션, grid_size=3이면 3×3=9프레임/액션. " +
            "한 액션의 모든 프레임이 동일 컨텍스트에서 생성되어 크기·지면선 일관성 최고. " +
            "베이스 이미지 1장으로 모든 액션을 병렬 생성, API 비용·시간 대폭 절감."
          ),
        grid_size: z.union([z.literal(2), z.literal(3)]).default(2)
          .describe("grid 모드에서 그리드 크기. 2 = 2×2 = 4프레임/액션, 3 = 3×3 = 9프레임/액션."),
        sequential_mode: z.enum(["anchor_prev", "off"]).default("anchor_prev")
          .describe("sequential 모드에서만 유효. 'anchor_prev' (기본): 직전 프레임을 reference 로 함께 투입해 모션 연속성 확보. 'off': 옛 독립 패턴."),
        first_frame_quality_check: z.boolean().default(true)
          .describe("첫 프레임만 자동 Claude Vision 검증 + 미달 시 OpenAI fallback. 시퀀스의 토대를 보호합니다."),
        auto_compose_sheet: z.boolean().default(true)
          .describe("true 면 개별 PNG에 더해 합성 시트 (_sheet.{webp|png}) 를 자동 생성. export_formats 의 atlas/plist/unity 는 별도 옵션."),
        custom_action_prompts: z.record(z.string()).optional()
          .describe("Override edit prompts per action: { action_name: edit_prompt } (merges with prompt_file). sequential_mode 에서는 첫 프레임이든 직전+anchor 컨텍스트든 동일하게 적용됩니다."),
        edit_model: z.string().optional()
          .describe("OpenAI model for image editing (default: gpt-image-2). gpt-image-1 계열도 사용 가능하나 gpt-image-2가 품질 최고."),
        export_formats: z.array(z.enum(["individual", "phaser", "cocos", "unity", "godot"]))
          .default(["individual", "phaser"])
          .describe("Engine export formats: phaser / cocos / unity / godot. 기본은 individual + phaser atlas json. Unity 사용자는 'unity', Godot 4 사용자는 'godot' 추가 (.tres SpriteFrames 생성)."),
        sheet_padding: z.number().int().min(0).max(64).default(0)
          .describe("Pixel padding between frames in the composed sheet"),
        sheet_cols: z.number().int().min(1).optional()
          .describe("스프라이트 시트 열 수. 미지정 시 ceil(sqrt(N)) 정사각 그리드(모바일 GPU 한도 4096px 안전). composer가 한도 초과 시 자동 그리드 재배치하므로 큰 값 넣어도 안전."),
        frame_padding: z.number().int().min(0).max(300).default(20)
          .describe("Padding pixels added around each individual sprite frame (prevents edge cropping). Default: 20"),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("중간 배경색 override. gpt-image-2 기본 경로는 'magenta' 자동 적용(asset_generate_character_base와 동일). " +
            "외곽선으로 닫힌 포켓(겨드랑이 등) 잔류를 residue 패스로 제거. " +
            "흰색 flood-fill은 흰 캐릭터(토끼·흰 의상 등)에서 배경/캐릭터 구분 불가. " +
            "gpt-image-1 계열은 네이티브 투명을 지원하므로 미지정 시 chroma_key 미사용."),
        bg_threshold: z.number().int().min(0).max(255).default(240)
          .describe("White background removal threshold (0-255). Used only when chroma_key_bg is not set."),
        quality_check: z.boolean().default(false)
          .describe("각 프레임을 Claude 비전으로 품질 검증. 미달 시 OpenAI gpt-image-1로 자동 재생성. 기본: false"),
        character_hint: z.string().max(500).optional()
          .describe("품질 검증에 사용할 캐릭터 설명 (예: 'green alien soldier in black armor with baton')"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const safeCharName = params.character_name.replace(/[^a-zA-Z0-9_-]/g, "_");
      const spriteDir = path.resolve(outputDir, `sprites/${safeCharName}`);
      ensureDir(spriteDir);

      // ── prompt_file에서 스프라이트 설정 로드 ─────────────────────────────────
      // actions 형식 두 가지 지원:
      //   배열 형식 (구): ["idle", "walk", "die"]
      //   객체 맵 형식 (신): { "idle": { "frames": 1, "prompt": "..." }, "walk": { "frames": 3, "prompt": "..." } }
      interface ActionConfig {
        frames?: number;
        prompt?: string;
      }
      interface SpritePromptFile {
        sprite?: {
          actions?: string[] | Record<string, ActionConfig>;
          frames_per_action?: number;  // 배열 형식일 때 전체 기본값
          custom_action_prompts?: Record<string, string>;
          export_formats?: Array<"individual" | "phaser" | "cocos" | "unity" | "godot">;
          settings?: { edit_model?: string };
        };
        settings?: { edit_model?: string };
      }
      let fileConfig: SpritePromptFile = {};
      if (params.prompt_file) {
        try {
          const raw = fs.readFileSync(path.resolve(params.prompt_file), "utf-8");
          fileConfig = JSON.parse(raw) as SpritePromptFile;
        } catch (e) {
          return {
            content: [{ type: "text" as const, text: `Error reading prompt_file: ${String(e)}` }],
            isError: true,
          };
        }
      }
      const spriteConfig = fileConfig.sprite ?? {};

      // actions 파싱 — 배열 vs 객체 맵 구분
      let fileActions: string[] | undefined;
      const perActionFrames: Record<string, number> = {};   // 액션별 프레임 수
      const fileActionPrompts: Record<string, string> = {}; // 객체 맵에서 추출한 프롬프트

      if (Array.isArray(spriteConfig.actions)) {
        fileActions = spriteConfig.actions;
      } else if (spriteConfig.actions && typeof spriteConfig.actions === "object") {
        fileActions = Object.keys(spriteConfig.actions);
        for (const [action, cfg] of Object.entries(spriteConfig.actions as Record<string, ActionConfig>)) {
          if (cfg.frames != null) perActionFrames[action] = cfg.frames;
          if (cfg.prompt)         fileActionPrompts[action] = cfg.prompt;
        }
      }

      // 명시적 파라미터 우선, 그 다음 prompt_file 값
      const defaultActions = ["idle","walk","run","jump","attack","hurt","die"];
      const effectiveActions: string[] =
        (params.actions && params.actions.join() !== defaultActions.join())
          ? params.actions
          : (fileActions ?? params.actions);

      // 액션별 프레임 수 결정 — 명시적 우선순위
      // 1) prompt_file 객체 맵의 액션별 frames
      // 2) 도구 명시 인자 (params.frames_per_action — 사용자가 의도적으로 줬을 때만)
      // 3) prompt_file 글로벌 (spriteConfig.frames_per_action)
      // 4) sequential_mode 매트릭스 (idle:5, walk:6, ...) 또는 옛 디폴트 1
      // sequential_mode='anchor_prev' 에서는 모든 결과를 max(value, SEQUENTIAL_MIN_FRAMES) 로 강등 보호.
      const resolveActionFrameCount = (action: string, sequential: boolean): number => {
        const apply = (v: number) => sequential ? Math.max(v, SEQUENTIAL_MIN_FRAMES) : v;
        if (perActionFrames[action] != null) return apply(perActionFrames[action]);
        if (params.frames_per_action != null) return apply(params.frames_per_action);
        if (spriteConfig.frames_per_action != null) return apply(spriteConfig.frames_per_action);
        if (sequential) return ACTION_FRAME_DEFAULTS[action] ?? SEQUENTIAL_MIN_FRAMES;
        return 1;
      };

      // 커스텀 프롬프트: 객체 맵 프롬프트 < custom_action_prompts < 파라미터
      const effectiveCustomPrompts: Record<string, string> = {
        ...fileActionPrompts,
        ...(spriteConfig.custom_action_prompts ?? {}),
        ...(params.custom_action_prompts ?? {}),
      };
      const effectiveEditModel: string =
        params.edit_model ??
        spriteConfig.settings?.edit_model ??
        fileConfig.settings?.edit_model ??
        "gpt-image-2";

      // 원본 이미지 읽기 (메타데이터용)
      let origBase64: string;
      try {
        const img = readImageAsBase64(params.base_character_path);
        origBase64 = img.base64;
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "File Read") }],
          isError: true,
        };
      }

      // 크로마키 배경 결정.
      // asset_generate_character_base와 동일하게: gpt-image-2는 투명 배경 미지원이므로
      // chroma_key_bg 미지정 시 magenta를 자동 적용한다. gpt-image-1 계열은 네이티브
      // 투명을 지원하므로 chroma_key_bg 미지정 시 흰 배경 경로를 유지한다.
      const supportsNativeTransparentEdit = effectiveEditModel.startsWith("gpt-image-1");
      const effectiveChromaKey: keyof typeof CHROMA_KEY_COLORS | undefined =
        params.chroma_key_bg ?? (supportsNativeTransparentEdit ? undefined : "magenta");
      const sheetChromaKeyColor = effectiveChromaKey
        ? CHROMA_KEY_COLORS[effectiveChromaKey] as [number, number, number]
        : undefined;

      // Pose-First 패턴: pose_image가 있으면 그걸 편집 기준으로 사용
      // pose_image 없으면 base_character_path 사용 (기존 동작)
      const editSourcePath = params.pose_image ?? params.base_character_path;
      const poseFirstMode = !!params.pose_image;

      // 편집 API 호출 전: 투명 PNG를 단색 배경 위에 합성
      const sheetBgColor = sheetChromaKeyColor ?? WHITE_BG_COLOR;
      let compositedBase64 = origBase64;
      try {
        const compositedBuffer = await compositeOntoSolidBg(editSourcePath, sheetBgColor);
        compositedBase64 = compositedBuffer.toString("base64");
      } catch (_) {
        // 합성 실패 시 원본 그대로 사용 (base_character_path 폴백)
        if (poseFirstMode) {
          try {
            const fallbackBuffer = await compositeOntoSolidBg(params.base_character_path, sheetBgColor);
            compositedBase64 = fallbackBuffer.toString("base64");
          } catch (_2) {
            // base64 원본 그대로
          }
        }
      }

      const manifest: SpriteSheetManifest = {
        character_name: params.character_name,
        base_character_path: path.resolve(params.base_character_path),
        frames: [],
        animations: {},
        created_at: new Date().toISOString(),
        provider: `openai/${effectiveEditModel}`,
        ...(poseFirstMode ? { pose_image_path: path.resolve(editSourcePath) } : {}),
      } as SpriteSheetManifest & { pose_image_path?: string };

      // gpt-image-2 edits 엔드포인트는 imagePath 입력을 요구하므로,
      // composited base64를 임시 PNG 파일로 한 번 쓰고 전체 루프 끝에 정리.
      const tmpEditPath = path.join(
        process.env["TMPDIR"] || "/tmp",
        `sprite_edit_${safeCharName}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`,
      );
      fs.writeFileSync(tmpEditPath, Buffer.from(compositedBase64, "base64"));

      type FrameResult = {
        action: string;
        frame_index: number;
        success: boolean;
        file_path?: string;
        error?: string;
        quality?: {
          passed: boolean;
          issues: string[];
          fallback_used: boolean;
          provider: string;
        };
      };

      const sequentialMode: "anchor_prev" | "off" = params.sequential_mode ?? "anchor_prev";
      const tmpDirForPrev = process.env["TMPDIR"] || "/tmp";

      // 각 프레임의 결과를 모아서 액션별로 정렬되도록 키로 보관 (병렬 처리용)
      type ActionOutput = {
        action: string;
        frames: SpriteFrame[];
        frameNames: string[]; // animation 매핑용
        results: FrameResult[];
        actionSheetPath?: string; // grid 모드: 액션별 투명 배경 시트
        gridFramePaths?: string[]; // grid 모드: 시트 합성 후 삭제할 개별 프레임 경로
      };

      // 단일 프레임 처리 — 호출처에서 anchor/prev 결정 후 호출
      const processOneFrame = async (args: {
        action: string;
        frameIdx: number;
        actionFrameCount: number;
        imagePaths: string[];           // [anchor] 또는 [anchor, prev]
        isFirstFrame: boolean;
      }): Promise<{ result: FrameResult; frame?: SpriteFrame; processedBuffer?: Buffer; promptUsed?: string }> => {
        const { action, frameIdx, actionFrameCount, imagePaths, isFirstFrame } = args;
        const isPreset = DEFAULT_ACTIONS.includes(action as DefaultAction);
        const poseDesc = isPreset ? ACTION_PROMPTS[action as DefaultAction] : action;

        // 배경 프롬프트: 크로마키 모드에서는 해당 색상 지시어, 기본은 흰 배경
        const effectiveBgRules = sheetChromaKeyColor
          ? buildChromaBgPrompt(sheetChromaKeyColor)
          : undefined;

        // 프롬프트 결정 — 사용자 custom > sequential builder > 옛 builder
        let prompt: string;
        if (effectiveCustomPrompts?.[action]) {
          prompt = effectiveCustomPrompts[action];
        } else if (sequentialMode === "anchor_prev") {
          prompt = buildSequentialFramePrompt({
            action,
            frameIdx,
            totalFrames: actionFrameCount,
            isFirst: isFirstFrame,
            characterHint: params.character_hint,
            bgRulesOverride: effectiveBgRules,
          });
        } else {
          // off 모드 — 옛 동작 호환
          let frameNote = "";
          if (actionFrameCount > 1) {
            const progress = frameIdx / (actionFrameCount - 1);
            frameNote = ` Frame ${frameIdx + 1}/${actionFrameCount} — pose at ${Math.round(progress * 100)}% through the motion.`;
          }
          prompt = buildActionEditPrompt(poseDesc + frameNote, params.character_hint, effectiveBgRules);
        }

        try {
          const result = await editImageOpenAI({
            imagePaths,
            prompt,
            model: effectiveEditModel as
              | "gpt-image-2"
              | "gpt-image-1.5"
              | "gpt-image-1"
              | "gpt-image-1-mini",
            size: "1024x1024",
          });

          // 배경 제거 (크로마키 또는 순백 flood-fill)
          let processedBuffer: Buffer;
          if (sheetChromaKeyColor) {
            processedBuffer = await processFrameBase64Chroma(result.base64, sheetChromaKeyColor);
          } else {
            processedBuffer = await processFrameBase64(result.base64, WHITE_BG_THRESHOLD);
          }
          if (params.frame_padding > 0) {
            processedBuffer = await addPaddingToBuffer(processedBuffer, params.frame_padding);
          }

          // ── 품질 검증 + OpenAI fallback ─────────────────────────────────────
          // 첫 프레임은 first_frame_quality_check 자동 적용 (시퀀스 토대 보호)
          // 그 외는 quality_check 옵션을 따름
          const shouldCheck =
            (isFirstFrame && (params.first_frame_quality_check ?? true)) ||
            params.quality_check;

          let frameQualityIssues: string[] = [];
          let frameFallbackUsed = false;
          if (shouldCheck) {
            // 첫 프레임에서는 포즈 구별성(POSE_DISTINCT)도 함께 검사
            const qc = await checkSpriteFrameQuality(
              processedBuffer.toString("base64"),
              params.character_hint,
              isFirstFrame ? action : undefined,
            );
            if (!qc.passed) {
              frameQualityIssues = qc.issues;
              console.warn(`[quality-check] ${params.character_name} ${action} f${frameIdx} 품질 미달 (${qc.issues.join(", ")}) → OpenAI fallback`);
              try {
                // fallback 배경 지시: 크로마키면 해당 색, 아니면 흰 배경
                const fallbackBgPrompt = sheetChromaKeyColor
                  ? buildChromaBgPrompt(sheetChromaKeyColor)
                  : "pure white (#FFFFFF) background, no gradients, no shadows";
                // 첫 프레임 fallback: ACTION_FRAME0_PROMPTS의 강한 포즈 묘사 사용.
                // "Draw a game sprite" 패턴으로 디자인 제약을 느슨하게 풀어 모델이
                // 포즈를 우선할 수 있도록 함 (디자인은 frames 1+의 anchor가 보정함).
                const fallbackPoseDesc = (isFirstFrame && DEFAULT_ACTIONS.includes(action as DefaultAction))
                  ? ACTION_FRAME0_PROMPTS[action as DefaultAction]
                  : poseDesc;
                const fallbackPrompt = effectiveCustomPrompts?.[action]
                  ?? [
                    `Draw a game sprite character in the following pose: ${fallbackPoseDesc}`,
                    `The character must look NOTHING like a person standing still — the body posture must unmistakably show the "${action}" action.`,
                    params.character_hint ? `Character: ${params.character_hint}.` : "",
                    `${fallbackBgPrompt}. Full body visible with no clipping. Single character only.`,
                  ].filter(Boolean).join(" ");
                const fallbackResult = await editImageOpenAI({
                  // tmpEditPath: composited anchor — pose_image 포함, edit API에 투명 PNG 직접 전달 방지
                  imagePath: tmpEditPath,
                  prompt: fallbackPrompt,
                  size: "1024x1024",
                });
                if (sheetChromaKeyColor) {
                  processedBuffer = await processFrameBase64Chroma(
                    fallbackResult.base64, sheetChromaKeyColor, 80, params.frame_padding,
                  );
                } else {
                  processedBuffer = await processFrameBase64AI(fallbackResult.base64, params.frame_padding);
                }
                frameFallbackUsed = true;
              } catch (fallbackErr) {
                console.warn(`[quality-check] OpenAI fallback 실패:`, fallbackErr);
              }
            }
          }

          const safeAction = action.replace(/[^a-zA-Z0-9_-]/g, "_");
          const pathBase = path.join(
            spriteDir,
            `${safeCharName}_${safeAction}_f${String(frameIdx).padStart(2, "0")}.png`,
          );
          const written = await writeOptimized(processedBuffer, pathBase);
          const filePath = written.path;
          const fileName = path.basename(filePath);

          const frame: SpriteFrame = {
            name: `${action}_f${String(frameIdx).padStart(2, "0")}`,
            file_path: filePath,
            file_name: fileName,
            action,
            frame_index: frameIdx,
          };

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "sprite",
            provider: `openai/${effectiveEditModel}`,
            prompt,
            file_path: filePath,
            file_name: fileName,
            mime_type: written.format === "webp" ? "image/webp" : "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              character_name: params.character_name,
              action,
              frame_index: frameIdx,
              base_character_path: params.base_character_path,
              edit_model: effectiveEditModel,
              sequential_mode: sequentialMode,
              reference_count: imagePaths.length,
              ...(sequentialMode === "anchor_prev" && !isFirstFrame
                ? { uses_prev_frame_reference: true }
                : {}),
            },
          };
          saveAssetToRegistry(asset, outputDir);

          const result_: FrameResult = {
            action,
            frame_index: frameIdx,
            success: true,
            file_path: filePath,
            ...(shouldCheck ? {
              quality: {
                passed: frameQualityIssues.length === 0,
                issues: frameQualityIssues,
                fallback_used: frameFallbackUsed,
                provider: frameFallbackUsed ? "openai-fallback" : `openai/${effectiveEditModel}`,
              },
            } : {}),
          };
          return { result: result_, frame, processedBuffer, promptUsed: prompt };
        } catch (error) {
          return {
            result: {
              action,
              frame_index: frameIdx,
              success: false,
              error: handleApiError(error, "OpenAI Edit (gpt-image-2)"),
            },
          };
        }
      };

      // 액션 단위 처리 — 액션 내부는 직렬 (직전 프레임 의존), 액션 간은 병렬
      const runActionTask = async (action: string): Promise<ActionOutput> => {
        const count = resolveActionFrameCount(action, sequentialMode === "anchor_prev");

        const localFrames: SpriteFrame[] = [];
        const localFrameNames: string[] = [];
        const localResults: FrameResult[] = [];
        let prevTmpPath: string | undefined;

        for (let frameIdx = 0; frameIdx < count; frameIdx++) {
          const isFirst = frameIdx === 0;
          // prevTmpPath 없이 isFirst=false 프롬프트를 보내면 "SECOND reference image" 언급이
          // 실제로 전달되지 않은 이미지를 가리켜 모델이 혼동함 — 실제 입력과 프롬프트를 일치시킴
          const hasPrevRef = sequentialMode === "anchor_prev" && !isFirst && !!prevTmpPath;
          const imagePaths = hasPrevRef ? [tmpEditPath, prevTmpPath!] : [tmpEditPath];

          const out = await processOneFrame({
            action,
            frameIdx,
            actionFrameCount: count,
            imagePaths,
            isFirstFrame: !hasPrevRef,  // prev 없으면 first-frame 프롬프트 사용
          });

          localResults.push(out.result);
          if (out.frame) {
            localFrames.push(out.frame);
            localFrameNames.push(out.frame.name);
          }

          // 다음 프레임을 위해 prev 임시 파일 갱신 (sequential 모드만)
          if (
            sequentialMode === "anchor_prev" &&
            out.processedBuffer &&
            frameIdx < count - 1
          ) {
            const newPrevTmp = path.join(
              tmpDirForPrev,
              `prev_${safeCharName}_${action.replace(/[^a-zA-Z0-9_-]/g, "_")}_${frameIdx}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`,
            );
            try {
              const bgColor = sheetChromaKeyColor ?? WHITE_BG_COLOR;
              await writeBufferOnSolidBgToTmp(out.processedBuffer, bgColor, newPrevTmp);
              // 이전 prev 파일 정리
              if (prevTmpPath && fs.existsSync(prevTmpPath)) {
                try { fs.unlinkSync(prevTmpPath); } catch { /* ignore */ }
              }
              prevTmpPath = newPrevTmp;
            } catch (composeErr) {
              console.warn(`[sequential] ${action} f${frameIdx} prev composition 실패 — 다음 프레임은 anchor 만 사용:`, composeErr);
              prevTmpPath = undefined;
            }
          } else if (sequentialMode === "anchor_prev" && !out.processedBuffer && !isFirst) {
            // 직전 프레임 생성 실패 — 다음 프레임은 anchor 만 사용 (drift 방지)
            prevTmpPath = undefined;
          }
        }

        // 마지막 prev 임시 파일 정리
        if (prevTmpPath && fs.existsSync(prevTmpPath)) {
          try { fs.unlinkSync(prevTmpPath); } catch { /* ignore */ }
        }

        return { action, frames: localFrames, frameNames: localFrameNames, results: localResults };
      };

      // ── Grid 모드: 액션당 1회 API 호출로 N×N 그리드 생성 후 슬라이스 ──────────
      // grid_size=2 → 2×2 = 4프레임/액션, grid_size=3 → 3×3 = 9프레임/액션.
      // 한 액션의 모든 프레임이 동일 컨텍스트에서 생성 → 크기·지면선 일관성 최고.
      // 액션 간 병렬, 셀(프레임) 처리는 순차.
      const runPerActionGridTask = async (): Promise<ActionOutput[]> => {
        const gridSize = (params.grid_size ?? 2) as 2 | 3;
        const totalCells = gridSize * gridSize;

        const effectiveBgRules = sheetChromaKeyColor
          ? buildChromaBgPrompt(sheetChromaKeyColor)
          : undefined;

        // 각 액션을 병렬 처리
        return await Promise.all(effectiveActions.map(async (action): Promise<ActionOutput> => {
          const safeAction = action.replace(/[^a-zA-Z0-9_-]/g, "_");

          const gridPrompt = buildGridGenerationPrompt(
            action,
            gridSize,
            params.character_hint,
            effectiveBgRules,
          );

          // ── 1회 API 호출로 gridSize×gridSize 그리드 생성 ──────────────────
          let gridBase64: string;
          try {
            const gridResult = await editImageOpenAI({
              imagePaths: [tmpEditPath],
              prompt: gridPrompt,
              model: effectiveEditModel as
                | "gpt-image-2"
                | "gpt-image-1.5"
                | "gpt-image-1"
                | "gpt-image-1-mini",
              size: "1024x1024",
            });
            gridBase64 = gridResult.base64;
          } catch (error) {
            return {
              action,
              frames: [],
              frameNames: [],
              results: [{ action, frame_index: 0, success: false, error: handleApiError(error, `Grid Generation: ${action}`) }],
            };
          }

          // Raw 그리드 저장 (디버그용)
          try {
            const rawPath = path.join(spriteDir, `${safeCharName}_${safeAction}_grid_raw.png`);
            fs.writeFileSync(rawPath, Buffer.from(gridBase64, "base64"));
          } catch { /* ignore */ }

          // ── 그리드 슬라이스 ──────────────────────────────────────────────
          const gridBuffer = Buffer.from(gridBase64, "base64");
          let cellBuffers: Buffer[];
          try {
            cellBuffers = await sliceGridIntoFrames(gridBuffer, gridSize, gridSize);
          } catch (sliceErr) {
            return {
              action,
              frames: [],
              frameNames: [],
              results: [{ action, frame_index: 0, success: false, error: `슬라이스 실패: ${String(sliceErr)}` }],
            };
          }

          // ── 각 셀 배경 제거 + 저장 (시트 합성용 임시 파일, 합성 후 삭제) ─────
          const frames: SpriteFrame[] = [];
          const frameNames: string[] = [];
          const results: FrameResult[] = [];
          const gridFramePaths: string[] = [];

          for (let i = 0; i < Math.min(cellBuffers.length, totalCells); i++) {
            const frameIdx = i;
            const framePad = String(frameIdx).padStart(2, "0");

            try {
              let buf: Buffer;
              if (sheetChromaKeyColor) {
                buf = await processFrameBase64Chroma(
                  cellBuffers[i].toString("base64"),
                  sheetChromaKeyColor,
                  80,
                  0,
                );
              } else {
                buf = await processFrameBase64(
                  cellBuffers[i].toString("base64"),
                  WHITE_BG_THRESHOLD,
                );
              }
              if (params.frame_padding > 0) {
                buf = await addPaddingToBuffer(buf, params.frame_padding);
              }

              const pathBase = path.join(spriteDir, `${safeCharName}_${safeAction}_f${framePad}.png`);
              const written = await writeOptimized(buf, pathBase);
              const frameName = `${action}_f${framePad}`;

              const frame: SpriteFrame = {
                name: frameName,
                file_path: written.path,
                file_name: path.basename(written.path),
                action,
                frame_index: frameIdx,
              };

              // grid 모드: 개별 프레임은 시트 합성용 임시 파일이므로 레지스트리에 등록하지 않음.
              // 합성 완료 후 gridFramePaths를 통해 삭제된다.

              frames.push(frame);
              frameNames.push(frameName);
              gridFramePaths.push(written.path);
              results.push({ action, frame_index: frameIdx, success: true, file_path: written.path });
            } catch (frameErr) {
              results.push({ action, frame_index: frameIdx, success: false, error: String(frameErr) });
            }
          }

          return { action, frames, frameNames, results, gridFramePaths };
        }));
      };

      // 액션 간 병렬 실행 (각 액션의 시퀀스는 내부적으로 직렬)
      const generationMode = params.generation_mode ?? "sequential";
      const actionOutputs = generationMode === "grid"
        ? await runPerActionGridTask()
        : await Promise.all(effectiveActions.map(runActionTask));

      // 결과를 manifest 와 results 에 합치기 (액션 입력 순서 유지)
      const results: FrameResult[] = [];
      const actionSheets: Record<string, string> = {};
      for (const ao of actionOutputs) {
        manifest.animations[ao.action] = ao.frameNames;
        manifest.frames.push(...ao.frames);
        results.push(...ao.results);
        if (ao.actionSheetPath) actionSheets[ao.action] = ao.actionSheetPath;
      }

      // 임시 편집 입력 파일 (anchor) 정리
      try {
        if (fs.existsSync(tmpEditPath)) fs.unlinkSync(tmpEditPath);
      } catch (_cleanupErr) {
        // 정리 실패는 결과에 영향 없음
      }

      // 매니페스트 저장
      const manifestPath = path.join(spriteDir, `${safeCharName}_manifest.json`);
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const succeeded = results.filter((r) => r.success).length;

      // ── 엔진별 스프라이트 시트 합성 & 내보내기 ────────────────────────────
      const exportedFiles: Record<string, string> = {};
      const exportErrors: Record<string, string> = {};
      const autoCompose = params.auto_compose_sheet ?? true;
      const needsCompose = autoCompose || params.export_formats.some((f) => f !== "individual");

      if (needsCompose && succeeded > 0) {
        // 성공한 프레임만 수집
        const frameInfos: FrameInfo[] = manifest.frames
          .filter((f) => fs.existsSync(f.file_path))
          .map((f) => ({
            name: f.name,
            filePath: f.file_path,
            action: f.action,
            frameIndex: f.frame_index,
          }));

        if (frameInfos.length > 0) {
          try {
            const sheetPathBase = path.join(spriteDir, `${safeCharName}_sheet.png`);
            // 기본: 정사각형에 가까운 sqrt 그리드 (모바일 GPU 텍스처 한도 안전).
            // sheet_cols 명시 시 그 값을 우선하되, composer가 한도 초과 시
            // 자동으로 그리드로 재배치한다.
            const effectiveCols = params.sheet_cols ?? Math.ceil(Math.sqrt(frameInfos.length));
            // Engine-aware format for the sheet itself (WebP on Phaser/Cocos/Godot,
            // PNG on Unity/unknown). Atlas JSON / plist will pick up the real
            // extension from the returned `sheet.sheetPath`.
            const sheet = await composeSpritSheet(
              frameInfos,
              sheetPathBase,
              params.sheet_padding,
              effectiveCols,
            );
            exportedFiles["sheet"] = sheet.sheetPath;

            if (params.export_formats.includes("phaser")) {
              const phaserPath = path.join(spriteDir, `${safeCharName}_phaser.json`);
              exportPhaserAtlas(sheet, phaserPath);
              exportedFiles["phaser_atlas_json"] = phaserPath;
            }

            if (params.export_formats.includes("cocos")) {
              const cocosPath = path.join(spriteDir, `${safeCharName}_cocos.plist`);
              exportCocosPlist(sheet, cocosPath);
              exportedFiles["cocos_plist"] = cocosPath;
            }

            if (params.export_formats.includes("unity")) {
              const unityPath = path.join(spriteDir, `${safeCharName}_unity.json`);
              exportUnityJson(sheet, params.character_name, unityPath);
              exportedFiles["unity_json"] = unityPath;
            }

            if (params.export_formats.includes("godot")) {
              const godotPath = path.join(spriteDir, `${safeCharName}_sprite_frames.tres`);
              exportGodotTres(sheet, params.character_name, godotPath);
              exportedFiles["godot_tres"] = godotPath;
            }

          } catch (err) {
            exportErrors["compose"] = handleApiError(err, "SpriteSheet Compose");
          }
        }
      }

      // grid 모드: 합성 성공/실패·needsCompose 여부와 무관하게 개별 프레임 파일 항상 삭제.
      // 이전에는 try 블록 안에만 있어 합성 실패 시 또는 needsCompose=false 시 파일이 누수됐음.
      if (generationMode === "grid") {
        const gridFramePathsToClean = actionOutputs.flatMap(ao => ao.gridFramePaths ?? []);
        for (const fp of gridFramePathsToClean) {
          try { fs.unlinkSync(fp); } catch { /* 이미 없거나 삭제 불가 — 무시 */ }
        }
        // manifest의 frame file_path를 빈 문자열로 갱신 — 삭제된 경로를 다른 도구가 참조하지 않도록.
        manifest.frames.forEach(f => { f.file_path = ""; f.file_name = ""; });
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
      }

      const output = {
        success: succeeded > 0,
        character_name: params.character_name,
        sprite_dir: spriteDir,
        manifest_path: manifestPath,
        generation_mode: generationMode,
        ...(generationMode === "grid"
          ? {
              grid_size: params.grid_size ?? 2,
              frames_per_action: (params.grid_size ?? 2) ** 2,
            }
          : {
              pose_first_mode: poseFirstMode,
              sequential_mode: sequentialMode,
              first_frame_quality_check: params.first_frame_quality_check ?? true,
            }),
        auto_compose_sheet: autoCompose,
        ...(poseFirstMode ? { pose_image_used: path.resolve(editSourcePath) } : {}),
        total_frames: results.length,
        succeeded,
        failed: results.length - succeeded,
        exported_files: exportedFiles,
        export_errors: Object.keys(exportErrors).length > 0 ? exportErrors : undefined,
        // grid 모드: 개별 파일이 삭제됐으므로 file_path 필드를 제거해 클라이언트 혼선 방지
        results: generationMode === "grid"
          ? results.map(({ file_path: _fp, ...rest }) => rest)
          : results,
        animations: Object.fromEntries(
          Object.entries(manifest.animations).map(([k, v]) => [k, v.length])
        ),
        engine_usage: {
          phaser: exportedFiles["phaser_atlas_json"]
            ? `Phaser.Loader.atlas('${params.character_name}', '${path.basename(exportedFiles["sheet"] ?? "")}', '${safeCharName}_phaser.json')`
            : undefined,
          cocos: exportedFiles["cocos_plist"]
            ? `spriteFrameCache.addSpriteFramesWithFile('${safeCharName}_cocos.plist')`
            : undefined,
          unity: exportedFiles["unity_json"]
            ? `Import ${path.basename(exportedFiles["sheet"] ?? "")} → Sprite Mode: Multiple → Slice by cell size (see unity_json for dimensions)`
            : undefined,
          godot: exportedFiles["godot_tres"]
            ? `AnimatedSprite2D → Frames → Load: ${safeCharName}_sprite_frames.tres (res:// 경로를 프로젝트에 맞게 수정)`
            : undefined,
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
        ...(succeeded === 0 ? { isError: true } : {}),
      };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Sprite Sheet") }],
          isError: true,
        };
      }
    }
  );

  // ── 4. 캐릭터 무기별 스프라이트 일괄 생성 ────────────────────────────────
  server.registerTool(
    "asset_generate_character_weapon_sprites",
    {
      title: "Generate Character Weapon Sprites (Structured 3-Frame Workflow)",
      description: `Generate a complete set of sprites for a character with multiple weapons.

For each weapon × action combination, generates exactly 3 animation frames:
  - Frame 0 (f00): Preparation pose — wind-up / ready stance
  - Frame 1 (f01): Peak action   — strike at full extension / peak of motion
  - Frame 2 (f02): Follow-through — recoil / settle / return

Supported actions: "idle" and "attack" (or custom)

Workflow:
  1. Prints a plan table before generating
  2. For each weapon, composes base image onto solid white
  3. Generates all 3 frames per action via gpt-image-2 edit
  4. Strips white background → transparent PNG
  5. Returns structured manifest with all file paths

Args:
  - base_character_path (string): Original character image (any background — handled internally)
  - character_id (string): Character identifier for file naming (e.g. "male", "female")
  - weapons (array): List of weapons to generate sprites for. Each weapon:
      - id (string): weapon identifier, e.g. "exorcist-sword"
      - displayName (string): Human-readable name, e.g. "퇴마 장검"
      - idle_prompt (string): Describe how character holds/uses weapon in idle state
      - attack_f00_prompt (string): Frame 0 — preparation / wind-up pose description
      - attack_f01_prompt (string): Frame 1 — peak strike pose description
      - attack_f02_prompt (string): Frame 2 — follow-through / recoil pose description
  - actions (string[], optional): Which actions to generate. Default: ["idle", "attack"]
  - output_dir (string, optional): Root output directory

Returns:
  Plan table + manifest of all generated sprite file paths.`,
      inputSchema: z.object({
        base_character_path: z.string().min(1).describe("Path to base character image (any background)"),
        character_id: z.string().min(1).max(100).describe("Character identifier for file naming (e.g. 'male', 'female')"),
        weapons: z.array(z.object({
          id: z.string().min(1).describe("Weapon ID for file naming (e.g. 'exorcist-sword')"),
          displayName: z.string().min(1).describe("Human-readable weapon name (e.g. '퇴마 장검')"),
          idle_prompt: z.string().min(1).describe("How character holds/uses weapon in idle pose"),
          attack_f00_prompt: z.string().min(1).describe("Frame 0 attack: preparation/wind-up pose"),
          attack_f01_prompt: z.string().min(1).describe("Frame 1 attack: peak strike pose"),
          attack_f02_prompt: z.string().min(1).describe("Frame 2 attack: follow-through/recoil pose"),
        })).min(1).max(10).describe("List of weapons to generate sprites for"),
        actions: z.array(z.enum(["idle", "attack"])).default(["idle", "attack"])
          .describe("Actions to generate (default: both idle and attack)"),
        chroma_key_bg: z.enum(["magenta", "lime", "cyan", "blue"]).optional()
          .describe("Intermediate background color for edit. Recommended: 'magenta'. Better edge quality than white flood-fill."),
        edit_model: z.string().default("gpt-image-2")
          .describe("OpenAI image edit model"),
        output_dir: z.string().optional().describe("Root output directory"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir ?? DEFAULT_OUTPUT_DIR;
        const safeCharId = params.character_id.replace(/[^a-zA-Z0-9_-]/g, "_");
        const weaponChromaKeyColor = params.chroma_key_bg
          ? CHROMA_KEY_COLORS[params.chroma_key_bg] as [number, number, number]
          : undefined;
        const weaponBgColor = weaponChromaKeyColor ?? WHITE_BG_COLOR;

        // ── 계획 테이블 출력 ────────────────────────────────────────────────
        const planRows: Array<{ character: string; weapon: string; action: string; frame: string; description: string }> = [];
        for (const weapon of params.weapons) {
          if (params.actions.includes("idle")) {
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "idle", frame: "f00", description: "정자세 (기본 대기)" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "idle", frame: "f01", description: "살짝 위로 부유" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "idle", frame: "f02", description: "살짝 아래로 내려옴" });
          }
          if (params.actions.includes("attack")) {
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "attack", frame: "f00", description: "공격 준비/백스윙" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "attack", frame: "f01", description: "공격 정점 (최대 뻗음)" });
            planRows.push({ character: params.character_id, weapon: weapon.displayName, action: "attack", frame: "f02", description: "공격 후 잔상/복귀" });
          }
        }

        const totalSprites = planRows.length;
        console.error(`[character-weapon-sprites] 생성 계획: ${totalSprites}개 스프라이트`);

        // ── 스프라이트 생성 ─────────────────────────────────────────────────
        type WeaponSpriteResult = {
          character: string; weapon_id: string; weapon_name: string;
          action: string; frame: number; file_path: string; success: boolean; error?: string;
        };

        // idle 공통 프레임 프롬프트 (f00/f01/f02 구분)
        const IDLE_FRAME_SUFFIX = [
          "standing in a relaxed neutral pose, weight evenly balanced, feet shoulder-width apart",
          "body floating slightly upward, 10-15px higher than neutral, light effortless feeling",
          "body floating slightly downward back to neutral, completing the idle float cycle",
        ];

        // 베이스 캐릭터를 단색 배경에 합성 (edit API는 투명 PNG 직접 입력 시 렌더링 불안정)
        const tmpWeaponBase = path.join(
          process.env["TMPDIR"] || "/tmp",
          `weapon_base_${safeCharId}_${Date.now()}_${Math.random().toString(36).slice(2)}.png`,
        );
        // 크로마키 모드면 해당 색상 배경 프롬프트, 아니면 undefined(→ WHITE_BG_PROMPT 사용)
        const weaponChromaBgPrompt = weaponChromaKeyColor
          ? buildChromaBgPrompt(weaponChromaKeyColor)
          : undefined;

        let results: WeaponSpriteResult[] = [];
        try {
          const compositedBaseBuffer = await compositeOntoSolidBg(
            path.resolve(params.base_character_path),
            weaponBgColor,
          );
          fs.writeFileSync(tmpWeaponBase, compositedBaseBuffer);

          // 무기 단위 병렬 처리 (무기 간 독립적 — 액션·프레임 내부는 직렬)
          const perWeaponResults = await Promise.all(params.weapons.map(async (weapon) => {
            const safeWeaponId = weapon.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            const weaponResults: WeaponSpriteResult[] = [];

            for (const action of params.actions) {
              const framePrompts =
                action === "idle"
                  ? [
                      `${weapon.idle_prompt} ${IDLE_FRAME_SUFFIX[0]}`,
                      `${weapon.idle_prompt} ${IDLE_FRAME_SUFFIX[1]}`,
                      `${weapon.idle_prompt} ${IDLE_FRAME_SUFFIX[2]}`,
                    ]
                  : [
                      weapon.attack_f00_prompt,
                      weapon.attack_f01_prompt,
                      weapon.attack_f02_prompt,
                    ];

              for (let frameIdx = 0; frameIdx < 3; frameIdx++) {
                const poseDesc = framePrompts[frameIdx];
                const editPrompt = buildActionEditPrompt(poseDesc, undefined, weaponChromaBgPrompt);

                try {
                  const editResult = await editImageOpenAI({
                    imagePath: tmpWeaponBase,
                    prompt: editPrompt,
                    model: params.edit_model as "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
                  });

                  // 배경 제거: 크로마키 모드 또는 순백 flood-fill
                  let processedBuffer: Buffer;
                  if (weaponChromaKeyColor) {
                    processedBuffer = await processFrameBase64Chroma(editResult.base64, weaponChromaKeyColor);
                  } else {
                    processedBuffer = await processFrameBase64(editResult.base64, WHITE_BG_THRESHOLD);
                  }
                  processedBuffer = await addPaddingToBuffer(processedBuffer, 20);

                  // 저장 경로: {output_dir}/sprites/{character_id}/{weapon_id}/{action}_f{frame}.{png|webp}
                  const pathBase = buildAssetPath(
                    outputDir,
                    `sprites/${safeCharId}/${safeWeaponId}`,
                    `${safeCharId}_${safeWeaponId}_${action}_f${String(frameIdx).padStart(2, "0")}.png`,
                  );
                  const written = await writeOptimized(processedBuffer, pathBase);
                  const filePath = written.path;
                  const fileName = path.basename(filePath);

                  const asset: GeneratedAsset = {
                    id: generateAssetId(),
                    type: "image",
                    asset_type: "sprite",
                    provider: `openai/${params.edit_model}`,
                    prompt: editPrompt,
                    file_path: filePath,
                    file_name: fileName,
                    mime_type: written.format === "webp" ? "image/webp" : "image/png",
                    created_at: new Date().toISOString(),
                    metadata: { character_id: params.character_id, weapon_id: weapon.id, action, frame_index: frameIdx },
                  };
                  saveAssetToRegistry(asset, outputDir);

                  weaponResults.push({ character: params.character_id, weapon_id: weapon.id, weapon_name: weapon.displayName, action, frame: frameIdx, file_path: filePath, success: true });
                  console.error(`[character-weapon-sprites] ✅ ${fileName}`);
                } catch (err) {
                  const errMsg = err instanceof Error ? err.message : String(err);
                  weaponResults.push({ character: params.character_id, weapon_id: weapon.id, weapon_name: weapon.displayName, action, frame: frameIdx, file_path: "", success: false, error: errMsg });
                  console.error(`[character-weapon-sprites] ❌ ${weapon.id}/${action}/f${frameIdx}: ${errMsg}`);
                }
              }
            }
            return weaponResults;
          }));

          results = perWeaponResults.flat();
        } finally {
          try { if (fs.existsSync(tmpWeaponBase)) fs.unlinkSync(tmpWeaponBase); } catch { /* ignore */ }
        }

        const succeeded = results.filter(r => r.success).length;
        const failed = results.filter(r => !r.success).length;

        const output = {
          plan: planRows,
          total: totalSprites,
          succeeded,
          failed,
          sprites: results,
          output_dir: `${outputDir}/sprites/${safeCharId}/`,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Character Weapon Sprites") }],
          isError: true,
        };
      }
    }
  );
}
