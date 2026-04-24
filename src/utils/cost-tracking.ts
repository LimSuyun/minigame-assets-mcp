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

// ─── 모델별 추정 단가 테이블 (USD, 2026-04 기준 추정) ───────────────────────

export type ImageModelPricing = {
  /** 이미지 생성 단건 추정 단가 (USD). quality/size에 따라 변동 */
  perImage: Record<"low" | "medium" | "high" | "auto", number>;
};

// OpenAI gpt-image 계열 — quality별 구분 명확
const OPENAI_IMAGE_PRICING: Record<string, ImageModelPricing> = {
  "gpt-image-2": {
    perImage: { low: 0.01, medium: 0.02, high: 0.04, auto: 0.025 },
  },
  "gpt-image-1.5": {
    perImage: { low: 0.008, medium: 0.016, high: 0.03, auto: 0.02 },
  },
  "gpt-image-1": {
    perImage: { low: 0.005, medium: 0.012, high: 0.02, auto: 0.015 },
  },
  "gpt-image-1-mini": {
    perImage: { low: 0.003, medium: 0.008, high: 0.015, auto: 0.01 },
  },
};

// 2K/4K 사이즈 요금 계수 (gpt-image-2 전용)
function sizeMultiplier(size: string | undefined): number {
  if (!size) return 1;
  const lower = size.toLowerCase();
  if (lower.includes("3840") || lower.includes("2160") || lower.includes("4k")) return 3.0;
  if (lower.includes("2048") || lower.includes("1152")) return 1.8;
  if (lower.includes("1792") || lower.includes("1536")) return 1.3;
  return 1;
}

// GPT-5 계열 텍스트 모델 — per-token 과금 (추정)
// (input $/1M tokens, output $/1M tokens)
const GPT5_TEXT_PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  "gpt-5.4-nano": { inputPer1M: 0.10, outputPer1M: 0.40 },
  "gpt-5.2": { inputPer1M: 0.50, outputPer1M: 2.00 },
  "gpt-5.2-pro": { inputPer1M: 3.00, outputPer1M: 12.00 },
  "gpt-5.2-chat-latest": { inputPer1M: 0.50, outputPer1M: 2.00 },
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
 * @param model 모델 ID (gpt-image-2, gpt-image-1 등)
 * @param quality low/medium/high/auto
 * @param size 선택적 (2K/4K면 요금 계수 적용)
 */
export function estimateImageCost(
  model: string | undefined,
  quality: "low" | "medium" | "high" | "auto" | undefined = "auto",
  size?: string,
): ImageCostEstimate {
  const pricing = model ? OPENAI_IMAGE_PRICING[model] : undefined;
  if (!pricing) {
    // 알려지지 않은 모델 — 보수적으로 gpt-image-1 요금 사용
    const fallback = OPENAI_IMAGE_PRICING["gpt-image-1"].perImage[quality] ?? 0.02;
    return { usd: fallback, formula: `unknown-model fallback ($${fallback})` };
  }

  const base = pricing.perImage[quality];
  const mult = sizeMultiplier(size);
  const usd = +(base * mult).toFixed(4);
  return {
    usd,
    formula: `${model} × ${quality} × size-mult ${mult} = $${base} × ${mult}`,
  };
}

/**
 * 이미지 edit 호출은 generate와 유사 비용으로 추정 (대부분의 API가 동일 과금).
 * 추가 참조 이미지 있어도 같은 가격 (입력 토큰 기반 과금 모델 제외).
 */
export function estimateImageEditCost(
  model: string | undefined,
  size?: string,
): ImageCostEstimate {
  // edit은 quality 옵션 없음 — high 고정 가정
  return estimateImageCost(model, "high", size);
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
