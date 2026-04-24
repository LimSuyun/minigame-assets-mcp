/**
 * design-doc.ts
 *
 * GAME_DESIGN.json 기반 에셋 명세 도구 모음.
 * - GAME_DESIGN.json 파싱 및 구조화
 * - asset_size_spec.json 자동 생성 (T/SF 기반 중첩 크기 계산)
 * - 화면별 에셋 플랜 생성
 * - FULL_ASSET_PLAN.md 생성
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_OUTPUT_DIR,
  DEFAULT_GAME_DESIGN_FILE,
  DEFAULT_ASSET_SIZE_SPEC_FILE,
} from "../constants.js";
import { handleApiError } from "../utils/errors.js";
import { ensureDir } from "../utils/files.js";
import { loadCanonRegistry } from "../utils/canon.js";
import type { GameDesign, AssetSizeSpecFile, SizeSpec, GameDesignSize, NestedSizeSpecs } from "../types.js";
import { analyzeAssetRequirements, levelEmoji, levelLabel, type RequirementLevel } from "../utils/asset-requirements.js";

// ─── 크기 프로파일 캔버스 크기 ────────────────────────────────────────────────

const SIZE_PROFILE_CANVAS: Record<string, GameDesignSize> = {
  mobile_portrait: { width: 390, height: 844 },
  mobile_landscape: { width: 844, height: 390 },
  desktop_hd: { width: 1920, height: 1080 },
  custom: { width: 1024, height: 1024 },
};

// ─── 크기 명세 헬퍼 ───────────────────────────────────────────────────────────

function makeSpec(
  assetType: string,
  w: number,
  h: number,
  transparent: boolean,
  notes: string,
  format = "PNG"
): SizeSpec {
  return { asset_type: assetType, width: Math.round(w), height: Math.round(h), format, transparent, notes };
}

function snapToStd(n: number): number {
  const standards = [32, 48, 64, 96, 128, 192, 256, 384, 512, 768, 1024, 1280, 1536, 1792, 1920, 2048];
  return standards.reduce((prev, curr) =>
    Math.abs(curr - n) < Math.abs(prev - n) ? curr : prev
  );
}

/**
 * T (tile_size) 와 화면 크기(SW×SH)를 기반으로 중첩 크기 명세 생성.
 *
 * 참고:
 *   T  = tile_size (기본: 64 모바일, 128 데스크톱)
 *   SF = T×2 (기본 스프라이트 프레임)
 *   SW = screen width, SH = screen height
 */
function generateNestedSizeSpecs(
  canvas: GameDesignSize,
  tileSize?: number
): NestedSizeSpecs {
  const SW = canvas.width;
  const SH = canvas.height;
  const isMobile = SW <= 844;
  const T = tileSize ?? (isMobile ? 64 : 128);
  const SF = T * 2;   // 스프라이트 프레임 기본 크기

  return {
    base: {
      tile_size: T,
      sprite_frame: { width: SF, height: SF },
      screen: { width: SW, height: SH },
      sprite_sheet_max: 2048,
    },

    characters: {
      // base_master는 고정 1024×1024 (플랜 섹션 6: "고정 1024×1024")
      base_master: makeSpec("character_base_master", 1024, 1024, true,
        "캐릭터 Canon 마스터 (고정 1024×1024)"),
      sprite_frame: makeSpec("character_sprite_frame", SF, SF, true,
        `스프라이트 프레임 단위 (SF = ${SF}×${SF})`),
      // portrait 계열은 SF 기준 (플랜: SF×8, SF×4, SF×1)
      portrait_full: makeSpec("character_portrait_full", SF * 8, SF * 8, true,
        `전신 포트레이트 (SF×8 = ${SF * 8}×${SF * 8})`),
      portrait_bust: makeSpec("character_portrait_bust", SF * 4, SF * 4, true,
        `상반신 포트레이트 (SF×4 = ${SF * 4}×${SF * 4})`),
      portrait_thumb: makeSpec("character_portrait_thumb", SF, SF, true,
        `썸네일 포트레이트 (SF×1 = ${SF}×${SF})`),
      // 카드 비율 SF×3 × SF×4.5 (플랜: 384×576 at SF=128)
      char_card: makeSpec("character_card", SF * 3, Math.round(SF * 4.5), true,
        `캐릭터 카드 (SF×3 × SF×4.5 = ${SF * 3}×${Math.round(SF * 4.5)})`),
    },

    backgrounds: {
      full: makeSpec("background_full", SW, SH, false,
        `전체 배경 (화면 크기 = ${SW}×${SH})`),
      parallax_far:  makeSpec("background_parallax_far",  Math.round(SW * 2.5), SH, false,
        `패럴랙스 원거리 레이어 (SW×2.5 = ${Math.round(SW * 2.5)}×${SH})`),
      parallax_mid:  makeSpec("background_parallax_mid",  Math.round(SW * 3.5), SH, true,
        `패럴랙스 중거리 레이어 (SW×3.5 = ${Math.round(SW * 3.5)}×${SH})`),
      parallax_near: makeSpec("background_parallax_near", Math.round(SW * 5.0), SH, true,
        `패럴랙스 근거리 레이어 (SW×5.0 = ${Math.round(SW * 5.0)}×${SH})`),
    },

    tiles: {
      // T×16 격자 (플랜: "T×16 × T×16 (16×16 그리드)")
      tileset:     makeSpec("tileset",     T * 16, T * 16, false,
        `타일셋 아틀라스 (T×16 = ${T * 16}×${T * 16}, 16×16 그리드)`),
      tile_single: makeSpec("tile_single", T, T, false,
        `단일 타일 (T = ${T}×${T})`),
    },

    effects: {
      // 이펙트 크기는 T 기준 (플랜: sm=T, md=T×2, lg=T×4, xl=T×8)
      sm: makeSpec("effect_sm", T, T, true,
        `소형 이펙트 (T = ${T}×${T})`),
      md: makeSpec("effect_md", T * 2, T * 2, true,
        `중형 이펙트 (T×2 = ${T * 2}×${T * 2})`),
      lg: makeSpec("effect_lg", T * 4, T * 4, true,
        `대형 이펙트 (T×4 = ${T * 4}×${T * 4})`),
      xl: makeSpec("effect_xl", T * 8, T * 8, true,
        `초대형 이펙트 (T×8 = ${T * 8}×${T * 8})`),
    },

    ui: {
      icon_sm:  makeSpec("ui_icon_sm", Math.round(T / 2), Math.round(T / 2), true,
        `소형 아이콘 (T÷2 = ${Math.round(T / 2)}×${Math.round(T / 2)})`),
      icon_md:  makeSpec("ui_icon_md", T, T, true,
        `중형 아이콘 (T = ${T}×${T})`),
      icon_lg:  makeSpec("ui_icon_lg", T * 2, T * 2, true,
        `대형 아이콘 (T×2 = ${T * 2}×${T * 2})`),
      // 버튼은 SW 기반 (플랜: SW×0.25, SW×0.4, SW×0.6)
      button_sm: makeSpec("ui_button_sm", Math.round(SW * 0.25), Math.round(T * 0.75), true,
        `소형 버튼 (SW×0.25 × T×0.75 = ${Math.round(SW * 0.25)}×${Math.round(T * 0.75)})`),
      button_md: makeSpec("ui_button_md", Math.round(SW * 0.4), T, true,
        `중형 버튼 (SW×0.4 × T = ${Math.round(SW * 0.4)}×${T})`),
      button_lg: makeSpec("ui_button_lg", Math.round(SW * 0.6), Math.round(T * 1.25), true,
        `대형 버튼 (SW×0.6 × T×1.25 = ${Math.round(SW * 0.6)}×${Math.round(T * 1.25)})`),
      // hp_bar_width: SW 기반 (플랜: SW×0.5)
      hp_bar_width: Math.round(SW * 0.5),
      // popup_panel: SW×SH 기반 (플랜: SW×0.85 × SH×0.65)
      popup_panel: makeSpec("ui_popup_panel", Math.round(SW * 0.85), Math.round(SH * 0.65), true,
        `팝업 패널 (SW×0.85 × SH×0.65 = ${Math.round(SW * 0.85)}×${Math.round(SH * 0.65)})`),
    },

    marketing: {
      app_icon:               makeSpec("marketing_app_icon", 1024, 1024, false,
        "앱 아이콘 (App Store/Google Play 고정 1024×1024)"),
      // thumbnail은 고정 1280×720 (플랜: "항상 고정")
      thumbnail:              makeSpec("marketing_thumbnail", 1280, 720, false,
        "게임 썸네일 (고정 1280×720)"),
      // iOS 스크린샷: iPhone 15 Pro Max 고정 크기 (플랜: 1290×2796)
      store_screenshot_ios:   makeSpec("store_screenshot_ios", 1290, 2796, false,
        "iOS App Store 스크린샷 (1290×2796 iPhone 15 Pro Max)"),
      store_screenshot_android: makeSpec("store_screenshot_android", 1080, 1920, false,
        "Google Play 스크린샷 (1080×1920)"),
      google_play_banner:     makeSpec("google_play_banner", 1024, 500, false,
        "Google Play 피처드 그래픽 (1024×500)"),
      instagram_post:         makeSpec("instagram_post", 1080, 1080, false,
        "Instagram 정사각형 포스트 (1080×1080)"),
      instagram_story:        makeSpec("instagram_story", 1080, 1920, false,
        "Instagram 스토리 세로 (1080×1920)"),
    },
  };
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerDesignDocTools(server: McpServer): void {

  // ── 1. GAME_DESIGN.json 파싱 ───────────────────────────────────────────────
  server.registerTool(
    "asset_parse_design_doc",
    {
      title: "Parse GAME_DESIGN.json",
      description: `Parse and validate a GAME_DESIGN.json design document.
Returns structured game design data including art style, canvas size, characters, and screens.

GAME_DESIGN.json is the primary input format for the 3-path entry system:
- Path A: GAME_DESIGN.json (full structured input)
- Path B: CONCEPT.md (auto-converted from GAME_DESIGN)
- Path C: Wizard (guided creation)

Also extracts:
- Asset list (all asset types needed from character/enemy/weapon/item/map/effect/marketing fields)
- Dependency graph (what depends on what)
- Stage order recommendation (0→1→2→3→4→5→6)
- Estimated AI call count

Args:
  - design_file (string, optional): Path to GAME_DESIGN.json (default: ./GAME_DESIGN.json)

Returns:
  Parsed GameDesign object with validation summary, asset list, and Stage recommendations`,
      inputSchema: z.object({
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const filePath = path.resolve(params.design_file || DEFAULT_GAME_DESIGN_FILE);

        if (!fs.existsSync(filePath)) {
          return {
            content: [{ type: "text" as const, text: JSON.stringify({
              found: false,
              path_checked: filePath,
              message: "GAME_DESIGN.json을 찾을 수 없습니다.",
              template: {
                game_name: "My Game",
                genre: "platformer",
                art_style: "2D cartoon, thick black outlines, flat colors",
                color_palette: ["#4A90D9", "#E8F4FD", "#2C3E50", "#F39C12", "#E74C3C"],
                description: "A fun 2D platformer game.",
                theme: "Fantasy adventure",
                target_platform: "mobile",
                size_profile: "mobile_portrait",
                canvas_size: { width: 390, height: 844 },
                characters: [{ id: "hero", name: "Hero", description: "Main protagonist" }],
                enemies: [{ id: "slime", type: "basic", description: "Basic enemy", actions: ["walk", "attack"] }],
                weapons: [{ id: "sword", name: "Sword", description: "Basic sword" }],
                screens: [{ id: "main_menu", name: "Main Menu" }, { id: "gameplay", name: "Gameplay" }],
                sounds: { bgm_style: "chiptune", sfx_style: "retro", bgm_tracks: ["main_theme"], sfx_list: ["jump", "hit"] },
                marketing: { generate_logo: true, generate_thumbnail: true, platforms: ["ios", "android"] },
              },
            }, null, 2) }],
          };
        }

        const raw = fs.readFileSync(filePath, "utf-8");
        const design = JSON.parse(raw) as GameDesign;

        // 유효성 검사
        const issues: string[] = [];
        if (!design.game_name) issues.push("game_name 누락");
        if (!design.art_style) issues.push("art_style 누락 (에셋 생성 품질에 영향)");
        if (!design.size_profile && !design.canvas_size) issues.push("size_profile 또는 canvas_size 누락");

        const canvas = design.canvas_size || SIZE_PROFILE_CANVAS[design.size_profile || "custom"];

        // 에셋 목록 추출
        const assetList: Array<{ id: string; type: string; count: number }> = [];
        if (design.characters?.length) assetList.push({ id: "characters", type: "character", count: design.characters.length });
        if (design.enemies?.length)    assetList.push({ id: "enemies",    type: "enemy",     count: design.enemies.length });
        if (design.weapons?.length)    assetList.push({ id: "weapons",    type: "weapon",    count: design.weapons.length });
        if (design.items?.length)      assetList.push({ id: "items",      type: "item",      count: design.items.length });
        if (design.maps?.length)       assetList.push({ id: "maps",       type: "map",       count: design.maps.length });
        if (design.effects?.length)    assetList.push({ id: "effects",    type: "effect",    count: design.effects.length });
        if (design.screens?.length)    assetList.push({ id: "screens",    type: "background",count: design.screens.length });

        // Stage별 권고 순서
        const stageRecommendations = [
          { stage: 0, name: "Canon & Foundation", tools: ["asset_generate_size_spec", "asset_generate_app_logo", "asset_register_canon", "asset_generate_style_reference_sheet"] },
          { stage: 1, name: "Characters", tools: ["asset_generate_character_base", "asset_generate_character_pose", "asset_generate_action_sprite"] },
          { stage: 2, name: "UI Structural", tools: ["asset_generate_ui_structural", "asset_generate_button_set", "asset_generate_hud_set", "asset_generate_popup_set"] },
          { stage: 3, name: "Backgrounds", tools: ["asset_generate_screen_background"] },
          { stage: 4, name: "Items & Effects", tools: ["asset_generate_image", "asset_batch_generate_images"] },
          { stage: 5, name: "Audio", tools: ["asset_generate_music_local"] },
          { stage: 6, name: "Marketing", tools: ["asset_generate_thumbnail", "asset_generate_app_logo"] },
        ];

        // 예상 AI 호출 수 계산
        const charCount = design.characters?.length || 0;
        const enemyCount = design.enemies?.length || 0;
        const screenCount = design.screens?.length || 0;
        const weaponCount = design.weapons?.length || 0;
        const estimatedAICalls =
          1 +                              // logo
          charCount * 3 +                  // character base + 2 action sprites
          enemyCount * 2 +                 // enemy base + 1 action sprite
          weaponCount +                    // weapon icons
          screenCount * 2 +               // background + parallax
          3 +                              // UI button/HUD/popup sets
          (design.marketing?.generate_thumbnail ? 1 : 0);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            found: true,
            file_path: filePath,
            design,
            canvas_size_resolved: canvas,
            validation: { valid: issues.length === 0, issues },
            summary: {
              game_name: design.game_name,
              genre: design.genre,
              art_style: design.art_style,
              size_profile: design.size_profile,
              canvas,
              character_count: charCount,
              enemy_count: enemyCount,
              weapon_count: weaponCount,
              item_count: design.items?.length || 0,
              screen_count: screenCount,
            },
            asset_list: assetList,
            stage_order: stageRecommendations,
            estimated_ai_calls: estimatedAICalls,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Parse Design Doc") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. 에셋 크기 명세 생성 ───────────────────────────────────────────────
  server.registerTool(
    "asset_generate_size_spec",
    {
      title: "Generate Asset Size Specification",
      description: `Generate asset_size_spec.json from GAME_DESIGN.json using T/SF-based nested category structure.

Size calculation strategy (T = tile_size, SF = T×2, SW/SH = screen dimensions):
  - characters: SF×SF (sprite_frame), T×4 (portrait_full), etc.
  - backgrounds: SW×SH (full), SW×2.5 (parallax_far), SW×3.5 (mid), SW×5.0 (near)
  - tiles: T×T (tile_single), max 2048 (tileset)
  - effects: T/2 (sm) → T×4 (xl)
  - ui: icon T/2~T×2, button T×3~T×7, popup T×6×T×8
  - marketing: platform-standard fixed sizes

3-Layer Size Spec System:
  Layer 1 (Global): GAME_DESIGN.json size_profile → canvas size
  Layer 2 (Type):   asset_size_spec.json nested specs (this tool)
  Layer 3 (Override): Per-tool override via size/aspect_ratio parameter

Args:
  - design_file (string, optional): Path to GAME_DESIGN.json
  - size_profile (string, optional): Override size profile
  - canvas_width (number, optional): Custom canvas width (size_profile=custom)
  - canvas_height (number, optional): Custom canvas height (size_profile=custom)
  - tile_size (number, optional): Override tile size T (default: 64 mobile, 128 desktop)
  - output_file (string, optional): Output path for asset_size_spec.json

Returns:
  Generated nested size spec summary and file path`,
      inputSchema: z.object({
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
        size_profile: z.enum(["mobile_portrait", "mobile_landscape", "desktop_hd", "custom"]).optional()
          .describe("Override size profile"),
        canvas_width: z.number().int().min(100).max(4096).optional()
          .describe("Custom canvas width"),
        canvas_height: z.number().int().min(100).max(4096).optional()
          .describe("Custom canvas height"),
        tile_size: z.number().int().min(8).max(256).optional()
          .describe("Override tile size T (default: 64 mobile, 128 desktop)"),
        output_file: z.string().optional()
          .describe("Output path for asset_size_spec.json"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        let profile = params.size_profile || "mobile_portrait";
        let canvas: GameDesignSize = SIZE_PROFILE_CANVAS[profile] || SIZE_PROFILE_CANVAS.mobile_portrait;

        // GAME_DESIGN.json에서 캔버스 크기 결정
        const designFilePath = path.resolve(params.design_file || DEFAULT_GAME_DESIGN_FILE);
        let tileSize = params.tile_size;

        if (fs.existsSync(designFilePath)) {
          try {
            const design = JSON.parse(fs.readFileSync(designFilePath, "utf-8")) as GameDesign;
            if (!params.size_profile && design.size_profile) {
              profile = design.size_profile;
            }
            if (design.canvas_size) {
              canvas = design.canvas_size;
            } else if (design.size_profile && SIZE_PROFILE_CANVAS[design.size_profile]) {
              canvas = SIZE_PROFILE_CANVAS[design.size_profile];
            }
            // GAME_DESIGN.json의 maps.tile_size에서 T 결정
            if (!tileSize && design.maps?.[0]?.tile_size) {
              tileSize = design.maps[0].tile_size;
            }
          } catch { /* GAME_DESIGN.json 파싱 실패 시 기본값 사용 */ }
        }

        // 파라미터 오버라이드
        if (params.size_profile === "custom" && params.canvas_width && params.canvas_height) {
          canvas = { width: params.canvas_width, height: params.canvas_height };
          profile = "custom";
        } else if (params.size_profile && params.size_profile !== "custom") {
          canvas = SIZE_PROFILE_CANVAS[params.size_profile];
          profile = params.size_profile;
        }

        // 중첩 크기 명세 생성
        const specs = generateNestedSizeSpecs(canvas, tileSize);

        const specFile: AssetSizeSpecFile = {
          generated_at: new Date().toISOString(),
          size_profile: profile,
          canvas_size: canvas,
          specs,
        };

        const outputFile = path.resolve(params.output_file || DEFAULT_ASSET_SIZE_SPEC_FILE);
        ensureDir(path.dirname(outputFile));
        fs.writeFileSync(outputFile, JSON.stringify(specFile, null, 2), "utf-8");

        const { base } = specs;
        const output = {
          success: true,
          output_file: outputFile,
          size_profile: profile,
          canvas_size: canvas,
          tile_size: base.tile_size,
          sprite_frame: base.sprite_frame,
          summary: {
            characters: Object.fromEntries(
              Object.entries(specs.characters).map(([k, v]) => [k, `${v.width}×${v.height}px`])
            ),
            backgrounds: Object.fromEntries(
              Object.entries(specs.backgrounds).map(([k, v]) => [k, `${v.width}×${v.height}px`])
            ),
            tiles: Object.fromEntries(
              Object.entries(specs.tiles).map(([k, v]) => [k, `${v.width}×${v.height}px`])
            ),
            effects: Object.fromEntries(
              Object.entries(specs.effects).map(([k, v]) => [k, `${v.width}×${v.height}px`])
            ),
            ui: Object.fromEntries(
              Object.entries(specs.ui).map(([k, v]) =>
                typeof v === "number" ? [k, `${v}px`] : [k, `${v.width}×${v.height}px`]
              )
            ),
            marketing: Object.fromEntries(
              Object.entries(specs.marketing).map(([k, v]) => [k, `${v.width}×${v.height}px`])
            ),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Generate Size Spec") }],
          isError: true,
        };
      }
    }
  );

  // ── 3. 화면별 에셋 플랜 ───────────────────────────────────────────────────
  server.registerTool(
    "asset_plan_by_screen",
    {
      title: "Plan Assets by Game Screen",
      description: `Generate a per-screen asset creation plan from GAME_DESIGN.json.

Args:
  - design_file (string, optional): Path to GAME_DESIGN.json
  - size_spec_file (string, optional): Path to asset_size_spec.json
  - output_dir (string, optional): Output directory

Returns:
  Per-screen asset plans with suggested generation tools and parameters`,
      inputSchema: z.object({
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
        size_spec_file: z.string().optional().describe("Path to asset_size_spec.json"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const designFilePath = path.resolve(params.design_file || DEFAULT_GAME_DESIGN_FILE);

        if (!fs.existsSync(designFilePath)) {
          return {
            content: [{ type: "text" as const, text: `GAME_DESIGN.json을 찾을 수 없습니다: ${designFilePath}` }],
            isError: true,
          };
        }

        const design = JSON.parse(fs.readFileSync(designFilePath, "utf-8")) as GameDesign;

        // 크기 명세 로드
        let sizeSpecs: AssetSizeSpecFile | null = null;
        const sizeSpecPath = path.resolve(params.size_spec_file || DEFAULT_ASSET_SIZE_SPEC_FILE);
        if (fs.existsSync(sizeSpecPath)) {
          try {
            sizeSpecs = JSON.parse(fs.readFileSync(sizeSpecPath, "utf-8")) as AssetSizeSpecFile;
          } catch { /* ignore */ }
        }

        const canvas = design.canvas_size ||
          SIZE_PROFILE_CANVAS[design.size_profile || "mobile_portrait"];

        // 크기 헬퍼
        const sz = (spec: SizeSpec | undefined) =>
          spec ? `${spec.width}×${spec.height}` : `${canvas.width}×${canvas.height}`;

        const styleHint = [
          design.art_style,
          design.color_palette ? `palette: ${design.color_palette.slice(0, 4).join(", ")}` : "",
          design.theme,
        ].filter(Boolean).join(", ");

        const screens = design.screens || [
          { id: "main_menu", name: "Main Menu" },
          { id: "gameplay", name: "Gameplay" },
          { id: "result", name: "Result Screen" },
        ];

        const screenPlans = screens.map((screen) => {
          const assets: Array<{
            id: string;
            asset_type: string;
            size: string;
            tool: string;
            priority: number;
            prompt_hint: string;
          }> = [];

          const chars = sizeSpecs?.specs.characters;
          const bgs = sizeSpecs?.specs.backgrounds;
          const ui = sizeSpecs?.specs.ui;

          if (screen.id.includes("menu") || screen.id.includes("main")) {
            assets.push(
              { id: `${screen.id}_bg`, asset_type: "background", size: sz(bgs?.full), tool: "asset_generate_screen_background", priority: 1, prompt_hint: `${styleHint}, main menu background` },
              { id: `${screen.id}_logo`, asset_type: "logo", size: "1024×1024", tool: "asset_generate_app_logo", priority: 2, prompt_hint: `${design.game_name} game logo` },
              { id: `${screen.id}_btn_play`, asset_type: "ui_button_md", size: sz(ui?.button_md), tool: "asset_generate_button_set", priority: 3, prompt_hint: `${styleHint}, play button` },
              { id: `${screen.id}_panel`, asset_type: "ui_popup_panel", size: sz(ui?.popup_panel), tool: "asset_generate_ui_structural", priority: 4, prompt_hint: "Main menu panel" },
            );
          } else if (screen.id.includes("gameplay") || screen.id.includes("game")) {
            assets.push(
              { id: `${screen.id}_bg`, asset_type: "background_full", size: sz(bgs?.full), tool: "asset_generate_screen_background", priority: 1, prompt_hint: `${styleHint}, gameplay background` },
              { id: `${screen.id}_hud`, asset_type: "ui_hud", size: sz(ui?.button_md), tool: "asset_generate_hud_set", priority: 2, prompt_hint: `${styleHint}, HUD elements` },
            );
            design.characters?.forEach((char, idx) => {
              assets.push({
                id: char.id,
                asset_type: "character_sprite_frame",
                size: sz(chars?.sprite_frame),
                tool: "asset_generate_character_base",
                priority: 3 + idx,
                prompt_hint: `${styleHint}, ${char.description}`,
              });
            });
          } else if (screen.id.includes("result") || screen.id.includes("gameover") || screen.id.includes("win")) {
            assets.push(
              { id: `${screen.id}_bg`, asset_type: "background_full", size: sz(bgs?.full), tool: "asset_generate_screen_background", priority: 1, prompt_hint: `${styleHint}, ${screen.name} background` },
              { id: `${screen.id}_panel`, asset_type: "ui_popup_panel", size: sz(ui?.popup_panel), tool: "asset_generate_popup_set", priority: 2, prompt_hint: `${styleHint}, result panel` },
            );
          } else {
            assets.push(
              { id: `${screen.id}_bg`, asset_type: "background_full", size: sz(bgs?.full), tool: "asset_generate_screen_background", priority: 1, prompt_hint: `${styleHint}, ${screen.name} background` },
            );
          }

          return {
            screen_id: screen.id,
            screen_name: screen.name,
            description: screen.description,
            asset_count: assets.length,
            assets,
          };
        });

        const totalAssets = screenPlans.reduce((s, p) => s + p.asset_count, 0);

        const output = {
          game_name: design.game_name,
          canvas_size: canvas,
          total_screens: screenPlans.length,
          total_assets: totalAssets,
          screens: screenPlans,
          style_hint: styleHint,
          notes: [
            "asset_generate_size_spec를 먼저 실행하여 정확한 크기 명세를 생성하세요.",
            "Canon 레퍼런스를 먼저 생성한 후 파생 에셋을 만드세요.",
            "asset_generate_full_plan으로 전체 FULL_ASSET_PLAN.md를 생성할 수 있습니다.",
          ],
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Plan By Screen") }],
          isError: true,
        };
      }
    }
  );

  // ── 4. 에셋 필요도 분석 ──────────────────────────────────────────────────
  server.registerTool(
    "asset_plan_requirements",
    {
      title: "Analyze Asset Requirements for This Game",
      description: `GAME_DESIGN.json을 분석하여 각 에셋 카테고리의 필요도를 판단합니다.

게임 장르(genre)와 실제 데이터(characters/enemies/weapons/maps 등)에서
필요한 메카닉을 자동 추론하고, 각 카테고리를 4단계로 분류합니다:

  🔴 필수     — 이 게임 타입에 반드시 필요 (생성하지 않으면 게임 미완성)
  🟡 권장     — 없어도 돌아가지만 강력히 권장
  ⚪ 선택     — 있으면 좋지만 없어도 무방
  ⛔ 불필요   — 이 게임 타입에 해당 없음 (생성하지 말 것)

**자동 추론 예시:**
  - genre="platformer"                → sprite_movement(필수), tileset(필수), parallax_bg(필수)
  - enemies[]에 attack 액션 존재      → combat(필수), sprite_combat(필수), hud_combat(필수)
  - weapons[] 배열 존재               → weapon_icons(필수), weapon_system(추론됨)
  - characters.length >= 2            → character_select(권장), character_portrait(권장)
  - screens에 tutorial 화면 존재      → tutorial_overlays(필수)

**명시적 제어:**
  GAME_DESIGN.json에 "mechanics": ["platformer", "combat", "skill_system"] 추가 시
  자동 추론 결과와 합집합으로 적용됩니다.

Args:
  - design_file (string, optional): Path to GAME_DESIGN.json (default: ./GAME_DESIGN.json)

Returns:
  에셋 카테고리별 필요도 분석 결과 + 추론된 메카닉 목록 + Stage별 정리`,
      inputSchema: z.object({
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const designFilePath = path.resolve(params.design_file || DEFAULT_GAME_DESIGN_FILE);

        if (!fs.existsSync(designFilePath)) {
          return {
            content: [{ type: "text" as const, text: `GAME_DESIGN.json을 찾을 수 없습니다: ${designFilePath}\n먼저 GAME_DESIGN.json을 작성하세요.` }],
            isError: true,
          };
        }

        const design = JSON.parse(fs.readFileSync(designFilePath, "utf-8")) as GameDesign;
        const report = analyzeAssetRequirements(design);

        // 마크다운 리포트 생성
        const stageNames: Record<number, string> = {
          0: "Stage 0 — Canon & Foundation",
          1: "Stage 1 — Characters",
          2: "Stage 2 — UI & 텍스트",
          3: "Stage 3 — Backgrounds & Maps",
          4: "Stage 4 — Effects",
          5: "Stage 5 — Audio",
          6: "Stage 6 — Marketing",
        };

        const lines: string[] = [
          `# 에셋 필요도 분석: ${report.game_name}`,
          `> 장르: ${report.genre} | 활성 메카닉: ${report.active_mechanics.length}개`,
          "",
          "## 메카닉 분석",
          "",
          report.declared_mechanics.length > 0
            ? `**명시된 메카닉:** \`${report.declared_mechanics.join("`, `")}\``
            : "**명시된 메카닉:** (없음 — 자동 추론 전용)",
          "",
          `**추론된 메카닉** (${report.inferred_mechanics.length}개):`,
          ...report.inference_reasons.map(r => `  - \`${r.mechanic}\` ← ${r.reason}`),
          "",
          `**최종 적용 메카닉:** \`${report.active_mechanics.join("`, `") || "(없음)"}\``,
          "",
          "---",
          "",
          "## 요약",
          "",
          `| 레벨 | 카테고리 수 |`,
          `|------|------------|`,
          `| 🔴 필수 | **${report.summary.required}개** |`,
          `| 🟡 권장 | ${report.summary.recommended}개 |`,
          `| ⚪ 선택 | ${report.summary.optional}개 |`,
          `| ⛔ 불필요 | ${report.summary.not_needed}개 |`,
          `| 합계 | ${report.summary.total_categories}개 |`,
          "",
          "---",
          "",
          "## Stage별 상세",
          "",
        ];

        for (const [stageNum, stageCats] of Object.entries(report.by_stage).sort((a, b) => Number(a[0]) - Number(b[0]))) {
          const stageLabel = stageNames[Number(stageNum)] || `Stage ${stageNum}`;
          lines.push(`### ${stageLabel}`, "");
          lines.push("| 카테고리 | 필요도 | 사유 | 도구 |");
          lines.push("|---------|--------|------|------|");
          for (const cat of (stageCats as typeof report.categories)) {
            const emoji = levelEmoji(cat.level);
            const label = levelLabel(cat.level);
            const toolList = cat.tools.map(t => `\`${t}\``).join(", ");
            lines.push(`| ${emoji} ${cat.category_name} | **${label}** | ${cat.reason} | ${toolList} |`);
          }
          lines.push("");
        }

        // 불필요 카테고리 별도 목록
        const notNeeded = report.categories.filter(c => c.level === "not_needed");
        if (notNeeded.length > 0) {
          lines.push("---", "", "## ⛔ 이 게임에 불필요한 에셋 (생성하지 마세요)", "");
          for (const cat of notNeeded) {
            lines.push(`- **${cat.category_name}** (${cat.tools.join(", ")}) — ${cat.reason}`);
          }
          lines.push("");
        }

        // 추천 생성 순서 (필수 항목만)
        const requiredCats = report.categories.filter(c => c.level === "required");
        lines.push("---", "", "## 🔴 필수 에셋 생성 순서", "");
        for (let stageNum = 0; stageNum <= 6; stageNum++) {
          const stageRequired = requiredCats.filter(c => c.stage === stageNum);
          if (stageRequired.length > 0) {
            lines.push(`**${stageNames[stageNum] || `Stage ${stageNum}`}:**`);
            for (const cat of stageRequired) {
              lines.push(`  → ${cat.category_name}: ${cat.tools.map(t => `\`${t}\``).join(", ")}`);
            }
          }
        }

        const mdReport = lines.join("\n");

        return {
          content: [{ type: "text" as const, text: mdReport }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Plan Requirements") }],
          isError: true,
        };
      }
    }
  );

  // ── 5. 전체 에셋 플랜 생성 (FULL_ASSET_PLAN.md) ──────────────────────────
  server.registerTool(
    "asset_generate_full_plan",
    {
      title: "Generate Full Asset Plan (FULL_ASSET_PLAN.md)",
      description: `Generate a comprehensive FULL_ASSET_PLAN.md from GAME_DESIGN.json.
Reads GAME_DESIGN.json + asset_size_spec.json + canon_registry.json to create
a Stage 0~6 checklist with per-screen asset tables, total asset count, and estimated AI calls.

Stage overview:
  Stage 0: Canon & Foundation (logo, style reference sheet, size spec)
  Stage 1: Characters (base, poses, sprite sheets)
  Stage 2: UI Structural (panels, buttons, HUD)
  Stage 3: Backgrounds (per-screen, parallax layers)
  Stage 4: Items, Weapons & Effects
  Stage 5: Audio (BGM, SFX)
  Stage 6: Marketing (app icon, thumbnail, screenshots)

Args:
  - design_file (string, optional): Path to GAME_DESIGN.json
  - size_spec_file (string, optional): Path to asset_size_spec.json
  - output_dir (string, optional): Output directory for generated assets
  - output_plan_file (string, optional): Path for FULL_ASSET_PLAN.md (default: ./FULL_ASSET_PLAN.md)

Returns:
  Path to the generated FULL_ASSET_PLAN.md`,
      inputSchema: z.object({
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
        size_spec_file: z.string().optional().describe("Path to asset_size_spec.json"),
        output_dir: z.string().optional().describe("Output directory"),
        output_plan_file: z.string().optional().describe("Path for FULL_ASSET_PLAN.md"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const designFilePath = path.resolve(params.design_file || DEFAULT_GAME_DESIGN_FILE);

        if (!fs.existsSync(designFilePath)) {
          return {
            content: [{ type: "text" as const, text: `GAME_DESIGN.json을 찾을 수 없습니다: ${designFilePath}` }],
            isError: true,
          };
        }

        const design = JSON.parse(fs.readFileSync(designFilePath, "utf-8")) as GameDesign;

        // ── 에셋 필요도 분석 ──────────────────────────────────────────────────
        const reqs = analyzeAssetRequirements(design);
        const isNeeded = (catId: string): boolean => {
          const cat = reqs.categories.find(c => c.category_id === catId);
          return cat ? (cat.level === "required" || cat.level === "recommended") : true;
        };
        const reqLevel = (catId: string): RequirementLevel => {
          return reqs.categories.find(c => c.category_id === catId)?.level ?? "optional";
        };
        const reqBadge = (catId: string): string => {
          const l = reqLevel(catId);
          return l === "required" ? "🔴" : l === "recommended" ? "🟡" : l === "optional" ? "⚪" : "⛔";
        };

        // 크기 명세 로드
        let sizeSpecs: AssetSizeSpecFile | null = null;
        const sizeSpecPath = path.resolve(params.size_spec_file || DEFAULT_ASSET_SIZE_SPEC_FILE);
        if (fs.existsSync(sizeSpecPath)) {
          try {
            sizeSpecs = JSON.parse(fs.readFileSync(sizeSpecPath, "utf-8")) as AssetSizeSpecFile;
          } catch { /* ignore */ }
        }

        // Canon 레지스트리 로드
        const canonRegistry = loadCanonRegistry(outputDir);
        const canonCount = canonRegistry.entries.length;

        const canvas = design.canvas_size ||
          SIZE_PROFILE_CANVAS[design.size_profile || "mobile_portrait"];
        const T = sizeSpecs?.specs.base.tile_size ?? (canvas.width <= 844 ? 64 : 128);
        const SF = T * 2;

        const sz = (cat: string, key: string): string => {
          if (!sizeSpecs) return "auto";
          const specs = sizeSpecs.specs as unknown as Record<string, Record<string, SizeSpec | number>>;
          const v = specs[cat]?.[key];
          if (!v) return "auto";
          if (typeof v === "number") return `${v}px`;
          return `${v.width}×${v.height}px`;
        };

        const date = new Date().toLocaleDateString("ko-KR");
        const charCount = design.characters?.length || 0;
        const enemyCount = design.enemies?.length || 0;
        const weaponCount = design.weapons?.length || 0;
        const itemCount = design.items?.length || 0;
        const screenCount = design.screens?.length || 0;
        const effectCount = design.effects?.length || 0;
        const hasSounds = !!(design.sounds?.bgm_tracks?.length || design.sounds?.sfx_list?.length);
        const hasMarketing = !!(design.marketing?.generate_logo || design.marketing?.generate_thumbnail);

        // 에셋 수는 필요도 분석 후 재계산 (아래 actualStage*Assets 변수 사용)

        // ── 필요도 분석 기반 에셋 목록 빌드 ─────────────────────────────────────
        // 각 캐릭터별 포함할 행 결정
        const needMovement = isNeeded("sprite_movement");
        const needCombat   = isNeeded("sprite_combat");
        const needParallax = isNeeded("parallax_bg");
        const needTileset  = isNeeded("tileset");
        const needHudCombat = isNeeded("hud_combat");
        const needWeaponIcons = isNeeded("weapon_icons");
        const needInventory = isNeeded("inventory");
        const needPortraits = isNeeded("portraits");
        const needCharCard  = isNeeded("char_cards");
        const needCharSelect = isNeeded("char_select_screen");
        const needTutorial  = isNeeded("tutorial_overlays");

        // 캐릭터 행 빌드
        const charRows: string[] = [];
        let charRowIdx = 0;
        (design.characters || []).forEach((char) => {
          charRowIdx++;
          charRows.push(`| ${charRowIdx} | ${char.name} | Base Master (Canon) | ${sz("characters", "base_master")} | \`asset_generate_character_base\` | ⬜ |`);
          charRowIdx++;
          charRows.push(`| ${charRowIdx} | ${char.name} | Idle Pose | ${sz("characters", "sprite_frame")} | \`asset_generate_character_pose\` | ⬜ |`);
          if (needMovement) {
            charRowIdx++;
            charRows.push(`| ${charRowIdx} | ${char.name} | Walk/Run Sprite Sheet ${reqBadge("sprite_movement")} | ${sz("characters", "sprite_frame")} | \`asset_generate_action_sprite\` | ⬜ |`);
          }
          if (needCombat) {
            charRowIdx++;
            charRows.push(`| ${charRowIdx} | ${char.name} | Attack/Hurt/Die Sheet ${reqBadge("sprite_combat")} | ${sz("characters", "sprite_frame")} | \`asset_generate_action_sprite\` | ⬜ |`);
          }
          if (needPortraits) {
            charRowIdx++;
            charRows.push(`| ${charRowIdx} | ${char.name} | Portrait (Full/Bust) ${reqBadge("portraits")} | ${sz("characters", "portrait_full")} | \`asset_generate_character_base\` | ⬜ |`);
          }
        });
        // 적 행 빌드
        (design.enemies || []).forEach((enemy) => {
          charRowIdx++;
          charRows.push(`| ${charRowIdx} | ${enemy.id} (enemy) | Base Master | ${sz("characters", "base_master")} | \`asset_generate_character_base\` | ⬜ |`);
          if (needMovement) {
            charRowIdx++;
            charRows.push(`| ${charRowIdx} | ${enemy.id} (enemy) | Walk Sheet ${reqBadge("sprite_movement")} | ${sz("characters", "sprite_frame")} | \`asset_generate_action_sprite\` | ⬜ |`);
          }
          if (needCombat) {
            charRowIdx++;
            charRows.push(`| ${charRowIdx} | ${enemy.id} (enemy) | Attack/Hurt/Die Sheet ${reqBadge("sprite_combat")} | ${sz("characters", "sprite_frame")} | \`asset_generate_action_sprite\` | ⬜ |`);
          }
        });

        // Stage 1 실제 에셋 수 재계산
        const actualStage1Assets = charRowIdx;

        // UI 행 빌드
        const uiRows: string[] = [];
        let uiIdx = 0;
        uiIdx++; uiRows.push(`| ${uiIdx} | Panel (9-slice) 🔴 | ${sz("ui", "popup_panel")} | \`asset_generate_ui_structural\` | CODE | ⬜ |`);
        uiIdx++; uiRows.push(`| ${uiIdx} | Button Set (normal/pressed/disabled) 🔴 | ${sz("ui", "button_md")} | \`asset_generate_ui_structural\` | CODE | ⬜ |`);
        uiIdx++; uiRows.push(`| ${uiIdx} | Progress Bar 🔴 | ${sz("ui", "button_sm")} | \`asset_generate_ui_structural\` | CODE | ⬜ |`);
        if (needHudCombat) {
          uiIdx++; uiRows.push(`| ${uiIdx} | HUD Set (HP/Stamina/Ammo) ${reqBadge("hud_combat")} | ${sz("ui", "icon_md")} | \`asset_generate_hud_set\` | AI | ⬜ |`);
        } else {
          uiIdx++; uiRows.push(`| ${uiIdx} | HUD Set (Basic) ${reqBadge("ui_basic")} | ${sz("ui", "icon_md")} | \`asset_generate_hud_set\` | AI | ⬜ |`);
        }
        uiIdx++; uiRows.push(`| ${uiIdx} | Icon Set 🔴 | ${sz("ui", "icon_sm")} | \`asset_generate_icon_set\` | AI | ⬜ |`);
        uiIdx++; uiRows.push(`| ${uiIdx} | Popup/Dialog 🔴 | ${sz("ui", "popup_panel")} | \`asset_generate_popup_set\` | AI | ⬜ |`);
        if (needCharSelect) {
          uiIdx++; uiRows.push(`| ${uiIdx} | Character Select Screen ${reqBadge("char_select_screen")} | ${sz("backgrounds", "full")} | \`asset_generate_image\` | AI | ⬜ |`);
        }
        if (needTutorial) {
          uiIdx++; uiRows.push(`| ${uiIdx} | Tutorial Overlay ${reqBadge("tutorial_overlays")} | ${sz("backgrounds", "full")} | \`asset_generate_image\` | AI | ⬜ |`);
        }
        if (needCharCard) {
          uiIdx++; uiRows.push(`| ${uiIdx} | Character Card UI ${reqBadge("char_cards")} | ${sz("characters", "char_card")} | \`asset_generate_image\` | AI | ⬜ |`);
        }
        const actualStage2Assets = uiIdx;

        // Background 행 빌드
        const bgRows: string[] = [];
        let bgIdx = 0;
        (design.screens || []).forEach((screen) => {
          bgIdx++;
          bgRows.push(`| ${bgIdx} | ${screen.name} | Full BG 🔴 | ${sz("backgrounds", "full")} | \`asset_generate_screen_background\` | ⬜ |`);
          if (needParallax) {
            bgIdx++;
            bgRows.push(`| ${bgIdx} | ${screen.name} | Parallax Far ${reqBadge("parallax_bg")} | ${sz("backgrounds", "parallax_far")} | \`asset_generate_screen_background\` | ⬜ |`);
            bgIdx++;
            bgRows.push(`| ${bgIdx} | ${screen.name} | Parallax Mid ${reqBadge("parallax_bg")} | ${sz("backgrounds", "parallax_mid")} | \`asset_generate_screen_background\` | ⬜ |`);
            bgIdx++;
            bgRows.push(`| ${bgIdx} | ${screen.name} | Parallax Near ${reqBadge("parallax_bg")} | ${sz("backgrounds", "parallax_near")} | \`asset_generate_screen_background\` | ⬜ |`);
          }
        });
        if (needTileset) {
          bgIdx++;
          bgRows.push(`| ${bgIdx} | Tileset Sheet ${reqBadge("tileset")} | ${sz("tiles", "tileset")} | \`asset_generate_image\` | AI | ⬜ |`);
        }
        const actualStage3Assets = bgIdx;

        // Stage 4 행 빌드
        const s4Rows: string[] = [];
        let s4Idx = 0;
        if (needWeaponIcons) {
          (design.weapons || []).forEach((w) => {
            s4Idx++;
            s4Rows.push(`| ${s4Idx} | ${w.name} (weapon) ${reqBadge("weapon_icons")} | ${sz("characters", "portrait_thumb")} | \`asset_generate_weapons\` | ⬜ |`);
          });
        }
        if (needInventory) {
          (design.items || []).forEach((item) => {
            s4Idx++;
            s4Rows.push(`| ${s4Idx} | ${item.name} (item) ${reqBadge("inventory")} | ${sz("ui", "icon_md")} | \`asset_generate_image\` | ⬜ |`);
          });
        } else if (!needWeaponIcons) {
          // weapon_icons도 없고 inventory도 없어도 items는 선택적으로 포함
          (design.items || []).forEach((item) => {
            s4Idx++;
            s4Rows.push(`| ${s4Idx} | ${item.name} (item) ⚪ | ${sz("ui", "icon_md")} | \`asset_generate_image\` | ⬜ |`);
          });
        }
        (design.effects || []).forEach((effect) => {
          s4Idx++;
          s4Rows.push(`| ${s4Idx} | ${effect.id} (effect, ${effect.frames}f) ⚪ | ${sz("effects", "md")} | \`asset_generate_sprite_sheet\` | ⬜ |`);
        });
        const actualStage4Assets = s4Idx;

        // 제외된 카테고리 목록
        const excludedCats = reqs.categories
          .filter(c => c.level === "not_needed")
          .map(c => `- ⛔ **${c.category_name}** (${c.category_id}): ${c.reason || "이 게임 타입에 불필요"}`);

        // 재계산된 총 에셋 수
        const actualStage5Assets = (design.sounds?.bgm_tracks?.length || 0) + (design.sounds?.sfx_list?.length || 0);
        const actualStage6Assets = hasMarketing ? 5 : 0;
        const actualTotalAssets = 3 + actualStage1Assets + actualStage2Assets + actualStage3Assets + actualStage4Assets + actualStage5Assets + actualStage6Assets;
        const actualEstimatedAICalls = Math.ceil(actualTotalAssets * 0.8);

        // ── 메카닉 요약 헤더 ──────────────────────────────────────────────────────
        const mechanicsSummary = [
          `> **활성 메카닉** (${reqs.active_mechanics.length}개): ${reqs.active_mechanics.map(m => `\`${m}\``).join(", ") || "없음"}`,
          ...(reqs.inference_reasons?.length
            ? [`> **자동 추론 근거**: ${reqs.inference_reasons.slice(0, 5).join(" | ")}`]
            : []),
          `> **에셋 필터**: 🔴 필수 ${reqs.summary.required}개 · 🟡 권장 ${reqs.summary.recommended}개 · ⚪ 선택 ${reqs.summary.optional}개 · ⛔ 불필요 ${reqs.summary.not_needed}개`,
        ];

        // FULL_ASSET_PLAN.md 마크다운 생성
        const lines: string[] = [
          `# FULL_ASSET_PLAN.md`,
          `> Generated: ${date} | Game: ${design.game_name} | Canvas: ${canvas.width}×${canvas.height} | T=${T} SF=${SF}`,
          `> Canon entries registered: ${canonCount} | Total estimated assets: ${actualTotalAssets} | Estimated AI calls: ${actualEstimatedAICalls}`,
          ...mechanicsSummary,
          "",
          "---",
          "",
          "## Stage 0 — Canon & Foundation",
          `> 목표: 마스터 레퍼런스 에셋 확립. 모든 이후 Stage는 이 Canon을 기준으로 생성.`,
          "",
          "| # | Asset | Size | Tool | Status |",
          "|---|-------|------|------|--------|",
          `| 1 | Game Logo (Canon) 🔴 | 1024×1024 | \`asset_generate_app_logo\` | ⬜ |`,
          `| 2 | asset_size_spec.json 🔴 | — | \`asset_generate_size_spec\` | ${sizeSpecs ? "✅" : "⬜"} |`,
          `| 3 | Style Reference Sheet 🔴 | auto | \`asset_generate_style_reference_sheet\` | ⬜ |`,
          "",
          "---",
          "",
          "## Stage 1 — Characters",
          `> Base masters → 포즈 검토 → 스프라이트 시트 순으로 진행 (Pose-First 패턴).`,
          ...(needMovement ? [] : [`> ⚠️ sprite_movement 비활성: Walk/Run 스프라이트 제외됨`]),
          ...(needCombat ? [] : [`> ⚠️ sprite_combat 비활성: Attack/Hurt/Die 스프라이트 제외됨`]),
          "",
          "| # | Character | Asset | Size | Tool | Status |",
          "|---|-----------|-------|------|------|--------|",
          ...charRows,
          "",
          "---",
          "",
          "## Stage 2 — UI",
          "> structural(코드 생성) → decorative/button/hud → popup 순으로 진행.",
          "",
          "| # | Asset | Size | Tool | Type | Status |",
          "|---|-------|------|------|------|--------|",
          ...uiRows,
          "",
          "---",
          "",
          "## Stage 3 — Backgrounds",
          "> 각 스크린별 배경 + 패럴랙스 레이어.",
          ...(needParallax ? [] : [`> ⚠️ parallax_bg 비활성: 패럴랙스 레이어 제외됨`]),
          ...(needTileset ? [`> 타일셋 포함 (${reqBadge("tileset")} tileset 활성화됨)`] : []),
          "",
          "| # | Screen | Layer | Size | Tool | Status |",
          "|---|--------|-------|------|------|--------|",
          ...bgRows,
          "",
          "---",
          "",
          "## Stage 4 — Items, Weapons & Effects",
          ...(needWeaponIcons ? [] : [`> ⚠️ weapon_icons 비활성: 무기 아이콘 제외됨`]),
          ...(needInventory ? [] : [`> ⚠️ inventory 비활성: 아이템 아이콘 제외됨`]),
          "",
          "| # | Asset | Size | Tool | Status |",
          "|---|-------|------|------|--------|",
          ...s4Rows,
          "",
          "---",
          "",
          ...(hasSounds ? [
            "## Stage 5 — Audio",
            "",
            "| # | Track | Type | Tool | Status |",
            "|---|-------|------|------|--------|",
            ...(design.sounds?.bgm_tracks || []).map((t, i) =>
              `| ${i + 1} | ${t} | BGM 🔴 | \`asset_generate_music_local\` | ⬜ |`
            ),
            ...(design.sounds?.sfx_list || []).map((t, i) =>
              `| ${(design.sounds?.bgm_tracks?.length || 0) + i + 1} | ${t} | SFX 🔴 | \`asset_generate_music_local\` | ⬜ |`
            ),
            "",
            "---",
            "",
          ] : []),
          ...(hasMarketing ? [
            "## Stage 6 — Marketing",
            "",
            "| # | Asset | Size | Tool | Status |",
            "|---|-------|------|------|--------|",
            `| 1 | App Icon 🟡 | 1024×1024 | \`asset_generate_app_logo\` | ⬜ |`,
            `| 2 | Game Thumbnail 🟡 | ${sz("marketing", "thumbnail")} | \`asset_generate_thumbnail\` | ⬜ |`,
            `| 3 | iOS Screenshot ⚪ | 390×844 | \`asset_generate_image\` | ⬜ |`,
            `| 4 | Android Screenshot ⚪ | 1080×1920 | \`asset_generate_image\` | ⬜ |`,
            `| 5 | Google Play Banner ⚪ | 1024×500 | \`asset_generate_image\` | ⬜ |`,
            "",
            "---",
            "",
          ] : []),
          ...(excludedCats.length > 0 ? [
            "## ⛔ 이 게임에 불필요하여 제외된 카테고리",
            "",
            ...excludedCats,
            "",
            "---",
            "",
          ] : []),
          "## Summary",
          "",
          `| Stage | Assets | Status |`,
          `|-------|--------|--------|`,
          `| Stage 0: Canon | 3 | ⬜ |`,
          `| Stage 1: Characters | ${actualStage1Assets} | ⬜ |`,
          `| Stage 2: UI | ${actualStage2Assets} | ⬜ |`,
          `| Stage 3: Backgrounds | ${actualStage3Assets} | ⬜ |`,
          `| Stage 4: Items & Effects | ${actualStage4Assets} | ⬜ |`,
          `| Stage 5: Audio | ${actualStage5Assets} | ⬜ |`,
          `| Stage 6: Marketing | ${actualStage6Assets} | ⬜ |`,
          `| **Total** | **${actualTotalAssets}** | |`,
          "",
          `> Estimated AI calls: ~${actualEstimatedAICalls} (structural UI is code-generated, no AI)`,
          `> 범례: 🔴 필수 | 🟡 권장 | ⚪ 선택 | ⛔ 불필요(제외)`,
        ];

        const mdContent = lines.join("\n");
        const planFile = path.resolve(params.output_plan_file || "./.minigame-assets/FULL_ASSET_PLAN.md");
        ensureDir(path.dirname(planFile));
        fs.writeFileSync(planFile, mdContent, "utf-8");

        return {
          content: [{ type: "text" as const, text: JSON.stringify({
            success: true,
            plan_file: planFile,
            game_name: design.game_name,
            active_mechanics: reqs.active_mechanics,
            requirements_summary: reqs.summary,
            total_assets: actualTotalAssets,
            estimated_ai_calls: actualEstimatedAICalls,
            stage_summary: {
              stage0_canon: 3,
              stage1_characters: actualStage1Assets,
              stage2_ui: actualStage2Assets,
              stage3_backgrounds: actualStage3Assets,
              stage4_items_effects: actualStage4Assets,
              stage5_audio: actualStage5Assets,
              stage6_marketing: actualStage6Assets,
            },
            excluded_categories: excludedCats.length,
          }, null, 2) }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Generate Full Plan") }],
          isError: true,
        };
      }
    }
  );
}
