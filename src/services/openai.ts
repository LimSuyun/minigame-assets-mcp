import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as FormData from "form-data";
import { OPENAI_API_URL, OPENAI_MODELS_NO_TRANSPARENT_BG } from "../constants.js";
import { requireEnvVar } from "../utils/errors.js";
import type { OpenAIImageResponse } from "../types.js";

// ─── 모델 타입 ────────────────────────────────────────────────────────────────

export type OpenAIImageModel =
  | "gpt-image-2"
  | "gpt-image-1.5"
  | "gpt-image-1"
  | "gpt-image-1-mini";

/** 기본 이미지 생성 모델 (gpt-image-1-mini: 2D 미니게임 에셋에 최적, 단순 스타일, 저비용) */
export const DEFAULT_OPENAI_IMAGE_MODEL: OpenAIImageModel = "gpt-image-1-mini";

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
  if (value === "transparent" && (OPENAI_MODELS_NO_TRANSPARENT_BG as readonly string[]).includes(model)) {
    return "auto";
  }
  return value;
}

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
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
}

export async function generateImageOpenAI(
  params: OpenAIImageParams
): Promise<{ base64: string; mimeType: string; revisedPrompt: string }> {
  const model = params.model ?? DEFAULT_OPENAI_IMAGE_MODEL;

  const body: Record<string, unknown> = {
    model,
    prompt: params.prompt,
    size: params.size || "1024x1024",
    n: 1,
    background: resolveBackground(model, params.background),
  };

  if (params.quality && ["low", "medium", "high", "auto"].includes(params.quality)) {
    body.quality = params.quality;
  }

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

  const model = params.model ?? DEFAULT_OPENAI_IMAGE_MODEL;

  const buildForm = () => {
    const form = new FormData.default();
    form.append("model", model);
    form.append("prompt", params.prompt);

    for (let i = 0; i < paths.length; i++) {
      form.append("image[]", fs.createReadStream(paths[i]), {
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
// gpt-image-2 / gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini 는 내부 이미지 모델.
// Responses API의 model 파라미터에는 직접 지정 불가.

export interface OpenAIResponsesImageParams {
  prompt: string;
  /** Responses API에 전달하는 텍스트 메인 모델 */
  textModel?: "gpt-4.1" | "gpt-4.1-mini" | "gpt-4o" | "gpt-4o-mini";
  /** 내부 이미지 생성에 사용될 GPT Image 모델 (지원 시) */
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
  const resolvedImageModel: OpenAIImageModel = params.imageModel ?? DEFAULT_OPENAI_IMAGE_MODEL;
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    background: resolveBackground(resolvedImageModel, params.background),
    quality: params.quality ?? "high",
    size: params.size ?? "1024x1024",
  };

  if (params.action && params.action !== "auto") {
    imageTool.action = params.action;
  }

  // ── 요청 본문 ────────────────────────────────────────────────────────────
  const body: Record<string, unknown> = {
    model: params.textModel ?? "gpt-4.1",
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
  textModel?: "gpt-4.1" | "gpt-4.1-mini" | "gpt-4o" | "gpt-4o-mini";
  maxOutputTokens?: number;
}

/**
 * OpenAI Responses API로 이미지 분석 → 텍스트 반환.
 * 스프라이트 품질 검증, canon consistency 등에 사용.
 */
export async function analyzeImageOpenAI(
  params: OpenAIVisionParams
): Promise<string> {
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  const body = {
    model: params.textModel ?? "gpt-4.1-mini",
    input: [{
      role: "user",
      content: [
        {
          type: "input_image",
          image_url: `data:${params.imageMimeType};base64,${params.imageBase64}`,
        },
        { type: "input_text", text: params.prompt },
      ],
    }],
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

