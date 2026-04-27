export interface GameConcept {
  game_name: string;
  /**
   * 파일명·디렉터리명에 사용되는 ASCII 영문 슬러그.
   * 한글/공백이 들어간 game_name 으로부터 안전한 자산 파일명을 만들기 위해 권장.
   * 미지정 시 도구가 game_name 에서 한글 보존 슬러그로 fallback (옛 동작 호환).
   */
  name_slug?: string;
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
  /** "openai/<model>" 형식 권장 — registry 통계·필터의 기준이 된다 */
  provider: string;
  prompt: string;
  file_path: string;
  /**
   * registry 루트(`.minigame-assets/`) 기준 POSIX 슬래시 상대경로.
   * 프로젝트 이동/머신 동기화에도 안정적인 식별자 — 등록 시 자동 부착된다.
   */
  relative_path?: string;
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

export interface LocalMusicResponse {
  audio_url?: string;
  audio_data?: string;  // base64
  mime_type?: string;
  duration?: number;
  error?: string;
}

// ─── Canon (마스터 레퍼런스 에셋) ────────────────────────────────────────────

export interface CanonEntry {
  id: string;
  name: string;
  /** 에셋 카테고리 */
  type: "character" | "background" | "ui" | "prop" | "effect" | "weapon" | "logo" | "other";
  file_path: string;
  file_name: string;
  description: string;
  art_style?: string;
  color_palette?: string[];   // hex strings
  tags?: string[];
  created_at: string;
  /** 이 Canon에서 파생된 에셋 파일 경로 목록 */
  derived_assets?: string[];
  metadata?: Record<string, unknown>;
}

export interface CanonRegistry {
  version: string;
  entries: CanonEntry[];
  last_updated: string;
}

// ─── 비동기 Job ────────────────────────────────────────────────────────────────

export type JobStatus = "processing" | "done" | "failed";

export interface JobRecord {
  request_id: string;
  /** 호출된 MCP 도구 이름 */
  tool: string;
  status: JobStatus;
  created_at: string;
  updated_at: string;
  params?: Record<string, unknown>;
  /** 생성된 파일 경로 목록 (done 상태) */
  output_paths?: string[];
  /** 파일 외 기타 결과 데이터 */
  result?: unknown;
  error?: string;
  progress?: number;    // 0-100
  message?: string;
  /** 예상 완료까지 남은 초 */
  eta_sec?: number;
}

// ─── GAME_DESIGN.json ─────────────────────────────────────────────────────────

export interface GameDesignSize {
  width: number;
  height: number;
}

export interface GameDesignAssetSpec {
  size: GameDesignSize;
  format?: string;
  transparent?: boolean;
  description?: string;
}

export interface GameDesignCharacter {
  id: string;
  name: string;
  description: string;
  art_style?: string;
}

export interface GameDesignEnemy {
  id: string;
  type: string;
  description: string;
  actions: string[];
}

export interface GameDesignWeapon {
  id: string;
  name: string;
  description: string;
}

export interface GameDesignItem {
  id: string;
  name: string;
  description: string;
}

export interface GameDesignMap {
  id: string;
  theme: string;
  tile_size?: number;
  parallax_theme?: string;
  props?: string[];
}

export interface GameDesignEffect {
  id: string;
  type: string;
  frames: number;
}

export interface GameDesignSounds {
  bgm_style?: string;
  sfx_style?: string;
  bgm_tracks?: string[];
  sfx_list?: string[];
}

export interface GameDesignMarketing {
  generate_logo?: boolean;
  generate_thumbnail?: boolean;
  platforms?: string[];
}

export interface GameDesignScreen {
  id: string;
  name: string;
  description?: string;
  assets?: string[];   // asset_type references
}

export interface GameDesign {
  game_name: string;
  genre?: string;
  /**
   * 게임 메카닉 태그 목록 (선택).
   * 지정하지 않으면 genre + 데이터(characters/enemies/weapons/maps 등)에서 자동 추론됩니다.
   * 명시적으로 제어하려면 여기에 태그를 넣으세요.
   *
   * 사용 가능한 태그 예시:
   *   이동: platformer | runner | topdown | sidescroller | isometric
   *   전투: combat | melee_combat | ranged_combat | magic_combat
   *   진행: character_select | weapon_system | skill_system | level_system | inventory | avatar_customization
   *   내러티브: story | tutorial
   *   퍼즐/특수: puzzle | match3 | tower_defense
   *   점수: scoring | time_attack
   *   기타: multiplayer | gacha | idle | card_game | status_effects
   */
  mechanics?: string[];
  art_style?: string;
  color_palette?: string[];
  description?: string;
  theme?: string;
  target_platform?: string;
  size_profile?: "mobile_portrait" | "mobile_landscape" | "desktop_hd" | "custom";
  canvas_size?: GameDesignSize;
  asset_specs?: Record<string, GameDesignAssetSpec>;
  screens?: GameDesignScreen[];
  characters?: GameDesignCharacter[];
  enemies?: GameDesignEnemy[];
  weapons?: GameDesignWeapon[];
  items?: GameDesignItem[];
  maps?: GameDesignMap[];
  effects?: GameDesignEffect[];
  sounds?: GameDesignSounds;
  marketing?: GameDesignMarketing;
  music_style?: string;
  created_at?: string;
  updated_at?: string;
}

// ─── Asset Size Spec (중첩 구조) ─────────────────────────────────────────────

export interface SizeSpec {
  asset_type: string;
  width: number;
  height: number;
  format: string;
  transparent: boolean;
  notes?: string;
}

/** asset_generate_size_spec이 생성하는 중첩 크기 명세 */
export interface NestedSizeSpecs {
  /** 기본 단위 (tile_size T 기준) */
  base: {
    tile_size: number;
    sprite_frame: { width: number; height: number };
    screen: { width: number; height: number };
    sprite_sheet_max: number;
  };
  /** 캐릭터 관련 크기 */
  characters: {
    base_master: SizeSpec;
    sprite_frame: SizeSpec;
    portrait_full: SizeSpec;
    portrait_bust: SizeSpec;
    portrait_thumb: SizeSpec;
    char_card: SizeSpec;
  };
  /** 배경 관련 크기 */
  backgrounds: {
    full: SizeSpec;
    parallax_far: SizeSpec;
    parallax_mid: SizeSpec;
    parallax_near: SizeSpec;
  };
  /** 타일맵 관련 크기 */
  tiles: {
    tileset: SizeSpec;
    tile_single: SizeSpec;
  };
  /** 이펙트 관련 크기 */
  effects: {
    sm: SizeSpec;
    md: SizeSpec;
    lg: SizeSpec;
    xl: SizeSpec;
  };
  /** UI 관련 크기 */
  ui: {
    icon_sm: SizeSpec;
    icon_md: SizeSpec;
    icon_lg: SizeSpec;
    button_sm: SizeSpec;
    button_md: SizeSpec;
    button_lg: SizeSpec;
    hp_bar_width: number;
    popup_panel: SizeSpec;
  };
  /** 마케팅 관련 크기 */
  marketing: {
    app_icon: SizeSpec;
    thumbnail: SizeSpec;
    store_screenshot_ios: SizeSpec;
    store_screenshot_android: SizeSpec;
    google_play_banner: SizeSpec;
    instagram_post: SizeSpec;
    instagram_story: SizeSpec;
  };
}

export interface AssetSizeSpecFile {
  generated_at: string;
  size_profile: string;
  canvas_size: GameDesignSize;
  specs: NestedSizeSpecs;
}
