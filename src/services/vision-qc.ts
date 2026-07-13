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
 *   7. 손가락 수 (FINGERS) — 보이는 각 손의 손가락 수가 양손 동일·스타일 기준에 부합하는가
 *   8. 좌우 구분 (CHIRALITY) — 왼손/오른손·왼발/오른발이 올바른가 ("왼손 두 개" 오류)
 *   9. 방향 일관성 (FACING, 기준 이미지 제공 시) — 기준 이미지와 같은 방향을 보는가
 *  10. 소품 위치 (PROP_SIDE, 기준 이미지 제공 시) — 무기/소품이 기준과 같은 손·같은 쪽에 있는가
 */

import sharp from "sharp";
import { analyzeImageOpenAI } from "./openai.js";

export interface QualityCheckResult {
  passed: boolean;
  issues: string[];
}

export interface QualityCheckOptions {
  /** 캐릭터 설명 (컨텍스트) */
  characterHint?: string;
  /** 액션 이름. 제공 시 포즈 구별성(POSE_DISTINCT) 검사 추가. 첫 프레임에서만 전달 권장. */
  actionHint?: string;
  /**
   * 아트 스타일 힌트 (예: "chibi cartoon", "realistic").
   * FINGERS 검사에서 스타일 기준 손가락 수(치비·카툰은 3~4개가 정상)를 판정하는 데 사용.
   */
  styleHint?: string;
  /**
   * 캐릭터 종족. FINGERS/CHIRALITY 엄격도를 결정한다.
   * - "human": 손가락 수 엄격 카운팅 + 엄지 방향 검사
   * - "creature": 동물/마스코트/로봇 — 극단적 손 오류(6개 이상·융합 뭉개짐)만 감지
   * - "auto" (기본): vision 모델이 먼저 종족을 판별 후 기준 적용
   */
  characterKind?: "human" | "creature" | "auto";
  /**
   * 기준 이미지 (base/canon) PNG base64.
   * 제공 시 FACING(방향 일관성)·PROP_SIDE(소품 위치) 비교 검사 추가.
   */
  referenceBase64?: string;
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

// vision 모델이 손가락 카운팅 등 세부 검사를 안정적으로 하기 위한 최소 변 길이
const QC_MIN_DIMENSION = 512;

/**
 * 저해상도 이미지를 검사 전 업스케일 (최소 변 512px).
 * 손가락 카운팅 등 세부 검사 정확도를 위한 보정. 실패 시 원본 그대로 반환.
 */
async function prepareImageForQC(base64: string): Promise<string> {
  try {
    const buf = Buffer.from(base64, "base64");
    const meta = await sharp(buf).metadata();
    const minSide = Math.min(meta.width ?? 0, meta.height ?? 0);
    if (minSide === 0 || minSide >= QC_MIN_DIMENSION) return base64;
    const scale = Math.ceil(QC_MIN_DIMENSION / minSide);
    const resized = await sharp(buf)
      .resize((meta.width ?? 0) * scale, (meta.height ?? 0) * scale, {
        kernel: sharp.kernel.lanczos3,
      })
      .png()
      .toBuffer();
    return resized.toString("base64");
  } catch {
    return base64;
  }
}

function buildQualityCheckPrompt(opts: QualityCheckOptions): string {
  const base = `You are a game sprite quality inspector. Analyze the sprite frame image strictly.

Check ALL criteria below and report EVERY issue found:

1. FULL_BODY: Is the complete character visible from head to feet with NO clipping? Fingers, weapons, tails must not be cut off at the image edge.
2. BACKGROUND: Is the background fully clean/transparent? No leftover background color patches, halos, or artifacts between body parts (e.g., between arm and body)?
3. ANATOMY: Does the character have a NORMAL number of limbs and tails? Flag if there are extra limbs, extra tails, or missing major body parts.
4. SINGLE_CHARACTER: Is there EXACTLY ONE character in this frame? Flag if zero or more than one character is visible.
5. NOT_EMPTY: Does the image contain a meaningful character sprite? Flag if the image is nearly blank or only contains tiny fragments.`;

  const styleNote = opts.styleHint
    ? `The art style is "${opts.styleHint}" — stylized characters (chibi/cartoon) legitimately have 3-4 fingers per hand; realistic styles have 5.`
    : `Stylized characters (chibi/cartoon) legitimately have 3-4 fingers per hand; realistic styles have 5.`;

  // 종족별 손 검사 엄격도 — 인간형만 엄격 카운팅, 동물/크리처의 벙어리장갑형 발은
  // 손가락 구분 자체가 무의미하므로 극단적 오류만 감지 (오탐 방지)
  const kind = opts.characterKind ?? "auto";
  const strictFingers = `For EACH visible hand, explicitly COUNT the fingers you see and state the count (e.g., "left hand: 4, right hand: 4"). ${styleNote} Flag if: the two hands show DIFFERENT finger counts, any hand has MORE than 5 fingers, or fingers are fused/mangled. If hands are hidden, in fists, or too small to count reliably, state "hands not countable" and do NOT flag.`;
  const lenientFingers = `The character is a non-human (animal/mascot/creature/robot) — paws and mitten-like hands are NORMAL and finger counting does NOT apply. ONLY flag egregious hand errors: 6 or more distinct digits on one paw, or a mangled/fused hand mass that reads as an artifact. Do NOT flag paw-style hands, indistinct fingers, or minor count differences.`;

  const fingersCheck = kind === "human"
    ? `\n6. FINGERS: ${strictFingers}`
    : kind === "creature"
      ? `\n6. FINGERS: ${lenientFingers}`
      : `\n6. FINGERS: FIRST determine whether the character is (a) human/humanoid with articulated hands, or (b) a non-human animal/mascot/creature/robot with paws or mitten-like hands. If (a): ${strictFingers} If (b): ${lenientFingers}`;

  const chiralityCheck = kind === "creature"
    ? `
7. CHIRALITY: Are left and right limbs consistent? For paw-style hands skip thumb checks — only flag feet/shoes pointing the anatomically wrong way or a limb bending backwards.`
    : `
7. CHIRALITY: Are left and right hands/feet anatomically correct? For articulated hands check thumb positions (thumbs should face INWARD toward the body on both hands); for paw/mitten hands skip thumb checks. Check foot/shoe orientation. Flag "two left hands", "two right feet", or a limb bending the wrong way.`;

  const poseCheck = opts.actionHint
    ? (() => {
        const evidence = ACTION_POSE_EVIDENCE[opts.actionHint!]
          ?? `clearly performing the "${opts.actionHint}" action, not just standing neutrally`;
        return `
8. POSE_DISTINCT: Is the character's body posture clearly showing the "${opts.actionHint}" action — NOT just neutrally standing? What you must see: ${evidence}. Flag as "POSE_DISTINCT: character appears to be standing neutrally rather than performing ${opts.actionHint}" if the pose is not clearly distinct from normal standing.`;
      })()
    : "";

  const referenceChecks = opts.referenceBase64
    ? `
The FIRST image is the REFERENCE (canonical base). The SECOND image is the FRAME under inspection. Additionally check the frame AGAINST the reference:
9. FACING: Is the character facing the SAME direction (left/right) as in the reference image? Flag "FACING: character is mirrored/facing opposite direction" if flipped.
10. PROP_SIDE: Are weapons/held items/asymmetric accessories on the SAME side and in the SAME hand as in the reference image? Flag "PROP_SIDE: item moved from X hand to Y hand" if a prop switched sides.`
    : "";

  return `${base}${fingersCheck}${chiralityCheck}${poseCheck}${referenceChecks}

Reply ONLY with valid JSON — no other text:
{"passed": true, "issues": [], "finger_counts": "left: 4, right: 4"}
or
{"passed": false, "issues": ["FULL_BODY: left arm clipped", "FINGERS: left hand has 6 fingers", "PROP_SIDE: sword moved from right hand to left hand"], "finger_counts": "left: 6, right: 5"}`;
}

/**
 * 스프라이트 프레임 품질 검증 (OpenAI gpt-4.1-mini vision).
 *
 * @param imageBase64 - PNG base64 (배경 제거 후)
 * @param characterHintOrOpts - 캐릭터 설명 문자열(레거시) 또는 QualityCheckOptions
 * @param actionHint - (레거시 시그니처) 액션 이름
 */
export async function checkSpriteFrameQuality(
  imageBase64: string,
  characterHintOrOpts?: string | QualityCheckOptions,
  actionHint?: string,
): Promise<QualityCheckResult> {
  const opts: QualityCheckOptions =
    typeof characterHintOrOpts === "string" || characterHintOrOpts === undefined
      ? { characterHint: characterHintOrOpts as string | undefined, actionHint }
      : characterHintOrOpts;

  const basePrompt = buildQualityCheckPrompt(opts);
  const userPrompt = opts.characterHint
    ? `${basePrompt}\n\nCharacter context: ${opts.characterHint}`
    : basePrompt;

  try {
    const prepared = await prepareImageForQC(imageBase64);

    const text = await analyzeImageOpenAI(
      opts.referenceBase64
        ? {
            imageBase64: opts.referenceBase64,
            imageMimeType: "image/png",
            primaryLabel: "Image 1 — REFERENCE (canonical base):",
            additionalImages: [{
              base64: prepared,
              mimeType: "image/png",
              label: "Image 2 — FRAME under inspection:",
            }],
            prompt: userPrompt,
            textModel: "gpt-4.1-mini",
            maxOutputTokens: 400,
          }
        : {
            imageBase64: prepared,
            imageMimeType: "image/png",
            prompt: userPrompt,
            textModel: "gpt-4.1-mini",
            maxOutputTokens: 400,
          }
    );

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

// ─── 후보 채점 (asset_select_best) ───────────────────────────────────────────

export interface CandidateScore {
  /** 0-10 종합 점수 */
  total: number;
  /** 차원별 점수 */
  scores: {
    style_fit: number;
    composition: number;
    clarity: number;
    technical: number;
  };
  /** 실격 사유 (있으면 선정 대상에서 제외) */
  disqualifiers: string[];
  /** 채점 근거 요약 */
  rationale: string;
}

/**
 * 후보 이미지 1장을 루브릭 기준으로 채점.
 * 사람의 "옥석 고르기"를 대체하는 자동 선별용 — asset_select_best에서 사용.
 *
 * @param imageBase64  후보 이미지 PNG base64
 * @param purpose      이미지 용도 설명 (예: "key visual for a cozy farming game")
 * @param styleContext CONCEPT.md 기반 스타일/팔레트 텍스트
 */
export async function scoreCandidateImage(
  imageBase64: string,
  purpose: string,
  styleContext?: string,
): Promise<CandidateScore> {
  const prompt = `You are a strict art director selecting the best AI-generated candidate for: ${purpose}
${styleContext ? `\nProject style guide:\n${styleContext}\n` : ""}
Score this candidate on each dimension from 0 (unusable) to 10 (excellent):

- style_fit: How well does it match the project style guide (art style, color palette, mood)?
- composition: Is the composition clear and well-framed? Main subject readable at a glance, no awkward cropping?
- clarity: Are shapes, edges, and details clean? No mushy/ambiguous areas, no unintended text or watermarks?
- technical: Fundamental soundness. Deduct for: anatomical errors (wrong finger counts, extra/missing limbs, two left hands), broken perspective, inconsistent lighting, artifacts.

DISQUALIFIERS — list any of these found (a disqualified candidate cannot be selected):
- visible text, letters, or watermarks
- extra characters or duplicated subjects
- severe anatomical errors (fused faces, 6+ fingers, extra limbs)
- subject clipped at image edge

Reply ONLY with valid JSON:
{"scores": {"style_fit": 8, "composition": 7, "clarity": 9, "technical": 8}, "disqualifiers": [], "rationale": "one-sentence summary"}`;

  const fallback: CandidateScore = {
    total: 0,
    scores: { style_fit: 0, composition: 0, clarity: 0, technical: 0 },
    disqualifiers: [],
    rationale: "채점 실패 (vision 응답 파싱 불가)",
  };

  try {
    const text = await analyzeImageOpenAI({
      imageBase64,
      imageMimeType: "image/png",
      prompt,
      textModel: "gpt-4.1-mini",
      maxOutputTokens: 400,
    });

    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return fallback;

    const parsed = JSON.parse(jsonMatch[0]) as {
      scores?: Partial<CandidateScore["scores"]>;
      disqualifiers?: string[];
      rationale?: string;
    };
    const s = {
      style_fit: Number(parsed.scores?.style_fit ?? 0),
      composition: Number(parsed.scores?.composition ?? 0),
      clarity: Number(parsed.scores?.clarity ?? 0),
      technical: Number(parsed.scores?.technical ?? 0),
    };
    return {
      total: Math.round(((s.style_fit + s.composition + s.clarity + s.technical) / 4) * 10) / 10,
      scores: s,
      disqualifiers: Array.isArray(parsed.disqualifiers) ? parsed.disqualifiers : [],
      rationale: parsed.rationale ?? "",
    };
  } catch (err) {
    console.warn("[score-candidate] 오류:", err);
    return fallback;
  }
}
