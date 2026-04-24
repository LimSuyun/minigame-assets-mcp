/**
 * asset-requirements.ts
 *
 * 에셋 필요도 분석 엔진.
 * GAME_DESIGN.json의 genre + mechanics + 실제 데이터(characters/enemies/weapons/maps 등)를
 * 분석하여 각 에셋 카테고리의 필요도를 판단합니다.
 *
 * 필요도 레벨:
 *   required     — 이 게임 타입에 반드시 필요
 *   recommended  — 없어도 게임이 돌아가지만 강력 권장
 *   optional     — 있으면 좋지만 없어도 무방
 *   not_needed   — 이 게임 타입에 불필요 (생성하지 않는 것을 권장)
 */

import type { GameDesign } from "../types.js";

// ─── 메카닉 태그 ──────────────────────────────────────────────────────────────

/**
 * 게임 메카닉 태그.
 * GAME_DESIGN.json의 `mechanics` 배열에 이 값들을 넣으면 명시적으로 지정할 수 있습니다.
 * 지정하지 않으면 genre + 데이터에서 자동 추론됩니다.
 */
export const GAME_MECHANICS = [
  // 이동 방식
  "platformer",           // 횡스크롤 플랫포머: 타일맵 + 패럴랙스 + 점프
  "runner",               // 자동 달리기: 패럴랙스, 장애물 스프라이트
  "topdown",              // 탑다운 이동: 타일맵
  "sidescroller",         // 횡스크롤 일반 (플랫포머 아님)
  "isometric",            // 아이소메트릭

  // 전투 방식
  "combat",               // 근접/원거리 전투: attack/hurt/die 스프라이트
  "melee_combat",         // 근접 전투
  "ranged_combat",        // 원거리 전투 (총, 활)
  "magic_combat",         // 마법 전투

  // 진행 시스템
  "character_select",     // 캐릭터 선택 화면: 초상화, 캐릭터 카드
  "weapon_system",        // 무기 장착/변경: 무기 아이콘
  "skill_system",         // 스킬 슬롯: 스킬 아이콘
  "level_system",         // EXP/레벨업: 레벨업 이펙트
  "inventory",            // 아이템 인벤토리: 아이템 아이콘
  "avatar_customization", // 아바타 커스터마이징: 아바타 파츠

  // 내러티브
  "story",                // 스토리/대화: NPC 가이드, 대화창
  "tutorial",             // 튜토리얼: 튜토리얼 오버레이

  // 퍼즐/특수
  "puzzle",               // 퍼즐 장르
  "match3",               // 매치3 퍼즐
  "physics_puzzle",       // 물리 기반 퍼즐
  "tower_defense",        // 타워 디펜스

  // 점수/아케이드
  "scoring",              // 점수 시스템: 점수 패널, 플로팅 텍스트
  "time_attack",          // 타이머 기반: 타이머 HUD

  // 기타
  "multiplayer",          // 멀티플레이어: 리더보드 UI
  "gacha",                // 가챠: 희귀도 카드 프레임
  "idle",                 // 방치형: 자원 아이콘, 건물 스프라이트
  "card_game",            // 카드 게임: 카드 프레임, 덱 UI
  "status_effects",       // 상태이상 시스템: 상태이상 아이콘
] as const;

export type GameMechanic = typeof GAME_MECHANICS[number];

// ─── 에셋 카테고리 정의 ───────────────────────────────────────────────────────

export type RequirementLevel = "required" | "recommended" | "optional" | "not_needed";

export interface AssetCategory {
  /** 카테고리 고유 ID */
  id: string;
  /** 표시 이름 */
  name: string;
  /** 설명 */
  description: string;
  /** 모든 게임에 필요 여부 */
  always_required: boolean;
  /** 이 메카닉 중 하나라도 있으면 → required */
  required_for_mechanics: string[];
  /** 이 메카닉 중 하나라도 있으면 → recommended */
  recommended_for_mechanics: string[];
  /** 이 메카닉이 하나도 없으면 → not_needed */
  only_for_mechanics: string[];  // 비어있으면 모든 게임에 해당
  /** 관련 MCP 도구들 */
  tools: string[];
  /** 관련 Stage (0~6) */
  stage: number;
}

// ─── 에셋 필요도 매트릭스 ────────────────────────────────────────────────────

export const ASSET_REQUIREMENT_MATRIX: AssetCategory[] = [

  // ─── Stage 0: Canon & Foundation ─────────────────────────────────────────
  {
    id: "app_logo",
    name: "앱 로고 / 아이콘",
    description: "앱스토어 아이콘 및 인게임 로고",
    always_required: true,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_app_logo"],
    stage: 0,
  },
  {
    id: "style_reference_sheet",
    name: "스타일 레퍼런스 시트",
    description: "전체 에셋 아트 바이블 — Canon 확립 후 생성",
    always_required: true,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_style_reference_sheet"],
    stage: 0,
  },

  // ─── Stage 1: Characters ──────────────────────────────────────────────────
  {
    id: "character_base",
    name: "캐릭터 베이스 스프라이트",
    description: "플레이어/NPC 정면 기준 이미지",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],  // characters 배열이 있으면 자동 필요 (데이터 기반)
    tools: ["asset_generate_character_base"],
    stage: 1,
  },
  {
    id: "sprite_idle",
    name: "아이들 스프라이트",
    description: "캐릭터 대기 동작",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],  // 캐릭터 있으면 항상 필요
    tools: ["asset_generate_action_sprite", "asset_generate_sprite_sheet"],
    stage: 1,
  },
  {
    id: "sprite_movement",
    name: "이동 스프라이트 (walk/run/jump)",
    description: "걷기/달리기/점프 동작",
    always_required: false,
    required_for_mechanics: ["platformer", "runner", "topdown", "sidescroller"],
    recommended_for_mechanics: ["combat", "rpg"],
    only_for_mechanics: ["platformer", "runner", "topdown", "sidescroller", "combat"],
    tools: ["asset_generate_action_sprite", "asset_generate_sprite_sheet"],
    stage: 1,
  },
  {
    id: "sprite_combat",
    name: "전투 스프라이트 (attack/hurt/die)",
    description: "공격·피격·사망 동작",
    always_required: false,
    required_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat"],
    recommended_for_mechanics: [],
    only_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat", "tower_defense"],
    tools: ["asset_generate_action_sprite", "asset_generate_sprite_sheet"],
    stage: 1,
  },
  {
    id: "character_portrait",
    name: "캐릭터 초상화 (full/bust/thumb)",
    description: "캐릭터 선택 화면 또는 프로필용 고화질 초상화",
    always_required: false,
    required_for_mechanics: ["character_select", "rpg"],
    recommended_for_mechanics: ["story", "card_game", "gacha"],
    only_for_mechanics: ["character_select", "rpg", "story", "card_game", "gacha"],
    tools: ["asset_generate_character_portrait"],
    stage: 1,
  },
  {
    id: "character_card",
    name: "캐릭터 카드 UI",
    description: "캐릭터 선택/가챠용 카드 레이아웃",
    always_required: false,
    required_for_mechanics: ["character_select", "gacha", "card_game"],
    recommended_for_mechanics: [],
    only_for_mechanics: ["character_select", "gacha", "card_game"],
    tools: ["asset_generate_character_card"],
    stage: 1,
  },
  {
    id: "avatar_parts",
    name: "아바타 커스터마이징 파츠",
    description: "헤어·의상·액세서리 등 합성용 파츠",
    always_required: false,
    required_for_mechanics: ["avatar_customization"],
    recommended_for_mechanics: [],
    only_for_mechanics: ["avatar_customization"],
    tools: ["asset_generate_avatar_parts"],
    stage: 1,
  },

  // ─── Stage 2: UI ──────────────────────────────────────────────────────────
  {
    id: "ui_basic",
    name: "기본 UI (버튼·패널·팝업)",
    description: "플레이 버튼, 설정 패널, 알림 팝업 등 공통 UI",
    always_required: true,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_ui_structural", "asset_generate_button_set", "asset_generate_popup_set"],
    stage: 2,
  },
  {
    id: "hud_combat",
    name: "전투 HUD (HP바·MP바·스킬 슬롯)",
    description: "체력바, 마나바, 스킬 슬롯 등 인게임 전투 UI",
    always_required: false,
    required_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat"],
    recommended_for_mechanics: ["rpg"],
    only_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat", "rpg"],
    tools: ["asset_generate_hud_set"],
    stage: 2,
  },
  {
    id: "hud_score",
    name: "점수 HUD (점수판·콤보·타이머)",
    description: "점수 표시, 콤보 카운터, 타이머",
    always_required: false,
    required_for_mechanics: ["scoring", "time_attack"],
    recommended_for_mechanics: ["puzzle", "runner", "platformer"],
    only_for_mechanics: ["scoring", "time_attack", "puzzle", "runner", "platformer", "match3", "arcade"],
    tools: ["asset_generate_hud_set"],
    stage: 2,
  },
  {
    id: "ui_icon_set",
    name: "아이콘 세트 (스킬·통화·설정 등)",
    description: "게임 내 각종 아이콘",
    always_required: false,
    required_for_mechanics: ["skill_system", "inventory"],
    recommended_for_mechanics: ["rpg", "combat", "idle"],
    only_for_mechanics: ["skill_system", "inventory", "rpg", "combat", "idle", "gacha"],
    tools: ["asset_generate_icon_set"],
    stage: 2,
  },
  {
    id: "weapon_icons",
    name: "무기 아이콘",
    description: "장착/선택 가능한 무기 아이콘",
    always_required: false,
    required_for_mechanics: ["weapon_system"],
    recommended_for_mechanics: ["combat"],
    only_for_mechanics: ["weapon_system", "combat", "rpg"],
    tools: ["asset_generate_weapons", "asset_generate_icon_set"],
    stage: 2,
  },
  {
    id: "item_icons",
    name: "아이템 아이콘",
    description: "인벤토리/수집 아이템 아이콘",
    always_required: false,
    required_for_mechanics: ["inventory"],
    recommended_for_mechanics: ["rpg", "platformer"],
    only_for_mechanics: ["inventory", "rpg", "platformer", "idle"],
    tools: ["asset_generate_icon_set", "asset_generate_image"],
    stage: 2,
  },
  {
    id: "status_effect_icons",
    name: "상태이상 아이콘",
    description: "독·화상·빙결·기절 등 상태이상 아이콘",
    always_required: false,
    required_for_mechanics: ["status_effects"],
    recommended_for_mechanics: ["combat", "rpg"],
    only_for_mechanics: ["status_effects", "combat", "rpg"],
    tools: ["asset_generate_status_effect_icons"],
    stage: 2,
  },

  // ─── Stage 3: Backgrounds ─────────────────────────────────────────────────
  {
    id: "screen_backgrounds",
    name: "화면 배경 (메뉴·결과 화면)",
    description: "메인 메뉴, 게임 오버, 스테이지 결과 배경",
    always_required: true,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_screen_background"],
    stage: 3,
  },
  {
    id: "parallax_bg",
    name: "패럴랙스 배경 레이어 (far/mid/near)",
    description: "시차 스크롤 배경 — 횡스크롤/러너 장르 필수",
    always_required: false,
    required_for_mechanics: ["platformer", "runner", "sidescroller"],
    recommended_for_mechanics: ["shooter"],
    only_for_mechanics: ["platformer", "runner", "sidescroller", "shooter"],
    tools: ["asset_generate_parallax_set"],
    stage: 3,
  },
  {
    id: "tileset",
    name: "타일셋 (맵 타일 아틀라스)",
    description: "맵 구성용 타일 스프라이트 시트",
    always_required: false,
    required_for_mechanics: ["platformer", "topdown", "tower_defense", "isometric"],
    recommended_for_mechanics: ["puzzle", "match3"],
    only_for_mechanics: ["platformer", "topdown", "tower_defense", "isometric", "puzzle", "match3"],
    tools: ["asset_generate_tileset"],
    stage: 3,
  },
  {
    id: "props",
    name: "맵 소품 (나무·상자·장식 등)",
    description: "맵에 배치하는 장식·소품 오브젝트",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: ["platformer", "topdown", "tower_defense"],
    only_for_mechanics: ["platformer", "topdown", "tower_defense", "isometric", "sidescroller"],
    tools: ["asset_generate_props_set"],
    stage: 3,
  },
  {
    id: "interactive_objects",
    name: "인터랙티브 오브젝트 (상태별 스프라이트)",
    description: "상자(열림/닫힘), 문(열림/닫힘), 레버 등",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: ["platformer", "topdown", "puzzle"],
    only_for_mechanics: ["platformer", "topdown", "puzzle", "isometric", "sidescroller"],
    tools: ["asset_generate_interactive_objects"],
    stage: 3,
  },

  // ─── Stage 4: Effects ─────────────────────────────────────────────────────
  {
    id: "effects_combat",
    name: "전투 이펙트 (slash/hit/explosion)",
    description: "공격·타격·폭발 애니메이션 이펙트 시트",
    always_required: false,
    required_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat"],
    recommended_for_mechanics: [],
    only_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat", "tower_defense"],
    tools: ["asset_generate_effect_sheet"],
    stage: 4,
  },
  {
    id: "effects_environment",
    name: "환경 이펙트 (불·먼지·파티클)",
    description: "환경·분위기 애니메이션 이펙트",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: ["platformer", "rpg", "runner"],
    only_for_mechanics: ["platformer", "topdown", "rpg", "runner", "tower_defense"],
    tools: ["asset_generate_effect_sheet"],
    stage: 4,
  },
  {
    id: "effects_ui",
    name: "UI 이펙트 (레벨업·코인·별 획득)",
    description: "보상·진행 관련 UI 피드백 이펙트",
    always_required: false,
    required_for_mechanics: ["level_system"],
    recommended_for_mechanics: ["scoring", "gacha", "idle"],
    only_for_mechanics: ["level_system", "scoring", "gacha", "idle", "puzzle"],
    tools: ["asset_generate_effect_sheet"],
    stage: 4,
  },
  {
    id: "floating_text",
    name: "플로팅 텍스트 (데미지·힐·MISS 등)",
    description: "전투·점수 숫자 팝업 텍스트",
    always_required: false,
    required_for_mechanics: ["combat"],
    recommended_for_mechanics: ["scoring", "rpg"],
    only_for_mechanics: ["combat", "scoring", "rpg", "puzzle"],
    tools: ["asset_generate_floating_text"],
    stage: 4,
  },

  // ─── Stage 5: Audio ───────────────────────────────────────────────────────
  {
    id: "bgm_basic",
    name: "기본 BGM (메뉴·게임플레이·결과)",
    description: "메인 메뉴, 인게임, 결과 화면 배경음악",
    always_required: true,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_bgm", "asset_generate_music_local"],
    stage: 5,
  },
  {
    id: "sfx_ui",
    name: "UI 효과음 (버튼·팝업·알림)",
    description: "버튼 클릭, 팝업 열림/닫힘, 성공/실패 알림",
    always_required: true,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_sfx"],
    stage: 5,
  },
  {
    id: "sfx_combat",
    name: "전투 효과음 (공격·피격·폭발)",
    description: "공격 효과음, 타격음, 폭발음",
    always_required: false,
    required_for_mechanics: ["combat", "melee_combat", "ranged_combat"],
    recommended_for_mechanics: ["magic_combat"],
    only_for_mechanics: ["combat", "melee_combat", "ranged_combat", "magic_combat", "tower_defense"],
    tools: ["asset_generate_sfx"],
    stage: 5,
  },
  {
    id: "sfx_environment",
    name: "환경 효과음 (발소리·코인·아이템)",
    description: "발걸음, 코인 획득, 아이템 픽업, 문 열림",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: ["platformer", "topdown", "rpg"],
    only_for_mechanics: ["platformer", "topdown", "rpg", "runner", "puzzle"],
    tools: ["asset_generate_sfx"],
    stage: 5,
  },

  // ─── Stage 6: Marketing ───────────────────────────────────────────────────
  {
    id: "marketing_store",
    name: "스토어 에셋 (스크린샷·배너·소셜)",
    description: "앱스토어 스크린샷, 피처드 배너, 소셜 미디어 홍보 이미지",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],  // 퍼블리싱 시 필요 (always recommended)
    tools: ["asset_generate_store_screenshots", "asset_generate_store_banner", "asset_generate_social_media_pack"],
    stage: 6,
  },
  {
    id: "marketing_thumbnail",
    name: "게임 썸네일 (1280×720)",
    description: "게임 소개/공유용 썸네일",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: [],
    only_for_mechanics: [],
    tools: ["asset_generate_thumbnail"],
    stage: 6,
  },

  // ─── 특수 (온보딩/폰트) ───────────────────────────────────────────────────
  {
    id: "tutorial_overlays",
    name: "튜토리얼 오버레이",
    description: "스포트라이트, 화살표, 제스처 가이드 등 튜토리얼 UI",
    always_required: false,
    required_for_mechanics: ["tutorial"],
    recommended_for_mechanics: [],
    only_for_mechanics: ["tutorial"],
    tools: ["asset_generate_tutorial_overlays"],
    stage: 2,
  },
  {
    id: "guide_npc",
    name: "가이드 NPC 캐릭터",
    description: "튜토리얼/스토리 안내 NPC 표정 세트",
    always_required: false,
    required_for_mechanics: ["tutorial"],
    recommended_for_mechanics: ["story"],
    only_for_mechanics: ["tutorial", "story"],
    tools: ["asset_generate_guide_npc"],
    stage: 1,
  },
  {
    id: "bitmap_font",
    name: "비트맵 폰트",
    description: "커스텀 아케이드/게임 스타일 비트맵 폰트",
    always_required: false,
    required_for_mechanics: [],
    recommended_for_mechanics: ["scoring", "puzzle", "idle"],
    only_for_mechanics: ["scoring", "puzzle", "idle", "card_game", "runner"],
    tools: ["asset_convert_font_to_bitmap"],
    stage: 2,
  },
];

// ─── 메카닉 추론 엔진 ─────────────────────────────────────────────────────────

/**
 * GAME_DESIGN.json 데이터에서 게임 메카닉을 자동 추론합니다.
 * `mechanics` 필드가 명시적으로 설정된 경우 그것을 우선합니다.
 * 추론 결과와 명시 값의 합집합이 최종 active mechanics입니다.
 */
export function inferMechanics(design: GameDesign): {
  declared: string[];
  inferred: string[];
  active: string[];
  inference_reasons: Array<{ mechanic: string; reason: string }>;
} {
  const declared = (design as GameDesign & { mechanics?: string[] }).mechanics ?? [];
  const inferred: string[] = [];
  const inference_reasons: Array<{ mechanic: string; reason: string }> = [];

  function add(mechanic: string, reason: string) {
    if (!inferred.includes(mechanic)) {
      inferred.push(mechanic);
      inference_reasons.push({ mechanic, reason });
    }
  }

  // ── 장르 기반 추론 ────────────────────────────────────────────────────────
  const genre = (design.genre || "").toLowerCase();

  if (genre === "platformer" || genre.includes("platform")) {
    add("platformer", `genre="${design.genre}"`);
    add("combat", `genre="${design.genre}" → 일반적으로 전투 포함`);
  }
  if (genre === "runner" || genre.includes("runner") || genre.includes("endless")) {
    add("runner", `genre="${design.genre}"`);
    add("scoring", `genre="${design.genre}" → 점수 시스템 포함`);
  }
  if (genre === "rpg" || genre.includes("rpg") || genre.includes("role")) {
    add("combat", `genre="${design.genre}"`);
    add("character_select", `genre="${design.genre}" → 캐릭터 선택 일반적`);
    add("skill_system", `genre="${design.genre}" → 스킬 시스템 일반적`);
    add("level_system", `genre="${design.genre}" → 레벨업 시스템`);
    add("inventory", `genre="${design.genre}" → 인벤토리`);
  }
  if (genre === "puzzle" || genre.includes("puzzle")) {
    add("puzzle", `genre="${design.genre}"`);
    add("scoring", `genre="${design.genre}" → 점수 시스템`);
  }
  if (genre === "match3" || genre.includes("match")) {
    add("match3", `genre="${design.genre}"`);
    add("puzzle", `genre="${design.genre}"`);
    add("scoring", `genre="${design.genre}"`);
  }
  if (genre === "shooter" || genre.includes("shoot") || genre.includes("shoot")) {
    add("ranged_combat", `genre="${design.genre}"`);
    add("combat", `genre="${design.genre}"`);
    add("scoring", `genre="${design.genre}"`);
  }
  if (genre === "strategy" || genre.includes("strategy") || genre.includes("tower") || genre.includes("defense")) {
    add("tower_defense", `genre="${design.genre}"`);
    add("combat", `genre="${design.genre}"`);
    add("topdown", `genre="${design.genre}"`);
  }
  if (genre === "card" || genre.includes("card")) {
    add("card_game", `genre="${design.genre}"`);
    add("character_select", `genre="${design.genre}"`);
  }
  if (genre === "idle" || genre.includes("idle") || genre.includes("clicker") || genre.includes("tycoon")) {
    add("idle", `genre="${design.genre}"`);
    add("scoring", `genre="${design.genre}"`);
  }
  if (genre === "topdown" || genre.includes("top") || genre.includes("down")) {
    add("topdown", `genre="${design.genre}"`);
  }
  if (genre === "fighting") {
    add("melee_combat", `genre="${design.genre}"`);
    add("combat", `genre="${design.genre}"`);
    add("character_select", `genre="${design.genre}"`);
  }

  // ── 데이터 기반 추론 ──────────────────────────────────────────────────────

  // 적 캐릭터가 있으면 → 전투 메카닉
  if (design.enemies && design.enemies.length > 0) {
    add("combat", `enemies 배열에 ${design.enemies.length}개 적이 정의됨`);
    // 적 액션에 attack/attack이 있으면 → 전투 확정
    const hasAttackAction = design.enemies.some(e =>
      e.actions?.some(a => ["attack", "shoot", "charge", "cast"].includes(a.toLowerCase()))
    );
    if (hasAttackAction) {
      add("melee_combat", "enemies[].actions에 공격 동작 포함");
    }
    // 적 이동 동작 확인
    const hasMoveAction = design.enemies.some(e =>
      e.actions?.some(a => ["walk", "run", "fly", "patrol"].includes(a.toLowerCase()))
    );
    if (hasMoveAction) {
      add("combat", "enemies[].actions에 이동 동작 포함");
    }
  }

  // 무기가 있으면 → 무기 시스템
  if (design.weapons && design.weapons.length > 0) {
    add("weapon_system", `weapons 배열에 ${design.weapons.length}개 무기 정의됨`);
    add("combat", "weapons 배열이 있으므로 전투 메카닉 추론");
  }

  // 아이템이 있으면 → 인벤토리
  if (design.items && design.items.length > 0) {
    add("inventory", `items 배열에 ${design.items.length}개 아이템 정의됨`);
  }

  // 맵이 있으면 → 타일맵/패럴랙스
  if (design.maps && design.maps.length > 0) {
    const hasTileSize = design.maps.some(m => m.tile_size != null);
    if (hasTileSize) {
      add("platformer", "maps[].tile_size가 정의됨 → 타일맵 사용");
    }
    const hasParallax = design.maps.some(m => m.parallax_theme != null);
    if (hasParallax) {
      add("platformer", "maps[].parallax_theme이 정의됨 → 패럴랙스 배경 사용");
    }
    const hasProps = design.maps.some(m => m.props && m.props.length > 0);
    if (hasProps) {
      add("platformer", "maps[].props가 정의됨 → 소품 오브젝트 필요");
    }
  }

  // 화면에 tutorial이 있으면 → 튜토리얼
  if (design.screens) {
    const hasTutorial = design.screens.some(s =>
      s.id?.toLowerCase().includes("tutorial") ||
      s.name?.toLowerCase().includes("tutorial") ||
      s.name?.toLowerCase().includes("튜토리얼")
    );
    if (hasTutorial) {
      add("tutorial", "screens에 튜토리얼 화면 정의됨");
    }

    // 캐릭터 선택 화면
    const hasCharSelect = design.screens.some(s =>
      s.id?.toLowerCase().includes("character") ||
      s.id?.toLowerCase().includes("select") ||
      s.name?.toLowerCase().includes("캐릭터 선택") ||
      s.name?.toLowerCase().includes("character select")
    );
    if (hasCharSelect) {
      add("character_select", "screens에 캐릭터 선택 화면 정의됨");
    }
  }

  // BGM 트랙이 여러 개 있으면 → 다양한 BGM 필요
  if (design.sounds?.bgm_tracks && design.sounds.bgm_tracks.length > 2) {
    add("scoring", "bgm_tracks가 3개 이상 → 장면이 많은 게임");
  }

  // SFX 목록에 전투 관련 효과음이 있으면 → 전투
  if (design.sounds?.sfx_list) {
    const combatSfx = design.sounds.sfx_list.some(s =>
      ["attack", "hit", "slash", "shoot", "explode", "hurt", "die"].some(k => s.toLowerCase().includes(k))
    );
    if (combatSfx) {
      add("combat", "sfx_list에 전투 관련 효과음 포함");
    }
  }

  // 캐릭터가 2명 이상이면 → 캐릭터 선택 권장
  if (design.characters && design.characters.length >= 2) {
    add("character_select", `characters 배열에 ${design.characters.length}개 → 캐릭터 선택 화면 권장`);
  }

  // 최종 active = declared ∪ inferred (중복 제거)
  const active = [...new Set([...declared, ...inferred])];

  return { declared, inferred, active, inference_reasons };
}

// ─── 필요도 분석 ─────────────────────────────────────────────────────────────

export interface AssetRequirementResult {
  category_id: string;
  category_name: string;
  level: RequirementLevel;
  reason: string;
  tools: string[];
  stage: number;
}

export interface AssetRequirementsReport {
  game_name: string;
  genre: string;
  declared_mechanics: string[];
  inferred_mechanics: string[];
  active_mechanics: string[];
  inference_reasons: Array<{ mechanic: string; reason: string }>;
  categories: AssetRequirementResult[];
  summary: {
    required: number;
    recommended: number;
    optional: number;
    not_needed: number;
    total_categories: number;
  };
  /** Stage별 필요 카테고리 목록 */
  by_stage: Record<number, AssetRequirementResult[]>;
}

/**
 * GAME_DESIGN.json 분석 → 각 에셋 카테고리의 필요도 계산.
 */
export function analyzeAssetRequirements(design: GameDesign): AssetRequirementsReport {
  const { declared, inferred, active, inference_reasons } = inferMechanics(design);

  const hasCharacters = (design.characters?.length ?? 0) > 0 || (design.enemies?.length ?? 0) > 0;
  const hasMaps = (design.maps?.length ?? 0) > 0;
  const hasMarketing = !!(design.marketing?.generate_logo || design.marketing?.generate_thumbnail ||
    (design as GameDesign & { marketing?: { platforms?: string[] } }).marketing?.platforms?.length);

  const categories: AssetRequirementResult[] = ASSET_REQUIREMENT_MATRIX.map(cat => {
    // always_required
    if (cat.always_required) {
      return {
        category_id: cat.id,
        category_name: cat.name,
        level: "required" as RequirementLevel,
        reason: "모든 게임에 공통적으로 필요",
        tools: cat.tools,
        stage: cat.stage,
      };
    }

    // 특수 케이스: 캐릭터 관련
    if ((cat.id === "character_base" || cat.id === "sprite_idle") && hasCharacters) {
      return {
        category_id: cat.id,
        category_name: cat.name,
        level: "required" as RequirementLevel,
        reason: `캐릭터/적 데이터가 정의되어 있음`,
        tools: cat.tools,
        stage: cat.stage,
      };
    }

    // only_for_mechanics가 있고 active mechanics에 하나도 없으면 → not_needed
    if (cat.only_for_mechanics.length > 0) {
      const hasAny = cat.only_for_mechanics.some(m => active.includes(m));
      if (!hasAny) {
        return {
          category_id: cat.id,
          category_name: cat.name,
          level: "not_needed" as RequirementLevel,
          reason: `필요 메카닉(${cat.only_for_mechanics.slice(0, 3).join("/")}${cat.only_for_mechanics.length > 3 ? "..." : ""})이 이 게임에 해당 없음`,
          tools: cat.tools,
          stage: cat.stage,
        };
      }
    }

    // required_for_mechanics 중 하나라도 active에 있으면 → required
    if (cat.required_for_mechanics.length > 0) {
      const matched = cat.required_for_mechanics.filter(m => active.includes(m));
      if (matched.length > 0) {
        return {
          category_id: cat.id,
          category_name: cat.name,
          level: "required" as RequirementLevel,
          reason: `메카닉 [${matched.join(", ")}]에 필수`,
          tools: cat.tools,
          stage: cat.stage,
        };
      }
    }

    // recommended_for_mechanics 중 하나라도 active에 있으면 → recommended
    if (cat.recommended_for_mechanics.length > 0) {
      const matched = cat.recommended_for_mechanics.filter(m => active.includes(m));
      if (matched.length > 0) {
        return {
          category_id: cat.id,
          category_name: cat.name,
          level: "recommended" as RequirementLevel,
          reason: `메카닉 [${matched.join(", ")}]에 권장`,
          tools: cat.tools,
          stage: cat.stage,
        };
      }
    }

    // 마케팅 카테고리 특수 처리
    if ((cat.id === "marketing_store" || cat.id === "marketing_thumbnail") && hasMarketing) {
      return {
        category_id: cat.id,
        category_name: cat.name,
        level: "recommended" as RequirementLevel,
        reason: "marketing 필드가 설정됨 → 퍼블리싱 시 필요",
        tools: cat.tools,
        stage: cat.stage,
      };
    }

    // 나머지는 optional
    return {
      category_id: cat.id,
      category_name: cat.name,
      level: "optional" as RequirementLevel,
      reason: "이 게임 설정에서 선택적",
      tools: cat.tools,
      stage: cat.stage,
    };
  });

  // 요약 계산
  const summary = {
    required:  categories.filter(c => c.level === "required").length,
    recommended: categories.filter(c => c.level === "recommended").length,
    optional:  categories.filter(c => c.level === "optional").length,
    not_needed: categories.filter(c => c.level === "not_needed").length,
    total_categories: categories.length,
  };

  // Stage별 그룹핑
  const by_stage: Record<number, AssetRequirementResult[]> = {};
  for (const cat of categories) {
    if (!by_stage[cat.stage]) by_stage[cat.stage] = [];
    by_stage[cat.stage].push(cat);
  }

  return {
    game_name: design.game_name,
    genre: design.genre || "unknown",
    declared_mechanics: declared,
    inferred_mechanics: inferred,
    active_mechanics: active,
    inference_reasons,
    categories,
    summary,
    by_stage,
  };
}

/** 필요도 레벨에 해당하는 이모지 */
export function levelEmoji(level: RequirementLevel): string {
  switch (level) {
    case "required":    return "🔴";
    case "recommended": return "🟡";
    case "optional":    return "⚪";
    case "not_needed":  return "⛔";
  }
}

/** 필요도 레벨 한글 표시 */
export function levelLabel(level: RequirementLevel): string {
  switch (level) {
    case "required":    return "필수";
    case "recommended": return "권장";
    case "optional":    return "선택";
    case "not_needed":  return "불필요";
  }
}
