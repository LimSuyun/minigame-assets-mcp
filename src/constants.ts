export const OPENAI_API_URL = "https://api.openai.com/v1";
export const GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta";

export const CHARACTER_LIMIT = 25000;

export const DEFAULT_OUTPUT_DIR = process.env.ASSETS_OUTPUT_DIR || "./generated-assets";
export const DEFAULT_CONCEPT_FILE = process.env.CONCEPT_FILE || "./game-concept.json";
export const DEFAULT_CONCEPT_MD_FILE = process.env.CONCEPT_MD_FILE || "./CONCEPT.md";
export const DEFAULT_EXECUTION_PLAN_FILE = "./EXECUTION-PLAN.md";
export const LOCAL_MUSIC_URL = process.env.LOCAL_MUSIC_SERVER_URL || "http://localhost:7860";

// ─── GAME_DESIGN.json (새 3-경로 입력 시스템) ──────────────────────────────────
export const DEFAULT_GAME_DESIGN_FILE = process.env.GAME_DESIGN_FILE || "./GAME_DESIGN.json";
export const DEFAULT_ASSET_SIZE_SPEC_FILE = process.env.ASSET_SIZE_SPEC_FILE || "./asset_size_spec.json";

// ─── Canon (마스터 레퍼런스 에셋) ────────────────────────────────────────────
export const DEFAULT_CANON_DIR = process.env.CANON_DIR || "canon";
export const DEFAULT_CANON_REGISTRY_FILE = "canon_registry.json";

// ─── 비동기 Job 저장소 ────────────────────────────────────────────────────────
export const DEFAULT_JOBS_DIR = ".jobs";

// ─── 크로마키 상수 ────────────────────────────────────────────────────────────
/** 마젠타 크로마키 색상 [R, G, B] — 투명 배경 생성 시 기본 배경색 */
export const CHROMA_KEY_MAGENTA: [number, number, number] = [255, 0, 255];
export const CHROMA_KEY_MAGENTA_HEX = "#FF00FF";
export const DEFAULT_CHROMA_THRESHOLD = 35;

// ─── 이미지 생성 공통 프롬프트 제약 ──────────────────────────────────────────
/**
 * 모든 이미지 생성 프롬프트에 추가하는 텍스트 금지 지시어.
 * AI가 의류·소품·배경 등 어디에도 한국어/중국어/일본어/영어 등
 * 어떤 언어의 텍스트도 렌더링하지 않도록 강제한다.
 */
export const NO_TEXT_IN_IMAGE =
  "CRITICAL — NO TEXT: Do NOT render any readable text, letters, numbers, words, or writing " +
  "of ANY kind anywhere in the image — not on clothing, aprons, shirts, objects, signs, walls, " +
  "props, or any surface. This includes Korean (한글), Chinese, Japanese, English, and every " +
  "other script or alphabet. All surfaces must be completely plain with absolutely NO visible " +
  "writing, labels, symbols, or inscriptions. Blank fabric only — no embroidery, no prints.";

export const NO_SHADOW_IN_IMAGE =
  "CRITICAL — NO SHADOWS: Do NOT render any shadows of any kind — no drop shadow, no cast shadow, " +
  "no ground shadow, no contact shadow, no ambient occlusion shadow. " +
  "The character and all objects must appear completely shadow-free and flat on the background.";

export const CHIBI_STYLE_DEFAULT =
  "chibi art style: large round head (1/3 to 1/2 of total body height), " +
  "short compact body with stubby arms and legs, big expressive eyes, exaggerated cute features. " +
  "VIBRANT HIGH-SATURATION COLORS — bold vivid tones, rich and punchy. " +
  "NOT pastel, NOT watercolor-washed, NOT muted, NOT soft. " +
  "Thick clean black outlines (2-3px). High contrast. Flat cel-shading with minimal highlights.";

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
