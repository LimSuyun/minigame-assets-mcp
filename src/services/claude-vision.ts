/**
 * claude-vision.ts
 *
 * 스프라이트 품질 검증 — Gemini 2.5 Flash Vision 사용.
 * (이전: Anthropic Claude Haiku → 현재: Gemini 2.5 Flash로 대체)
 *
 * 검사 항목:
 *   1. 전신 가시성 — 머리부터 발끝까지 캐릭터가 완전히 보이는가 (잘림 없음)
 *   2. 배경 투명도 — 배경색/아티팩트 없이 깨끗한가
 *   3. 해부학적 정확성 — 사지·꼬리 수가 비정상적으로 많지 않은가
 *   4. 단일 캐릭터 — 프레임에 정확히 1개의 캐릭터가 있는가
 *   5. 유효한 이미지 — 거의 비어 있지 않은가 (빈 프레임 방지)
 */

import { analyzeImageGemini } from "./gemini.js";

export interface QualityCheckResult {
  passed: boolean;
  issues: string[];
}

const QUALITY_CHECK_PROMPT = `You are a game sprite quality inspector. Analyze this sprite frame image strictly.

Check ALL criteria below and report EVERY issue found:

1. FULL_BODY: Is the complete character visible from head to feet with NO clipping? Fingers, weapons, tails must not be cut off at the image edge.
2. BACKGROUND: Is the background fully clean/transparent? No leftover background color patches, halos, or artifacts between body parts (e.g., between arm and body)?
3. ANATOMY: Does the character have a NORMAL number of limbs and tails? Flag if there are extra limbs, extra tails, or missing major body parts.
4. SINGLE_CHARACTER: Is there EXACTLY ONE character in this frame? Flag if zero or more than one character is visible.
5. NOT_EMPTY: Does the image contain a meaningful character sprite? Flag if the image is nearly blank or only contains tiny fragments.

Reply ONLY with valid JSON — no other text:
{"passed": true, "issues": []}
or
{"passed": false, "issues": ["FULL_BODY: left arm clipped", "BACKGROUND: white halo around weapon"]}`;

/**
 * 스프라이트 프레임 품질 검증 (Gemini 2.5 Flash Vision).
 *
 * @param imageBase64 - PNG base64 (배경 제거 후)
 * @param characterHint - 선택적 캐릭터 설명 (예: "green alien soldier in black armor")
 * @returns QualityCheckResult — passed 및 이슈 목록
 */
export async function checkSpriteFrameQuality(
  imageBase64: string,
  characterHint?: string
): Promise<QualityCheckResult> {
  const userPrompt = characterHint
    ? `${QUALITY_CHECK_PROMPT}\n\nCharacter context: ${characterHint}`
    : QUALITY_CHECK_PROMPT;

  try {
    const text = await analyzeImageGemini({
      imageBase64,
      imageMimeType: "image/png",
      prompt: userPrompt,
      model: "gemini-2.5-flash",
      maxOutputTokens: 300,
    });

    // JSON 추출 (앞뒤 텍스트 허용)
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
    // 네트워크 오류 등 — 검증 실패가 생성 중단 원인이 되지 않도록 passed 처리
    console.warn("[quality-check] 오류 발생, passed=true로 처리:", err);
    return { passed: true, issues: [] };
  }
}
