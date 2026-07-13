export const OPENAI_API_URL = "https://api.openai.com/v1";

// ─── OpenAI 이미지 모델 ───────────────────────────────────────────────────────
/** 기본 모델: gpt-image-1-mini (2D 미니게임 에셋 최적, 단순 치비 스타일, 저비용) */
export const OPENAI_IMAGE_MODELS = [
  "gpt-image-2",
  "gpt-image-1.5",
  "gpt-image-1",
  "gpt-image-1-mini",
] as const;
export type OpenAIImageModelConst = typeof OPENAI_IMAGE_MODELS[number];

/**
 * background: "transparent" 를 지원하지 않는 모델 목록.
 * 서비스 계층에서 요청이 transparent 일 때 "auto" 로 자동 강등한다.
 * (gpt-image-2 는 투명 배경 출력 미지원 — 2026-04-21 출시 공식 스펙)
 */
export const OPENAI_MODELS_NO_TRANSPARENT_BG: ReadonlyArray<typeof OPENAI_IMAGE_MODELS[number]> = [
  "gpt-image-2",
];

export const CHARACTER_LIMIT = 25000;

export const DEFAULT_OUTPUT_DIR = process.env.ASSETS_OUTPUT_DIR || "./.minigame-assets";
export const DEFAULT_CONCEPT_FILE = process.env.CONCEPT_FILE || "./.minigame-assets/game-concept.json";
export const DEFAULT_CONCEPT_MD_FILE = process.env.CONCEPT_MD_FILE || "./.minigame-assets/CONCEPT.md";
export const DEFAULT_EXECUTION_PLAN_FILE = "./.minigame-assets/EXECUTION-PLAN.md";
export const LOCAL_MUSIC_URL = process.env.LOCAL_MUSIC_SERVER_URL || "http://localhost:7860";

// ─── GAME_DESIGN.json (새 3-경로 입력 시스템) ──────────────────────────────────
export const DEFAULT_GAME_DESIGN_FILE = process.env.GAME_DESIGN_FILE || "./.minigame-assets/GAME_DESIGN.json";
export const DEFAULT_ASSET_SIZE_SPEC_FILE = process.env.ASSET_SIZE_SPEC_FILE || "./.minigame-assets/asset_size_spec.json";

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

/**
 * 게임 에셋 기본 선 스타일 지시어.
 * CONCEPT.md / game-concept.json에서 부드러운(soft/watercolor/painterly 등) 스타일이
 * 명시되지 않은 경우 모든 게임 에셋 프롬프트에 자동 주입된다.
 * 목적: 경계선이 흐릿하거나 번진 이미지 대신 선명하고 깔끔한 게임 에셋을 기본으로 보장.
 */
export const CLEAN_LINE_STYLE_DEFAULT =
  "clean crisp outlines, sharp defined edges, flat cel-shading or clean vector-like illustration style, " +
  "clear boundaries between all elements, no blurry or soft edges, no painterly smearing";

/**
 * Visual Concept 단계 — 키 비주얼 후보 생성용 구도/무드 변형 프리셋.
 * "구조는 코드가 결정, 표현은 AI": 후보 간 차이를 결정론적으로 만들어
 * 자동 선별(asset_select_best)이 의미 있는 비교를 하도록 한다.
 */
export const KEY_VISUAL_VARIATION_PRESETS = [
  {
    id: "hero_shot",
    prompt: "heroic medium shot of the main character in the game's signature environment, " +
      "character occupies the center of the frame, dynamic three-quarter angle, clear silhouette",
  },
  {
    id: "scene_wide",
    prompt: "wide establishing shot of the game's world, main character visible but small in frame, " +
      "environment storytelling, strong depth layering with distinct foreground, midground, and background",
  },
  {
    id: "character_closeup",
    prompt: "close-up shot of the main character with expressive pose and signature props, " +
      "simple clean background that showcases the color palette and art style",
  },
] as const;

/**
 * 컨셉아트 생성 시 불필요한 효과 억제 지시.
 * "필요한 요소를 제외한 효과를 억제할수록 완성도가 올라간다" — 컨셉아트 R&D 검증 결과.
 */
export const CONCEPT_SUPPRESS_EFFECTS =
  "No text or watermarks, no UI elements, no lens flare, no excessive glow or particle effects, " +
  "no decorative borders or frames. Keep the image focused on the essential subject and environment only.";

// Supported image sizes for OpenAI
export const OPENAI_IMAGE_SIZES = ["1024x1024", "1792x1024", "1024x1792"] as const;

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

