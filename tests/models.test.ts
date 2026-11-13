/**
 * models.ts (모델 레지스트리) + KS X 1001 한글 표 단위 테스트
 */
import { describe, it, expect } from "vitest";
import {
  OPENAI_IMAGE_MODELS,
  RETIRED_IMAGE_MODEL_REPLACEMENTS,
  DEFAULT_OPENAI_IMAGE_MODEL,
  PROMPT_REFINE_MODELS,
  imageModelSchema,
  normalizeImageModelId,
  resolveImageModel,
  resolveImageQuality,
  supportsNativeTransparency,
} from "../src/models.js";
import { KS_X_1001_HANGUL } from "../src/utils/ksx1001-hangul.js";

describe("이미지 모델 레지스트리", () => {
  it("종료된 모델은 선택 목록에 없고, 대체 모델은 모두 선택 목록 안에 있음", () => {
    for (const [retired, replacement] of Object.entries(RETIRED_IMAGE_MODEL_REPLACEMENTS)) {
      expect(OPENAI_IMAGE_MODELS as readonly string[]).not.toContain(retired);
      expect(OPENAI_IMAGE_MODELS as readonly string[]).toContain(replacement);
    }
  });

  it("종료된 gpt-image-1 계열 ID는 대체 모델로 치환", () => {
    expect(normalizeImageModelId("gpt-image-1-mini")).toBe("gpt-image-2.6-flare");
    expect(normalizeImageModelId("gpt-image-1")).toBe("gpt-image-2.6-flare");
    expect(normalizeImageModelId("gpt-image-1.5")).toBe("gpt-image-2.6-flare");
  });

  it("현행 모델·미등록 모델 ID는 그대로 통과", () => {
    expect(normalizeImageModelId("gpt-image-2")).toBe("gpt-image-2");
    expect(normalizeImageModelId("gpt-image-9-future")).toBe("gpt-image-9-future");
  });

  it("resolveImageModel: 미지정이면 기본 모델, 기본 모델은 종료 모델이 아님", () => {
    expect(resolveImageModel(undefined)).toBe(DEFAULT_OPENAI_IMAGE_MODEL);
    expect(resolveImageModel("gpt-image-1-mini")).toBe("gpt-image-2.6-flare");
    expect(Object.keys(RETIRED_IMAGE_MODEL_REPLACEMENTS)).not.toContain(DEFAULT_OPENAI_IMAGE_MODEL);
  });

  it("투명 배경: gpt-image-2 만 미지원", () => {
    expect(supportsNativeTransparency("gpt-image-2")).toBe(false);
    expect(supportsNativeTransparency("gpt-image-2.6-flare")).toBe(true);
    expect(supportsNativeTransparency("gpt-image-2.5-sunburst")).toBe(true);
    expect(supportsNativeTransparency("gpt-image-1")).toBe(true); // → 2.6-flare 로 치환
  });

  it("quality: 2.5/2.6 계열은 미지정·auto 를 medium 으로 고정, gpt-image-2 는 그대로", () => {
    expect(resolveImageQuality("gpt-image-2.6-flare", undefined)).toBe("medium");
    expect(resolveImageQuality("gpt-image-2.6-flare", "auto")).toBe("medium");
    expect(resolveImageQuality("gpt-image-2.5-flare", "low")).toBe("low");
    expect(resolveImageQuality("gpt-image-2.6-sunburst", "high")).toBe("high");
    expect(resolveImageQuality("gpt-image-2", undefined)).toBeUndefined();
    expect(resolveImageQuality("gpt-image-2", "auto")).toBe("auto");
  });

  it("imageModelSchema: 종료 ID는 치환, 알 수 없는 ID는 거부", () => {
    expect(imageModelSchema.parse("gpt-image-1-mini")).toBe("gpt-image-2.6-flare");
    expect(imageModelSchema.parse("gpt-image-2")).toBe("gpt-image-2");
    expect(imageModelSchema.safeParse("dall-e-3").success).toBe(false);
  });

  it("종료된 gpt-5.2-chat-latest 는 리파인 모델 목록에 없음", () => {
    expect(PROMPT_REFINE_MODELS as readonly string[]).not.toContain("gpt-5.2-chat-latest");
  });
});

describe("KS X 1001 완성형 한글", () => {
  const chars = Array.from(KS_X_1001_HANGUL);

  it("중복 없는 2,350자, 모두 한글 음절", () => {
    expect(chars.length).toBe(2350);
    expect(new Set(chars).size).toBe(2350);
    expect(chars.every((c) => c >= "가" && c <= "힣")).toBe(true);
  });

  it("표준 배열: 가 로 시작해 힝 으로 끝남", () => {
    expect(chars[0]).toBe("가");
    expect(chars[chars.length - 1]).toBe("힝");
  });

  it("ㄹ 이후 초성 음절 포함 (v3.4.0 이하 누락분)", () => {
    for (const c of "레벨마법사상점아이템전투체력칼퀘스트타격포션하트획득") {
      expect(KS_X_1001_HANGUL).toContain(c);
    }
  });
});
