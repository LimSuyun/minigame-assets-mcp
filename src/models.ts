/**
 * models.ts — OpenAI 모델 레지스트리 (단일 진실 공급원)
 *
 * 모델 ID·기본값·지원 종료 대응을 이 파일 한 곳에서 관리한다.
 * OpenAI가 모델을 종료하면 여기만 고치면 된다:
 *   1. 종료된 ID를 목록에서 빼고 RETIRED_*_REPLACEMENTS 에 대체 모델을 등록
 *   2. 필요하면 DEFAULT_* 값을 교체
 *   3. utils/cost-tracking.ts 의 단가 테이블 갱신
 *
 * 지원 종료 일정 (OpenAI 공식 deprecations, 2026-11-12 확인):
 *   - gpt-image-1                          2026-10-23 종료됨
 *   - gpt-image-1-mini / gpt-image-1.5     2026-12-01 종료
 *   - gpt-4.1 / gpt-4.1-mini / gpt-4o(-mini) 2027-01-14 종료
 *   - gpt-image-2                          2027-02-10 종료
 *   - gpt-5.4-nano                         2027-04-01 종료
 */

import { z } from "zod";

// ─── 이미지 모델 ─────────────────────────────────────────────────────────────

/**
 * 선택 가능한 이미지 모델.
 * - gpt-image-2.6-flare    : 기본. 빠른 범용 생성, 네이티브 투명 배경.
 * - gpt-image-2.6-sunburst : 편집 정밀도 우선 (느림).
 * - gpt-image-2.5-flare    : 가장 저렴. 단, 투명 배경 요청이 간헐적으로 무시됨(실측).
 * - gpt-image-2.5-sunburst
 * - gpt-image-2            : 투명 배경 미지원(마젠타 크로마키 경로). 2027-02-10 종료 예정.
 */
export const OPENAI_IMAGE_MODELS = [
  "gpt-image-2.6-flare",
  "gpt-image-2.6-sunburst",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "gpt-image-2",
] as const;
export type OpenAIImageModel = typeof OPENAI_IMAGE_MODELS[number];

/** 종료된(또는 종료가 임박한) 이미지 모델 → 대체 모델. 옛 ID로 들어온 요청을 자동 치환한다. */
export const RETIRED_IMAGE_MODEL_REPLACEMENTS: Readonly<Record<string, OpenAIImageModel>> = {
  "gpt-image-1": "gpt-image-2.6-flare",
  "gpt-image-1-mini": "gpt-image-2.6-flare",
  "gpt-image-1.5": "gpt-image-2.6-flare",
  "chatgpt-image-latest": "gpt-image-2.6-flare",
};

/** background: "transparent" 를 거부하는 모델 (크로마키 후처리 필요). */
export const OPENAI_MODELS_NO_TRANSPARENT_BG: ReadonlyArray<string> = ["gpt-image-2"];

const warnedRetired = new Set<string>();

/** 종료된 모델 ID를 대체 모델로 치환한다 (모델당 1회 stderr 경고). 그 외 문자열은 그대로 반환. */
export function normalizeImageModelId(model: string): string {
  const replacement = RETIRED_IMAGE_MODEL_REPLACEMENTS[model];
  if (!replacement) return model;
  if (!warnedRetired.has(model)) {
    warnedRetired.add(model);
    console.error(
      `[minigame-assets-mcp] 이미지 모델 "${model}" 은(는) OpenAI에서 지원 종료되어 "${replacement}" 로 대체합니다.`,
    );
  }
  return replacement;
}

function readEnvModel(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/**
 * 기본 이미지 모델. `OPENAI_IMAGE_MODEL` 환경변수로 교체 가능
 * (예: 비용 우선이면 gpt-image-2.5-flare).
 */
export const DEFAULT_OPENAI_IMAGE_MODEL: string = normalizeImageModelId(
  readEnvModel("OPENAI_IMAGE_MODEL") ?? "gpt-image-2.6-flare",
);

/**
 * 캐릭터 베이스·스프라이트·로고·썸네일 등 특수 목적 파이프라인의 기본 모델.
 * 마젠타 크로마키 경로와 함께 검증된 gpt-image-2 를 유지한다 (2027-02-10 종료 전 이전 필요).
 */
export const DEFAULT_PIPELINE_IMAGE_MODEL = "gpt-image-2";

/** 미지정 시 기본 모델, 종료된 ID면 대체 모델을 반환한다. */
export function resolveImageModel(model?: string | null): string {
  return model ? normalizeImageModelId(model) : DEFAULT_OPENAI_IMAGE_MODEL;
}

/** 네이티브 투명 배경(RGBA PNG) 출력 지원 여부. */
export function supportsNativeTransparency(model: string): boolean {
  return !OPENAI_MODELS_NO_TRANSPARENT_BG.includes(normalizeImageModelId(model));
}

export type ImageQuality = "low" | "medium" | "high" | "auto";

/**
 * API에 전송할 quality 값을 결정한다.
 *
 * gpt-image-2.5/2.6 계열은 quality 를 생략하거나 "auto" 로 보내면 출력 토큰이
 * medium 대비 약 4배까지 늘어난다(2.6-flare 1024² 실측: medium 1,449 / auto 5,795 토큰).
 * 의도치 않은 과금을 막기 위해 이 계열은 미지정·auto 를 "medium" 으로 고정한다.
 * gpt-image-2 는 기존 동작(지정된 값만 전송)을 유지한다.
 */
export function resolveImageQuality(
  model: string,
  requested: ImageQuality | undefined,
): ImageQuality | undefined {
  if (normalizeImageModelId(model) === "gpt-image-2") return requested;
  if (!requested || requested === "auto") return "medium";
  return requested;
}

/**
 * 도구 inputSchema용 이미지 모델 스키마.
 * 종료된 모델 ID(gpt-image-1 계열)가 들어오면 거부하지 않고 대체 모델로 치환한다.
 */
export const imageModelSchema = z.preprocess(
  (value) => (typeof value === "string" ? normalizeImageModelId(value) : value),
  z.enum(OPENAI_IMAGE_MODELS),
);

// ─── 텍스트 / 비전 모델 ──────────────────────────────────────────────────────

/** Vision QC·자동 선별(asset_select_best)·canon 일관성 검사용 모델. `OPENAI_VISION_MODEL` 로 교체 가능. */
export const DEFAULT_VISION_MODEL: string = readEnvModel("OPENAI_VISION_MODEL") ?? "gpt-4.1-mini";

/** Responses API(image_generation tool)에 쓰는 텍스트 모델. */
export const RESPONSES_TEXT_MODELS = ["gpt-4.1", "gpt-4.1-mini", "gpt-4o", "gpt-4o-mini"] as const;
export type ResponsesTextModel = typeof RESPONSES_TEXT_MODELS[number];
export const DEFAULT_RESPONSES_TEXT_MODEL: ResponsesTextModel = "gpt-4.1";

/** 프롬프트 리파인(refine_prompt)용 모델. gpt-5.2-chat-latest 는 2026-08-10 종료되어 제거. */
export const PROMPT_REFINE_MODELS = ["gpt-5.4-nano", "gpt-5.2", "gpt-5.2-pro"] as const;
export type PromptRefineModel = typeof PROMPT_REFINE_MODELS[number];
/** `OPENAI_PROMPT_MODEL` 로 교체 가능. */
export const DEFAULT_PROMPT_REFINE_MODEL: string = readEnvModel("OPENAI_PROMPT_MODEL") ?? "gpt-5.4-nano";
