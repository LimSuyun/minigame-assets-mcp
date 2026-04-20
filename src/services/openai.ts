import axios from "axios";
import * as fs from "fs";
import * as FormData from "form-data";
import { OPENAI_API_URL } from "../constants.js";
import { requireEnvVar } from "../utils/errors.js";
import type { OpenAIImageResponse } from "../types.js";

function getHeaders(): Record<string, string> {
  return {
    Authorization: `Bearer ${requireEnvVar("OPENAI_API_KEY")}`,
    "Content-Type": "application/json",
  };
}

export interface OpenAIImageParams {
  prompt: string;
  model?: "gpt-image-1";
  size?: "1024x1024" | "1792x1024" | "1024x1792" | "1536x1024" | "1024x1536" | "auto";
  quality?: "low" | "medium" | "high" | "auto";
  background?: "transparent" | "opaque" | "auto";
}

export async function generateImageOpenAI(
  params: OpenAIImageParams
): Promise<{ base64: string; mimeType: string; revisedPrompt: string }> {
  const model = params.model || "gpt-image-1";

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

// ─── Image Editing (gpt-image-1) ─────────────────────────────────────────────

export interface OpenAIImageEditParams {
  imagePath?: string;       // 단일 이미지 경로 (하위 호환)
  imagePaths?: string[];    // 복수 이미지 경로 (reference 스타일용)
  prompt: string;
  maskPath?: string;        // 선택적 마스크 PNG (투명 영역을 편집)
  model?: "gpt-image-1";
  size?: "1024x1024" | "1536x1024" | "1024x1536";
}

export async function editImageOpenAI(
  params: OpenAIImageEditParams
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = requireEnvVar("OPENAI_API_KEY");

  // imagePaths(복수) 또는 imagePath(단수) 통합 처리
  const paths: string[] = params.imagePaths?.length
    ? params.imagePaths
    : params.imagePath
    ? [params.imagePath]
    : [];

  if (paths.length === 0) {
    throw new Error("editImageOpenAI: imagePath 또는 imagePaths 중 하나는 반드시 필요합니다.");
  }

  const model = params.model || "gpt-image-1";

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

export interface OpenAIVideoParams {
  prompt: string;
  model?: "sora-1.0-turbo";
  duration?: 5 | 10 | 15 | 20;
  resolution?: "480p" | "720p" | "1080p";
  aspect_ratio?: "16:9" | "9:16" | "1:1";
}

// OpenAI Sora video generation (requires API access)
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
