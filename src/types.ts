export interface GameConcept {
  game_name: string;
  genre: string;
  art_style: string;
  color_palette: string[];
  description: string;
  theme: string;
  target_platform?: string;
  visual_references?: string[];
  music_style?: string;
  created_at: string;
  updated_at: string;
}

export interface GeneratedAsset {
  id: string;
  type: "image" | "music" | "video";
  asset_type: string;
  provider: string;
  prompt: string;
  file_path: string;
  file_name: string;
  mime_type: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

export interface AssetRegistry {
  assets: GeneratedAsset[];
  last_updated: string;
}

export interface OpenAIImageResponse {
  created: number;
  data: Array<{
    url?: string;
    b64_json?: string;
    revised_prompt?: string;
  }>;
}

export interface GeminiImagePrediction {
  bytesBase64Encoded: string;
  mimeType: string;
}

export interface GeminiImageResponse {
  predictions: GeminiImagePrediction[];
}

export interface GeminiVideoOperation {
  name: string;
  done: boolean;
  response?: {
    generatedSamples: Array<{
      video: {
        uri: string;
        encoding: string;
      };
    }>;
  };
  error?: {
    code: number;
    message: string;
  };
}

export interface LocalMusicResponse {
  audio_url?: string;
  audio_data?: string;  // base64
  mime_type?: string;
  duration?: number;
  error?: string;
}
