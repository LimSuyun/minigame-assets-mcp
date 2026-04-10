import axios from "axios";
import { LOCAL_MUSIC_URL } from "../constants.js";
import type { LocalMusicResponse } from "../types.js";

// Supports generic REST-based music generation servers.
// Compatible with:
//   - AudioCraft / MusicGen (with a Gradio or FastAPI wrapper)
//   - Stable Audio (via API)
//   - Any custom server exposing POST /generate endpoint

export interface LocalMusicParams {
  prompt: string;
  duration?: number;
  temperature?: number;
  top_k?: number;
  top_p?: number;
  cfg_coef?: number;
  model?: string;
}

export async function generateMusicLocal(
  params: LocalMusicParams
): Promise<{ data: Buffer; mimeType: string }> {
  const baseUrl = process.env.LOCAL_MUSIC_SERVER_URL || LOCAL_MUSIC_URL;

  // First try the standard /generate endpoint (AudioCraft-compatible)
  try {
    const response = await axios.post<LocalMusicResponse>(
      `${baseUrl}/generate`,
      {
        prompt: params.prompt,
        duration: params.duration || 30,
        temperature: params.temperature || 1.0,
        top_k: params.top_k || 250,
        top_p: params.top_p || 0.0,
        cfg_coef: params.cfg_coef || 3.0,
        model: params.model || "melody",
      },
      {
        timeout: 180000,
        headers: { "Content-Type": "application/json" },
      }
    );

    if (response.data.error) {
      throw new Error(response.data.error);
    }

    if (response.data.audio_data) {
      return {
        data: Buffer.from(response.data.audio_data, "base64"),
        mimeType: response.data.mime_type || "audio/wav",
      };
    }

    if (response.data.audio_url) {
      const audioResponse = await axios.get<ArrayBuffer>(response.data.audio_url, {
        responseType: "arraybuffer",
        timeout: 60000,
      });
      return {
        data: Buffer.from(audioResponse.data),
        mimeType: "audio/wav",
      };
    }

    throw new Error("Local music server returned no audio data");
  } catch (error) {
    if (axios.isAxiosError(error) && error.code === "ECONNREFUSED") {
      throw new Error(
        `Cannot connect to local music server at ${baseUrl}. ` +
        "Ensure the server is running. Set LOCAL_MUSIC_SERVER_URL in your .env file."
      );
    }
    throw error;
  }
}

// Gradio-compatible endpoint for MusicGen via Hugging Face Spaces or local Gradio
export async function generateMusicGradio(
  params: LocalMusicParams
): Promise<{ data: Buffer; mimeType: string }> {
  const baseUrl = process.env.LOCAL_MUSIC_SERVER_URL || LOCAL_MUSIC_URL;

  const response = await axios.post<{
    data: Array<{ data: string; is_file?: boolean; name?: string }>;
  }>(
    `${baseUrl}/run/predict`,
    {
      data: [
        params.prompt,
        params.model || "melody",
        params.duration || 30,
      ],
    },
    {
      timeout: 180000,
      headers: { "Content-Type": "application/json" },
    }
  );

  const audioData = response.data.data?.[0]?.data;
  if (!audioData) {
    throw new Error("Gradio endpoint returned no audio data");
  }

  // Gradio returns data URLs like "data:audio/wav;base64,..."
  const base64Match = audioData.match(/^data:([^;]+);base64,(.+)$/);
  if (base64Match) {
    return {
      data: Buffer.from(base64Match[2], "base64"),
      mimeType: base64Match[1],
    };
  }

  return {
    data: Buffer.from(audioData, "base64"),
    mimeType: "audio/wav",
  };
}
