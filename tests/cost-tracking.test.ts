/**
 * cost-tracking.ts 단위 테스트
 */
import { describe, it, expect } from "vitest";
import {
  estimateImageCost,
  estimateImageEditCost,
  estimateTextCost,
  startLatencyTracker,
  buildCostTelemetry,
  buildEditCostTelemetry,
} from "../src/utils/cost-tracking.js";

describe("estimateImageCost", () => {
  it("gpt-image-2 high는 gpt-image-1-mini low보다 비쌈", () => {
    const high = estimateImageCost("gpt-image-2", "high").usd;
    const miniLow = estimateImageCost("gpt-image-1-mini", "low").usd;
    expect(high).toBeGreaterThan(miniLow);
  });

  it("같은 모델에서 quality 순서: low < medium < high", () => {
    const low = estimateImageCost("gpt-image-2", "low").usd;
    const med = estimateImageCost("gpt-image-2", "medium").usd;
    const high = estimateImageCost("gpt-image-2", "high").usd;
    expect(low).toBeLessThan(med);
    expect(med).toBeLessThan(high);
  });

  it("알려지지 않은 모델은 fallback 가격 반환 (crash 안 함)", () => {
    const r = estimateImageCost("unknown-model-xyz", "auto");
    expect(r.usd).toBeGreaterThan(0);
    expect(r.formula).toContain("fallback");
  });

  it("Gemini/Imagen은 고정 단가", () => {
    const g1 = estimateImageCost("gemini-2.5-flash-image", "auto").usd;
    const g2 = estimateImageCost("imagen-4.0-generate-001", "auto").usd;
    expect(g1).toBeCloseTo(g2, 3);
  });

  it("4K 사이즈는 1024보다 훨씬 비쌈 (사이즈 계수 적용)", () => {
    const normal = estimateImageCost("gpt-image-2", "high", "1024x1024").usd;
    const k4 = estimateImageCost("gpt-image-2", "high", "3840x2160").usd;
    expect(k4).toBeGreaterThan(normal * 2);
  });

  it("model 누락 시에도 crash 없이 숫자 반환", () => {
    const r = estimateImageCost(undefined, "auto");
    expect(typeof r.usd).toBe("number");
    expect(r.usd).toBeGreaterThan(0);
  });
});

describe("estimateTextCost (GPT-5)", () => {
  it("gpt-5.4-nano가 gpt-5.2-pro보다 훨씬 저렴", () => {
    const nano = estimateTextCost("gpt-5.4-nano").usd;
    const pro = estimateTextCost("gpt-5.2-pro").usd;
    expect(pro).toBeGreaterThan(nano * 10);
  });

  it("토큰 많으면 비용 증가", () => {
    const small = estimateTextCost("gpt-5.4-nano", 100, 100).usd;
    const big = estimateTextCost("gpt-5.4-nano", 2000, 5000).usd;
    expect(big).toBeGreaterThan(small);
  });

  it("프롬프트 리파인 예상 비용은 센트 미만", () => {
    // 사용자 안내 가격 (~$0.001)이 실제로 타당한지
    const r = estimateTextCost("gpt-5.4-nano", 200, 300);
    expect(r.usd).toBeLessThan(0.001);
  });
});

describe("startLatencyTracker", () => {
  it("elapsed()는 단조 증가", async () => {
    const t = startLatencyTracker();
    const first = t.elapsed();
    await new Promise((r) => setTimeout(r, 50));
    const second = t.elapsed();
    expect(second).toBeGreaterThanOrEqual(first);
    expect(second).toBeGreaterThanOrEqual(45); // timer 약간 여유
  });

  it("lap()은 인터벌마다 리셋", async () => {
    const t = startLatencyTracker();
    await new Promise((r) => setTimeout(r, 30));
    const lap1 = t.lap();
    await new Promise((r) => setTimeout(r, 30));
    const lap2 = t.lap();
    expect(lap1).toBeGreaterThanOrEqual(25);
    expect(lap2).toBeGreaterThanOrEqual(25);
    expect(lap2).toBeLessThan(lap1 + 30); // 누적 아님 확인
  });
});

describe("buildCostTelemetry", () => {
  it("metadata 조합 필드 모두 포함", () => {
    const t = buildCostTelemetry("gpt-image-2", "high", "1024x1024", 5000);
    expect(t.latency_ms).toBe(5000);
    expect(t.est_cost_usd).toBeGreaterThan(0);
    expect(t.model).toBe("gpt-image-2");
    expect(t.cost_formula).toBeTruthy();
  });

  it("buildEditCostTelemetry는 ref 개수를 formula에 포함", () => {
    const t = buildEditCostTelemetry("gpt-image-2", "1536x1024", 10000, 3);
    expect(t.cost_formula).toContain("3 refs");
    expect(t.latency_ms).toBe(10000);
  });
});
