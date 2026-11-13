/**
 * cost-tracking.ts
 *
 * AI 호출 비용·지연 추적 유틸리티.
 *
 * 각 도구의 `metadata`에 `latency_ms`, `est_cost_usd`, `model`을 포함시켜
 * 사용자가 `assets-registry.json`에서 "내 에셋 생성에 얼마 썼나"를 파악 가능하게 함.
 *
 * ⚠️ 비용은 **추정치**. 실제 청구는 공식 OpenAI/Google 대시보드 참고.
 * 모델·크기·품질 조합별로 경험적 가격 범위를 반환.
 */


import { normalizeImageModelId, resolveImageQuality } from "../models.js";

// ─── 모델별 추정 단가 테이블 (USD, 1024×1024 기준) ──────────────────────────
//
// GPT Image 계열은 출력 토큰 과금($30 / 1M image output tokens)이다.
// 아래 값은 2026-11-12 실측 출력 토큰 × $30/1M 로 환산한 장당 추정치.
//   gpt-image-2.6-flare : low 824 / medium 1,449 / high 1,758 토큰
//   gpt-image-2.5-flare : low 196 / medium   439 / high 1,756 토큰
//   gpt-image-2         : OpenAI 공식 장당 단가표 (medium 1,756 토큰 실측과 일치)
// sunburst 는 low(824 토큰)만 실측 — medium/high 는 flare 와 같다고 가정.
// 입력(프롬프트·참조 이미지) 토큰 비용은 포함하지 않는다.

export type ImageModelPricing = {
  /** 이미지 생성 단건 추정 단가 (USD). quality에 따라 변동 */
  perImage: Record<"low" | "medium" | "high" | "auto", number>;
};

const OPENAI_IMAGE_PRICING: Record<string, ImageModelPricing> = {
  "gpt-image-2.6-flare": {
    perImage: { low: 0.025, medium: 0.043, high: 0.053, auto: 0.043 },
  },
  "gpt-image-2.6-sunburst": {
    perImage: { low: 0.025, medium: 0.043, high: 0.053, auto: 0.043 },
  },
  "gpt-image-2.5-flare": {
    perImage: { low: 0.006, medium: 0.013, high: 0.053, auto: 0.013 },
  },
  "gpt-image-2.5-sunburst": {
    perImage: { low: 0.006, medium: 0.013, high: 0.053, auto: 0.013 },
  },
  "gpt-image-2": {
    perImage: { low: 0.006, medium: 0.053, high: 0.211, auto: 0.053 },
  },
};

/** 단가표에 없는 모델의 fallback 기준 모델 */
const FALLBACK_PRICING_MODEL = "gpt-image-2.6-flare";

// 2K/4K 사이즈 요금 계수. 1536/1792 급 직사각형은 1024² 와 토큰 수가 비슷해 1배로 둔다
// (2.6-flare medium 실측: 1024² 1,449 / 1536×1024 1,132 토큰).
function sizeMultiplier(size: string | undefined): number {
  if (!size) return 1;
  const lower = size.toLowerCase();
  if (lower.includes("3840") || lower.includes("2160") || lower.includes("4k")) return 3.0;
  if (lower.includes("2048") || lower.includes("1152")) return 1.8;
  return 1;
}

// GPT-5 계열 텍스트 모델 — per-token 과금 (추정)
// (input $/1M tokens, output $/1M tokens)
const GPT5_TEXT_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "gpt-5.4-nano": { inputPer1M: 0.10, outputPer1M: 0.40 },
  "gpt-5.2": { inputPer1M: 0.50, outputPer1M: 2.00 },
  "gpt-5.2-pro": { inputPer1M: 3.00, outputPer1M: 12.00 },
};

// ─── 공개 함수 ───────────────────────────────────────────────────────────────

export interface ImageCostEstimate {
  /** USD 단위 추정 비용 */
  usd: number;
  /** 사용된 가격 공식 설명 (디버깅용) */
  formula: string;
}

/**
 * 이미지 생성 단건 추정 비용.
 *
 * @param model 모델 ID (gpt-image-2.6-flare, gpt-image-2 등). 종료된 ID는 대체 모델 기준으로 계산
 * @param quality low/medium/high/auto
 * @param size 선택적 (2K/4K면 요금 계수 적용)
 */
export function estimateImageCost(
  model: string | undefined,
  quality: "low" | "medium" | "high" | "auto" | undefined = "auto",
  size?: string,
): ImageCostEstimate {
  const modelId = model ? normalizeImageModelId(model) : undefined;
  const pricing = modelId ? OPENAI_IMAGE_PRICING[modelId] : undefined;
  if (!pricing) {
    // 알려지지 않은 모델 — 기본 모델(gpt-image-2.6-flare) 요금으로 근사
    const fallback = OPENAI_IMAGE_PRICING[FALLBACK_PRICING_MODEL].perImage[quality] ?? 0.043;
    return { usd: fallback, formula: `unknown-model fallback ($${fallback})` };
  }

  const base = pricing.perImage[quality];
  const mult = sizeMultiplier(size);
  const usd = +(base * mult).toFixed(4);
  return {
    usd,
    formula: `${modelId} × ${quality} × size-mult ${mult} = $${base} × ${mult}`,
  };
}

/**
 * 이미지 edit 호출 추정 비용. 출력 토큰 기준이라 generate와 같은 단가를 쓴다
 * (참조 이미지 입력 토큰 비용은 미포함).
 * quality 미지정 시 서비스 계층 기본값을 따른다: gpt-image-2.5/2.6 계열은 medium,
 * gpt-image-2 는 API 기본(auto) → 보수적으로 high 가정.
 */
export function estimateImageEditCost(
  model: string | undefined,
  size?: string,
): ImageCostEstimate {
  const quality = model ? resolveImageQuality(model, undefined) ?? "high" : "high";
  return estimateImageCost(model, quality, size);
}

/**
 * GPT-5 텍스트 생성 비용 추정. 프롬프트 리파인 용도.
 * 토큰 수를 알 수 없으면 평균값(input 200 / output 300)으로 근사.
 */
export function estimateTextCost(
  model: string | undefined,
  inputTokens = 200,
  outputTokens = 300,
): ImageCostEstimate {
  if (!model) return { usd: 0, formula: "no model" };
  const p = GPT5_TEXT_PRICING[model] ?? GPT5_TEXT_PRICING["gpt-5.4-nano"];
  const inputCost = (inputTokens / 1_000_000) * p.inputPer1M;
  const outputCost = (outputTokens / 1_000_000) * p.outputPer1M;
  const usd = +(inputCost + outputCost).toFixed(6);
  return { usd, formula: `${model}: in=${inputTokens}t out=${outputTokens}t` };
}

// ─── 지연(latency) 추적 헬퍼 ─────────────────────────────────────────────────

export interface LatencyTracker {
  /** 밀리초 단위로 경과 시간 반환하고 내부 상태를 리셋 */
  lap(): number;
  /** 시작 시점부터 현재까지 총 경과 시간 (ms) */
  elapsed(): number;
}

export function startLatencyTracker(): LatencyTracker {
  const startedAt = Date.now();
  let lapStart = startedAt;
  return {
    lap() {
      const now = Date.now();
      const ms = now - lapStart;
      lapStart = now;
      return ms;
    },
    elapsed() {
      return Date.now() - startedAt;
    },
  };
}

// ─── metadata 조합 헬퍼 ─────────────────────────────────────────────────────

export interface CostTelemetry {
  latency_ms: number;
  est_cost_usd: number;
  cost_formula?: string;
  model?: string;
}

/**
 * metadata에 포함할 비용 텔레메트리 객체 생성.
 * 이미지 생성 호출 후:
 *   const tracker = startLatencyTracker();
 *   const r = await generateImageOpenAI(...);
 *   const cost = buildCostTelemetry("gpt-image-2", "high", "1024x1024", tracker.elapsed());
 *   metadata: { ..., ...cost }
 */
export function buildCostTelemetry(
  model: string | undefined,
  quality: "low" | "medium" | "high" | "auto" | undefined,
  size: string | undefined,
  latencyMs: number,
): CostTelemetry {
  const est = estimateImageCost(model, quality, size);
  return {
    latency_ms: latencyMs,
    est_cost_usd: est.usd,
    cost_formula: est.formula,
    ...(model ? { model } : {}),
  };
}

/**
 * Edit 호출용 간편 빌더.
 */
export function buildEditCostTelemetry(
  model: string | undefined,
  size: string | undefined,
  latencyMs: number,
  refCount: number = 1,
): CostTelemetry {
  const est = estimateImageEditCost(model, size);
  return {
    latency_ms: latencyMs,
    est_cost_usd: est.usd,
    cost_formula: `${est.formula} (${refCount} refs)`,
    ...(model ? { model } : {}),
  };
}
