export const OPENAI_API_URL = "https://api.openai.com/v1";
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

export const CHARACTER_LIMIT = 25000;

export const DEFAULT_OUTPUT_DIR = process.env.ASSETS_OUTPUT_DIR || "./generated-assets";
export const DEFAULT_CONCEPT_FILE = process.env.CONCEPT_FILE || "./game-concept.json";
export const DEFAULT_CONCEPT_MD_FILE = process.env.CONCEPT_MD_FILE || "./CONCEPT.md";
export const DEFAULT_EXECUTION_PLAN_FILE = "./EXECUTION-PLAN.md";
export const LOCAL_MUSIC_URL = process.env.LOCAL_MUSIC_SERVER_URL || "http://localhost:7860";

// Supported image sizes for OpenAI
export const OPENAI_IMAGE_SIZES = ["1024x1024", "1792x1024", "1024x1792"] as const;

// Supported aspect ratios for Gemini Imagen
export const GEMINI_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;

// Asset type categories
export const ASSET_TYPES = [
  "character",
  "sprite",
  "background",
  "ui_element",
  "icon",
  "tile",
  "effect",
  "logo",
  "concept",
  "thumbnail",
  "other",
] as const;

// 여백(padding)을 추가하면 안 되는 에셋 타입
// (배경/로고/컨셉/썸네일은 캔버스 전체를 채워야 함)
export const NO_PADDING_TYPES: ReadonlyArray<string> = [
  "background",
  "logo",
  "concept",
  "thumbnail",
];

export const MUSIC_TYPES = [
  "background_music",
  "sound_effect",
  "jingle",
  "ambient",
  "battle_theme",
  "menu_theme",
] as const;

export const VIDEO_TYPES = [
  "cutscene",
  "trailer",
  "gameplay_loop",
  "intro",
  "outro",
] as const;
