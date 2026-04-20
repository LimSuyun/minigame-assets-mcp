import axios from "axios";
import * as fs from "fs";
import * as path from "path";
import * as FormData from "form-data";
import { OPENAI_API_URL } from "../constants.js";
import { requireEnvVar } from "../utils/errors.js";
import type { OpenAIImageResponse } from "../types.js";

// ─── 모델 타입 ────────────────────────────────────────────────────────────────

export type OpenAIImageModel = "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini";

/** 기본 이미지 생성 모델 (gpt-image-1.5: 4× 속도, 20% 저렴, 고품질) */
export const DEFAULT_OPENAI_IMAGE_MODEL: OpenAIImageModel = "gpt-image-1.5";

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
    background: params.background ?? "transparent",
  };

  if (params.quality && ["low", "medium", "high", "auto"].includes(params.quality)) {
    body.quality = params.quality;
  }

  const response = await axios.post<OpenAIImageResponse>(
    `${OPENAI_API_URL}/images/generations`,
    body,
    {
      headers: getHeaders(),
      timeout: 120000,
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
      timeout: 120000,
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
// gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini 는 내부 이미지 모델.
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
  const imageTool: Record<string, unknown> = {
    type: "image_generation",
    background: params.background ?? "transparent",
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

// ─── 비디오 생성 ─────────────────────────────────────────────────────────────

export interface OpenAIVideoParams {
  prompt: string;
  model?: "sora-1.0-turbo";
  duration?: 5 | 10 | 15 | 20;
  resolution?: "480p" | "720p" | "1080p";
  aspect_ratio?: "16:9" | "9:16" | "1:1";
}

export async function generateVideoOpenAI(
  params: OpenAIVideoParams
): Promise<{ videoUrl: string }> {
  const response = await axios.post<{ id: string; status: string; url?: string }>(
    `${OPENAI_API_URL}/video/generations`,
    {
      model: params.model || "sora-1.0-turbo",
      prompt: params.prompt,
      duration: params.duration || 5,
      resolution: params.resolution || "720p",
      aspect_ratio: params.aspect_ratio || "16:9",
    },
    {
      headers: getHeaders(),
      timeout: 300000,
    }
  );

  if (!response.data.url) {
    throw new Error("OpenAI video generation did not return a URL. The video may still be processing.");
  }

  return { videoUrl: response.data.url };
}
