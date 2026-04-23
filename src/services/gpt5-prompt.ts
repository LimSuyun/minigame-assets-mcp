/**
 * GPT-5 기반 이미지 프롬프트 리파이너.
 *
 * 짧은 사용자 입력(한국어/영어)을 받아 타겟 이미지 모델에 최적화된
 * 영문 상세 프롬프트로 확장한다. 기존 prompt builder 템플릿(프레이밍/
 * no-shadow/no-text 등 제약)은 그대로 유지되고, 이 함수는 "description" 부분만
 * 대체한다.
 *
 * 기본 모델: gpt-5.4-nano (저렴·빠름, 프롬프트 확장 용도로 충분).
 * 품질 더 필요한 경우 textModel에 "gpt-5.2" 또는 "gpt-5.2-pro" 지정.
 */

import axios from "axios";
import { OPENAI_API_URL } from "../constants.js";
import { requireEnvVar } from "../utils/errors.js";

export type GPT5Model = "gpt-5.4-nano" | "gpt-5.2" | "gpt-5.2-pro" | "gpt-5.2-chat-latest";
export const DEFAULT_GPT5_PROMPT_MODEL: GPT5Model = "gpt-5.4-nano";

export type PromptAssetType =
  | "character"
  | "background"
  | "thumbnail"
  | "sprite"
  | "weapon"
  | "icon"
  | "logo"
  | "other";

export type PromptTargetModel =
  | "gpt-image-2"
  | "gpt-image-1.5"
  | "gpt-image-1"
  | "gpt-image-1-mini"
  | "gemini-imagen";

export interface RefinePromptParams {
  /** 사용자가 제공한 원본 설명 (짧거나 모국어여도 됨) */
  userDescription: string;
  /** 최종 이미지를 생성할 모델 — 프롬프트 스타일이 달라짐 */
  targetModel: PromptTargetModel;
  /** 에셋 타입 — 카테고리별 규약 주입 */
  assetType: PromptAssetType;
  /** CONCEPT.md 등에서 가져온 게임 스타일 힌트 (optional) */
  conceptHint?: string;
  /** GPT-5 모델 override. 기본: gpt-5.4-nano */
  textModel?: GPT5Model;
}

// ─── 시스템 프롬프트 ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = [
  "You are an expert image prompt engineer for AI image generation.",
  "Convert the user's brief description into a detailed English art prompt optimized for the target image model.",
  "",
  "STRICT RULES:",
  "1. Preserve the user's intent faithfully. NEVER add subjects, objects, or props the user did not mention.",
  "2. Expand visual detail: colors, materials, textures, lighting, pose, expression, ambience.",
  "3. Match the asset type conventions (provided in the user message).",
  "4. Match the target image model's preferences (provided in the user message).",
  "5. Output ONLY the refined prompt text. No preamble, no explanation, no markdown code fences.",
  "6. Maximum 250 words.",
  "7. Output in English regardless of input language.",
  "8. If a game concept style hint is provided, weave it naturally into the prompt.",
  "9. Do NOT include framing/cropping instructions or shadow/text prohibition clauses — those are added downstream by the caller's template.",
].join("\n");

function buildAssetTypeGuidance(t: PromptAssetType): string {
  switch (t) {
    case "character":
      return "Character portrait/standing pose. Clear silhouette, detailed clothing and accessories, expressive face. Describe physical appearance, attire, age range, distinctive features.";
    case "background":
      return "Wide environmental scene without characters. Layered depth (foreground/midground/background), atmospheric lighting, environmental storytelling details. No UI, no text.";
    case "thumbnail":
      return "Dynamic marketing composition with focal subjects, cinematic framing, high contrast lighting. Should grab attention at small sizes.";
    case "sprite":
      return "Action pose variation of an existing character. Focus on the pose/motion descriptor.";
    case "weapon":
      return "Single weapon item on a clean neutral bg. Slight 3/4 angle, clear silhouette, game inventory style.";
    case "icon":
      return "Single simple symbolic subject, recognizable at 32-64px. Bold shapes, limited palette.";
    case "logo":
      return "Bold, symbolic, clean. Optimized for app icon / marketing. Strong silhouette.";
    default:
      return "Game asset: clean composition, clear focal subject, vibrant game-appropriate aesthetic.";
  }
}

function buildModelGuidance(m: PromptTargetModel): string {
  switch (m) {
    case "gpt-image-2":
      return "gpt-image-2 handles rich detail instructions well. Specify materials (leather, chainmail, silk), lighting type (rim light, soft ambient), art style keywords. Multilingual text rendering supported if text is part of the asset.";
    case "gpt-image-1.5":
    case "gpt-image-1":
    case "gpt-image-1-mini":
      return "gpt-image-1 family: concise focused prompts. State subject clearly first, then key visual attributes, then art style keywords. Avoid over-long sentences.";
    case "gemini-imagen":
      return "Gemini Imagen prefers natural scene description in everyday visual language. Avoid technical camera terms. Write like describing a painting to someone.";
  }
}

// ─── 메인 함수 ───────────────────────────────────────────────────────────────

/**
 * 사용자 입력을 GPT-5 기반으로 확장하여 이미지 생성 모델에 최적화된
 * 영문 상세 프롬프트를 반환한다.
 */
export async function refineImagePrompt(params: RefinePromptParams): Promise<string> {
  const model = params.textModel ?? DEFAULT_GPT5_PROMPT_MODEL;
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  const userMessage = [
    `USER DESCRIPTION:`,
    params.userDescription,
    ``,
    `ASSET TYPE: ${params.assetType}`,
    `ASSET TYPE GUIDANCE: ${buildAssetTypeGuidance(params.assetType)}`,
    ``,
    `TARGET IMAGE MODEL: ${params.targetModel}`,
    `TARGET MODEL GUIDANCE: ${buildModelGuidance(params.targetModel)}`,
    params.conceptHint ? `\nGAME CONCEPT STYLE HINT:\n${params.conceptHint}` : "",
  ].filter(Boolean).join("\n");

  type ChatChoice = { message?: { content?: string } };
  type ChatResponse = { choices?: ChatChoice[] };

  const response = await axios.post<ChatResponse>(
    `${OPENAI_API_URL}/chat/completions`,
    {
      model,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userMessage },
      ],
      // GPT-5 계열 가장 호환성 높은 파라미터만 전송.
      // temperature / top_p / max_tokens는 모델 variant에 따라 거부될 수 있어 생략.
    },
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    },
  );

  const refined = response.data.choices?.[0]?.message?.content?.trim();
  if (!refined) {
    throw new Error(`GPT-5 prompt refinement returned empty content (model: ${model})`);
  }

  // 혹시 모델이 마크다운 코드 펜스나 prefix를 붙인 경우 스트리핑
  return refined
    .replace(/^```[a-z]*\n?/i, "")
    .replace(/\n?```$/i, "")
    .replace(/^["']|["']$/g, "")
    .trim();
}
