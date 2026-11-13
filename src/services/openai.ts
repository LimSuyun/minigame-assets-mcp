import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as FormData from "form-data";
import { OPENAI_API_URL } from "../constants.js";
import {
  DEFAULT_OPENAI_IMAGE_MODEL,
  DEFAULT_RESPONSES_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  resolveImageModel,
  resolveImageQuality,
  supportsNativeTransparency,
  type ImageQuality,
} from "../models.js";
import { requireEnvVar } from "../utils/errors.js";
import { prepareEditInput } from "../utils/image-process.js";
import type { OpenAIImageResponse } from "../types.js";

// ─── 모델 타입 ────────────────────────────────────────────────────────────────
// 모델 ID·기본값은 src/models.ts 에서 관리한다.

/**
 * 이미지 모델 ID. 레지스트리(models.ts)의 ID 외에 임의 문자열도 허용한다
 * — 새 모델이 나오면 코드 수정 없이 model 파라미터로 바로 쓸 수 있게.
 * 종료된 ID(gpt-image-1 계열)는 서비스 계층에서 대체 모델로 자동 치환된다.
 */
export type OpenAIImageModel = string;

export { DEFAULT_OPENAI_IMAGE_MODEL };

type BackgroundOpt = "transparent" | "opaque" | "auto";

/**
 * gpt-image-2 처럼 background: "transparent" 를 거부하는 모델에 대해
 * 요청값을 "auto" 로 자동 강등하여 API 오류를 방지한다.
 * 최종 투명화가 필요한 경우 호출 측에서 마젠타 크로마키 후처리를 사용할 것.
 */
function resolveBackground(
  model: OpenAIImageModel,
  requested: BackgroundOpt | undefined,
): BackgroundOpt {
  const value = requested ?? "transparent";
  if (value === "transparent" && !supportsNativeTransparency(model)) {
    return "auto";
  }
  return value;
}

/** 투명 배경 요청 시 프롬프트 끝에 붙이는 지시문 (generateImageOpenAI 참조). */
export const TRANSPARENT_BG_PROMPT_SUFFIX =
  " — BACKGROUND: fully transparent. Draw ONLY the subject itself as an isolated cut-out. " +
  "No backdrop, no paper or canvas texture behind the subject, no card, frame or border, " +
  "no scenery, no ground, no background patterns or ornaments around the subject.";

// ─── 공통 헤더 ────────────────────────────────────────────────────────────────

function getHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnvVar("OPENAI_API_KEY")}`,
    "Content-Type": "application/json",
  };
}

// ─── 이미지 생성 (/images/generations) ───────────────────────────────────────

export interface OpenAIImageParams {
  prompt: string;
  model?: OpenAIImageModel;
  size?: "1024x1024" | "1792x1024" | "1024x1792" | "1536x1024" | "1024x1536" | "auto";
  quality?: ImageQuality;
  background?: "transparent" | "opaque" | "auto";
}

export async function generateImageOpenAI(
  params: OpenAIImageParams
): Promise<{ base64: string; mimeType: string; revisedPrompt: string }> {
  const model = resolveImageModel(params.model);
  const background = resolveBackground(model, params.background);

  // 네이티브 투명 모델(gpt-image-2.5/2.6)은 background: "transparent" 만으로는 부족하다.
  // 스타일 프롬프트에 "종이 질감·분위기·장식 문양" 같은 표현이 있으면 캔버스 전체에
  // 배경을 그려 넣는다(세시마을 민화 컨셉 실측: 아이콘 3/3 이 불투명 한지 배경으로 반환).
  // 투명 요청 시 피사체만 그리도록 프롬프트에 명시한다.
  const prompt = background === "transparent"
    ? `${params.prompt}${TRANSPARENT_BG_PROMPT_SUFFIX}`
    : params.prompt;

  const body: Record<string, unknown> = {
    model,
    prompt,
    size: params.size || "1024x1024",
    n: 1,
    background,
  };

  const quality = resolveImageQuality(model, params.quality);
  if (quality) body.quality = quality;

  const response = await axios.post<OpenAIImageResponse>(
    `${OPENAI_API_URL}/images/generations`,
    body,
    {
      headers: getHeaders(),
      // gpt-image-2 high-quality는 단건 생성에 2분 이상 걸리므로 넉넉하게
      timeout: 300000,
    }
  );

  const item = response.data.data[0];
  if (!item.b64_json) {
    throw new Error("OpenAI did not return image data");
  }

  return {
    base64: item.b64_json,
    mimeType: "image/png",
    revisedPrompt: item.revised_prompt || params.prompt,
  };
}

// ─── 이미지 편집 (/images/edits) ─────────────────────────────────────────────

export interface OpenAIImageEditParams {
  imagePath?: string;       // 단일 이미지 경로 (하위 호환)
  imagePaths?: string[];    // 복수 이미지 경로 (reference 스타일용)
  prompt: string;
  maskPath?: string;        // 선택적 마스크 PNG (투명 영역을 편집)
  model?: OpenAIImageModel;
  size?: "1024x1024" | "1536x1024" | "1024x1536";
  /** 생성 품질. gpt-image-2.5/2.6 계열은 미지정 시 "medium" 으로 고정 (과금 방지). */
  quality?: ImageQuality;
  /**
   * 배경 타입. 네이티브 투명 지원 모델(gpt-image-2.5/2.6)에만 전송한다.
   * 미지정 시: 첫 입력 이미지에 투명 픽셀이 있으면 "transparent"(투명 유지), 없으면 API 기본값(auto).
   * 크로마키·불투명 결과가 필요하면 "opaque" 를 명시할 것.
   */
  background?: "transparent" | "opaque" | "auto";
}

export async function editImageOpenAI(
  params: OpenAIImageEditParams
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  const paths: string[] = params.imagePaths?.length
    ? params.imagePaths
    : params.imagePath
    ? [params.imagePath]
    : [];

  if (paths.length === 0) {
    throw new Error("editImageOpenAI: imagePath 또는 imagePaths 중 하나는 반드시 필요합니다.");
  }

  const model = resolveImageModel(params.model);
  const quality = resolveImageQuality(model, params.quality);

  // 네이티브 투명 지원 모델은 입력 알파를 무시하고 투명 영역을 검은 배경으로 인식한다.
  // → 투명 입력은 흰 배경에 합성해 보내고, 첫 이미지가 투명이었으면 투명 출력을 요청한다.
  // gpt-image-2 요청은 기존과 동일하게 유지한다.
  const nativeTransparency = supportsNativeTransparency(model);
  const prepared = nativeTransparency
    ? await Promise.all(paths.map((p) => prepareEditInput(p)))
    : [];
  const background: BackgroundOpt | undefined = nativeTransparency
    ? params.background ?? (prepared[0]?.hadTransparency ? "transparent" : undefined)
    : undefined;

  const buildForm = () => {
    const form = new FormData.default();
    form.append("model", model);
    form.append("prompt", params.prompt);

    for (let i = 0; i < paths.length; i++) {
      form.append("image[]", prepared[i]?.flattened ?? fs.createReadStream(paths[i]), {
        filename: `image_${i}.png`,
        contentType: "image/png",
      });
    }

    if (params.maskPath) {
      form.append("mask", fs.createReadStream(params.maskPath), {
        filename: "mask.png",
        contentType: "image/png",
      });
    }
    form.append("n", "1");
    if (params.size) form.append("size", params.size);
    if (quality) form.append("quality", quality);
    if (background) form.append("background", background);
    return form;
  };

  const form = buildForm();
  const response = await axios.post<OpenAIImageResponse>(
    `${OPENAI_API_URL}/images/edits`,
    form,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        ...form.getHeaders(),
      },
      // gpt-image-2 edit도 60초 이상 걸리는 경우가 관측됨 (출시 당일 기준)
      timeout: 300000,
    }
  );

  const item = response.data.data[0];
  if (!item.b64_json) throw new Error("OpenAI image edit returned no data");

  return { base64: item.b64_json, mimeType: "image/png" };
}

// ─── Responses API (image_generation tool) ───────────────────────────────────
//
// 새 방식: POST /v1/responses
//   model  = 텍스트 모델 (gpt-4.1, gpt-4o 등)
//   tools  = [{ type: "image_generation", ... }]
//   action = "auto" | "generate" | "edit"
//
// gpt-image-* 는 내부 이미지 모델. Responses API의 model 파라미터에는 직접 지정 불가하며
// image_generation tool 의 model 필드로 지정한다.

export interface OpenAIResponsesImageParams {
  prompt: string;
  /** Responses API에 전달하는 텍스트 메인 모델 */
  textModel?: string;
  /** 내부 이미지 생성에 사용될 GPT Image 모델 (image_generation tool 의 model 필드로 전달) */
  imageModel?: OpenAIImageModel;
  /**
   * "generate" — 새 이미지 강제 생성
   * "edit"     — 입력 이미지 편집 (inputImagePaths 필요)
   * "auto"     — 모델이 context 보고 판단 (기본값)
   */
  action?: "auto" | "generate" | "edit";
  /** edit / 참조 시 사용할 이미지 파일 경로 */
  inputImagePaths?: string[];
  size?: "1024x1024" | "1536x1024" | "1024x1536";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
}

export async function generateImageWithResponses(
  params: OpenAIResponsesImageParams
): Promise<{ base64: string; mimeType: string; revisedPrompt: string }> {
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  // ── content 배열 구성 ────────────────────────────────────────────────────
  const content: Array<Record<string, unknown>> = [];

  // edit 모드: 입력 이미지를 content 앞에 추가
  if (params.inputImagePaths?.length) {
    for (const imgPath of params.inputImagePaths) {
      const resolved = path.resolve(imgPath);
      const imgData = fs.readFileSync(resolved).toString("base64");
      const ext = path.extname(resolved).toLowerCase();
      const mimeType = ext === ".jpg" || ext === ".jpeg" ? "image/jpeg"
        : ext === ".webp" ? "image/webp" : "image/png";
      content.push({
        type: "input_image",
        image_url: `data:${mimeType};base64,${imgData}`,
      });
    }
  }

  content.push({ type: "input_text", text: params.prompt });

  // ── image_generation tool 설정 ───────────────────────────────────────────
  // 내부 imageModel 이 gpt-image-2 인 경우 transparent 배경은 미지원 → auto 로 강등
  const resolvedImageModel = resolveImageModel(params.imageModel);
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    model: resolvedImageModel,
    background: resolveBackground(resolvedImageModel, params.background),
    quality: params.quality ?? "high",
    size: params.size ?? "1024x1024",
  };

  if (params.action && params.action !== "auto") {
    imageTool.action = params.action;
  }

  // ── 요청 본문 ────────────────────────────────────────────────────────────
  const body: Record<string, unknown> = {
    model: params.textModel ?? DEFAULT_RESPONSES_TEXT_MODEL,
    input: [{ role: "user", content }],
    tools: [imageTool],
    tool_choice: { type: "image_generation" },
  };

  type ResponsesOutputItem = {
    type: string;
    id?: string;
    status?: string;
    result?: string;
    revised_prompt?: string;
  };

  const response = await axios.post<{ output: ResponsesOutputItem[] }>(
    `${OPENAI_API_URL}/responses`,
    body,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 180000,
    }
  );

  const imgOutput = response.data.output?.find(o => o.type === "image_generation_call");
  if (!imgOutput?.result) {
    const outputTypes = response.data.output?.map(o => o.type).join(", ") ?? "none";
    throw new Error(`Responses API: image_generation_call not found. Output types: [${outputTypes}]`);
  }

  return {
    base64: imgOutput.result,
    mimeType: "image/png",
    revisedPrompt: imgOutput.revised_prompt ?? params.prompt,
  };
}

// ─── Vision 텍스트 분석 (Responses API) ─────────────────────────────────────

export interface OpenAIVisionParams {
  imageBase64: string;
  imageMimeType: string;
  prompt: string;
  /** 첫(주) 이미지 앞에 붙일 라벨 텍스트 (예: "Image 1 — frame under inspection") */
  primaryLabel?: string;
  /** 비교 검사용 추가 이미지들. label은 해당 이미지 바로 앞에 텍스트로 삽입된다. */
  additionalImages?: Array<{ base64: string; mimeType: string; label?: string }>;
  textModel?: string;
  maxOutputTokens?: number;
}

/**
 * OpenAI Responses API로 이미지 분석 → 텍스트 반환.
 * 스프라이트 품질 검증, canon consistency, 다중 이미지 비교(기준 이미지 대비) 등에 사용.
 */
export async function analyzeImageOpenAI(
  params: OpenAIVisionParams
): Promise<string> {
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  type ContentPart =
    | { type: "input_image"; image_url: string }
    | { type: "input_text"; text: string };

  const content: ContentPart[] = [];
  if (params.primaryLabel) {
    content.push({ type: "input_text", text: params.primaryLabel });
  }
  content.push({
    type: "input_image",
    image_url: `data:${params.imageMimeType};base64,${params.imageBase64}`,
  });
  for (const extra of params.additionalImages ?? []) {
    if (extra.label) {
      content.push({ type: "input_text", text: extra.label });
    }
    content.push({
      type: "input_image",
      image_url: `data:${extra.mimeType};base64,${extra.base64}`,
    });
  }
  content.push({ type: "input_text", text: params.prompt });

  const body = {
    model: params.textModel ?? DEFAULT_VISION_MODEL,
    input: [{ role: "user", content }],
    max_output_tokens: params.maxOutputTokens ?? 1024,
  };

  type VisionOutputItem = {
    type: string;
    content?: Array<{ type: string; text?: string }>;
  };

  const response = await axios.post<{ output: VisionOutputItem[] }>(
    `${OPENAI_API_URL}/responses`,
    body,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    }
  );

  const msgOutput = response.data.output?.find(o => o.type === "message");
  const textPart = msgOutput?.content?.find(c => c.type === "output_text");
  return textPart?.text ?? "";
}

// ─── 비디오 생성 ─────────────────────────────────────────────────────────────
//
// 이전 버전에 OpenAI Sora 영상 생성이 있었으나 (1) Sora API가
// 2026-09-24에 종료 예정이고 (2) 본 프로젝트에서 영상 자산 워크플로를
// 운영하지 않기로 결정해 도구 + 서비스를 v3.2.0에서 제거했습니다.
// 향후 영상 기능이 필요해지면 다른 provider (Runway / Veo / Kling 등)로
// 새로 통합해야 합니다.

