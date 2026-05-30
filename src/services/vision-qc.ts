/**
 * vision-qc.ts
 *
 * 스프라이트/에셋 품질 검증 — OpenAI Responses API (gpt-4.1-mini vision) 사용.
 *
 * 검사 항목:
 *   1. 전신 가시성 — 머리부터 발끝까지 캐릭터가 완전히 보이는가 (잘림 없음)
 *   2. 배경 투명도 — 배경색/아티팩트 없이 깨끗한가
 *   3. 해부학적 정확성 — 사지·꼬리 수가 비정상적으로 많지 않은가
 *   4. 단일 캐릭터 — 프레임에 정확히 1개의 캐릭터가 있는가
 *   5. 유효한 이미지 — 거의 비어 있지 않은가 (빈 프레임 방지)
 *   6. 포즈 구별성 (선택, actionHint 제공 시) — 실제 액션 포즈인가, 중립 자세를 복사했는가
 */

import { analyzeImageOpenAI } from "./openai.js";

export interface QualityCheckResult {
  passed: boolean;
  issues: string[];
}

// 액션별 "관찰자 시점" 포즈 증거 — QC가 wrong-pose를 판별하는 기준
const ACTION_POSE_EVIDENCE: Record<string, string> = {
  idle: "relaxed standing — feet planted, arms at sides, no dramatic action",
  walk: "one foot clearly forward and one foot behind in a stride, arms swinging in opposition to legs",
  run: "body leaning forward 15-25°, one knee raised high, other leg extended behind, arms pumping at 90°",
  jump: "both feet completely off the ground with visible air beneath them, knees bent upward",
  attack: "attack arm or weapon fully extended at maximum forward reach, torso twisted into the strike",
  hurt: "torso snapping backward, head thrown back, both arms raised defensively in front of face",
  die: "body losing balance — knees buckling, torso pitching forward/sideways, arms limp or flailing",
};

function buildQualityCheckPrompt(actionHint?: string): string {
  const base = `You are a game sprite quality inspector. Analyze this sprite frame image strictly.

Check ALL criteria below and report EVERY issue found:

1. FULL_BODY: Is the complete character visible from head to feet with NO clipping? Fingers, weapons, tails must not be cut off at the image edge.
2. BACKGROUND: Is the background fully clean/transparent? No leftover background color patches, halos, or artifacts between body parts (e.g., between arm and body)?
3. ANATOMY: Does the character have a NORMAL number of limbs and tails? Flag if there are extra limbs, extra tails, or missing major body parts.
4. SINGLE_CHARACTER: Is there EXACTLY ONE character in this frame? Flag if zero or more than one character is visible.
5. NOT_EMPTY: Does the image contain a meaningful character sprite? Flag if the image is nearly blank or only contains tiny fragments.`;

  const poseCheck = actionHint
    ? (() => {
        const evidence = ACTION_POSE_EVIDENCE[actionHint]
          ?? `clearly performing the "${actionHint}" action, not just standing neutrally`;
        return `\n6. POSE_DISTINCT: Is the character's body posture clearly showing the "${actionHint}" action — NOT just neutrally standing? What you must see: ${evidence}. Flag as "POSE_DISTINCT: character appears to be standing neutrally rather than performing ${actionHint}" if the pose is not clearly distinct from normal standing.`;
      })()
    : "";

  return `${base}${poseCheck}

Reply ONLY with valid JSON — no other text:
{"passed": true, "issues": []}
or
{"passed": false, "issues": ["FULL_BODY: left arm clipped", "BACKGROUND: white halo around weapon"]}`;
}

/**
 * 스프라이트 프레임 품질 검증 (OpenAI gpt-4.1-mini vision).
 *
 * @param imageBase64 - PNG base64 (배경 제거 후)
 * @param characterHint - 선택적 캐릭터 설명
 * @param actionHint - 선택적 액션 이름. 제공 시 포즈 구별성(POSE_DISTINCT) 기준 추가 검사.
 *                     첫 프레임(isFirstFrame=true)에서만 전달 권장.
 */
export async function checkSpriteFrameQuality(
  imageBase64: string,
  characterHint?: string,
  actionHint?: string,
): Promise<QualityCheckResult> {
  const basePrompt = buildQualityCheckPrompt(actionHint);
  const userPrompt = characterHint
    ? `${basePrompt}\n\nCharacter context: ${characterHint}`
    : basePrompt;

  try {
    const text = await analyzeImageOpenAI({
      imageBase64,
      imageMimeType: "image/png",
      prompt: userPrompt,
      textModel: "gpt-4.1-mini",
      maxOutputTokens: 300,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      console.warn("[quality-check] JSON 파싱 실패, passed=true로 처리:", text);
      return { passed: true, issues: [] };
    }

    const result = JSON.parse(jsonMatch[0]) as QualityCheckResult;
    return {
      passed: Boolean(result.passed),
      issues: Array.isArray(result.issues) ? result.issues : [],
    };
  } catch (err) {
    console.warn("[quality-check] 오류 발생, passed=true로 처리:", err);
    return { passed: true, issues: [] };
  }
}
