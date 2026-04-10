import axios from "axios";
import { GEMINI_API_URL } from "../constants.js";
import { requireEnvVar } from "../utils/errors.js";
import type { GeminiImageResponse, GeminiVideoOperation } from "../types.js";

function getApiKey(): string {
  return requireEnvVar("GEMINI_API_KEY");
}

// ─── Image Generation (Imagen 4) ──────────────────────────────────────────────

export interface GeminiImageParams {
  prompt: string;
  sampleCount?: number;
  aspectRatio?: "1:1" | "3:4" | "4:3" | "9:16" | "16:9";
  negativePrompt?: string;
  safetyFilterLevel?: "block_low_and_above" | "block_medium_and_above" | "block_only_high";
  model?: "imagen-4.0-generate-001" | "imagen-4.0-fast-generate-001" | "imagen-4.0-ultra-generate-001";
}

export async function generateImageGemini(
  params: GeminiImageParams
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = getApiKey();
  const model = params.model || "imagen-4.0-generate-001";
  const url = `${GEMINI_API_URL}/models/${model}:predict?key=${apiKey}`;

  const response = await axios.post<GeminiImageResponse>(
    url,
    {
      instances: [
        {
          prompt: params.prompt,
          ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
        },
      ],
      parameters: {
        sampleCount: params.sampleCount || 1,
        aspectRatio: params.aspectRatio || "1:1",
        ...(params.safetyFilterLevel
          ? { safetySetting: params.safetyFilterLevel }
          : {}),
      },
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 120000,
    }
  );

  const prediction = response.data.predictions?.[0];
  if (!prediction?.bytesBase64Encoded) {
    throw new Error("Gemini Imagen did not return image data");
  }

  return {
    base64: prediction.bytesBase64Encoded,
    mimeType: prediction.mimeType || "image/png",
  };
}

// ─── Video Generation (Veo 3) ─────────────────────────────────────────────────

export interface GeminiVideoParams {
  prompt: string;
  durationSeconds?: 5 | 6 | 7 | 8;
  aspectRatio?: "16:9" | "9:16";
  negativePrompt?: string;
  model?: "veo-3.0-generate-001" | "veo-3.0-fast-generate-001" | "veo-2.0-generate-001";
}

async function pollVideoOperation(
  operationName: string,
  apiKey: string,
  maxWaitMs: number = 300000
): Promise<GeminiVideoOperation> {
  const pollUrl = `https://generativelanguage.googleapis.com/v1beta/${operationName}?key=${apiKey}`;
  const startTime = Date.now();
  const pollIntervalMs = 10000;

  while (Date.now() - startTime < maxWaitMs) {
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));

    const response = await axios.get<GeminiVideoOperation>(pollUrl, {
      headers: { "Content-Type": "application/json" },
      timeout: 30000,
    });

    if (response.data.done) {
      return response.data;
    }
  }

  throw new Error("Video generation timed out after 5 minutes");
}

export async function generateVideoGemini(
  params: GeminiVideoParams
): Promise<{ videoUri: string }> {
  const apiKey = getApiKey();
  const model = params.model || "veo-3.0-generate-001";
  const url = `${GEMINI_API_URL}/models/${model}:predictLongRunning?key=${apiKey}`;

  const response = await axios.post<{ name: string }>(
    url,
    {
      instances: [
        {
          prompt: params.prompt,
          ...(params.negativePrompt ? { negativePrompt: params.negativePrompt } : {}),
        },
      ],
      parameters: {
        durationSeconds: params.durationSeconds || 5,
        aspectRatio: params.aspectRatio || "16:9",
        sampleCount: 1,
      },
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 60000,
    }
  );

  const operationName = response.data.name;
  const operation = await pollVideoOperation(operationName, apiKey);

  if (operation.error) {
    throw new Error(`Gemini video generation failed: ${operation.error.message}`);
  }

  const videoUri = operation.response?.generatedSamples?.[0]?.video?.uri;
  if (!videoUri) {
    throw new Error("Gemini Veo did not return a video URI");
  }

  return { videoUri };
}

// ─── Image Editing (Gemini 2.5 Flash Image) ───────────────────────────────────

export interface GeminiImageEditParams {
  imageBase64: string;
  imageMimeType: string;
  editPrompt: string;
  model?: string;
  // 다중 이미지 참조 (캐릭터 스타일 학습 등)
  referenceImages?: Array<{ base64: string; mimeType: string }>;
}

export async function editImageGemini(
  params: GeminiImageEditParams
): Promise<{ base64: string; mimeType: string }> {
  const apiKey = getApiKey();
  // gemini-2.5-flash-image: 이미지 입출력 지원 모델
  const model = params.model || "gemini-2.5-flash-image";
  const url = `${GEMINI_API_URL}/models/${model}:generateContent?key=${apiKey}`;

  // 다중 참조 이미지가 있으면 모두 parts에 포함
  const imageParts = params.referenceImages?.length
    ? params.referenceImages.map((img) => ({
        inlineData: { mimeType: img.mimeType, data: img.base64 },
      }))
    : [{ inlineData: { mimeType: params.imageMimeType, data: params.imageBase64 } }];

  const response = await axios.post<{
    candidates: Array<{
      content: {
        parts: Array<{
          inlineData?: { data: string; mimeType: string };
          text?: string;
        }>;
      };
    }>;
  }>(
    url,
    {
      contents: [
        {
          role: "user",
          parts: [
            ...imageParts,
            { text: params.editPrompt },
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["IMAGE", "TEXT"],
      },
    },
    {
      headers: { "Content-Type": "application/json" },
      timeout: 120000,
    }
  );

  const parts = response.data.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p.inlineData?.data);

  if (!imagePart?.inlineData) {
    throw new Error(
      "Gemini image edit returned no image data. " +
      "Ensure your API key has access to gemini-2.5-flash-image."
    );
  }

  return {
    base64: imagePart.inlineData.data,
    mimeType: imagePart.inlineData.mimeType || "image/png",
  };
}

