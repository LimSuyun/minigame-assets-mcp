import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_CONCEPT_FILE, DEFAULT_CONCEPT_MD_FILE, DEFAULT_OUTPUT_DIR } from "../constants.js";
import { ensureDir } from "../utils/files.js";
import type { GameConcept } from "../types.js";

function loadConcept(conceptFile: string): GameConcept | null {
  const resolved = path.resolve(conceptFile);
  if (!fs.existsSync(resolved)) return null;
  return JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameConcept;
}

function saveConcept(concept: GameConcept, conceptFile: string): void {
  const resolved = path.resolve(conceptFile);
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, JSON.stringify(concept, null, 2));
}

// ─── CONCEPT.md 생성 헬퍼 ─────────────────────────────────────────────────────

interface CharacterEntry {
  id: string;
  type: "player" | "enemy" | "boss" | "npc";
  name: string;
  description: string;
  actions: string[];
}

interface WeaponEntry {
  id: string;
  name: string;
  description: string;
}

interface BackgroundEntry {
  id: string;
  name: string;
  description: string;
}

function buildConceptMd(params: {
  game_name: string;
  genre: string;
  theme: string;
  description: string;
  target_platform: string;
  art_style: string;
  color_palette: string[];
  visual_references?: string[];
  music_style?: string;
  base_style_prompt: string;
  characters: CharacterEntry[];
  weapons: WeaponEntry[];
  backgrounds: BackgroundEntry[];
}): string {
  const now = new Date().toISOString().split("T")[0];

  const charRows = params.characters.map(
    (c) =>
      `| ${c.id} | ${c.type} | ${c.name} | ${c.description} | ${c.actions.join(", ")} |`
  );

  const weaponRows = params.weapons.map(
    (w) => `| ${w.id} | ${w.name} | ${w.description} |`
  );

  const bgRows = params.backgrounds.map(
    (b) => `| ${b.id} | ${b.name} | ${b.description} |`
  );

  return `# ${params.game_name} - Game Concept
> 생성일: ${now}

---

## 게임 정보

| 항목 | 내용 |
|------|------|
| **장르** | ${params.genre} |
| **테마** | ${params.theme} |
| **플랫폼** | ${params.target_platform} |
| **설명** | ${params.description} |
${params.music_style ? `| **음악 스타일** | ${params.music_style} |\n` : ""}
---

## 아트 스타일

- **스타일**: ${params.art_style}
- **색상 팔레트**: ${params.color_palette.join(", ")}
${params.visual_references && params.visual_references.length > 0
  ? `- **레퍼런스**: ${params.visual_references.join(", ")}`
  : ""}

---

## BASE STYLE PROMPT

> 모든 이미지 생성 시 이 프롬프트를 앞에 추가합니다.

\`\`\`
${params.base_style_prompt}
\`\`\`

---

## 에셋 목록

### 캐릭터 (Characters)

| ID | 타입 | 이름 | 설명 | 액션 |
|----|------|------|------|------|
${charRows.join("\n")}

### 무기 (Weapons)

| ID | 이름 | 설명 |
|----|------|------|
${weaponRows.join("\n")}

### 배경 (Backgrounds)

| ID | 이름 | 설명 |
|----|------|------|
${bgRows.join("\n")}

---

## 생성 가이드

### 캐릭터 생성 순서
1. \`asset_generate_character_base\` — gpt-image-1, 투명 배경으로 정면 서 있는 캐릭터 생성
2. \`asset_generate_sprite_sheet\` — Gemini로 각 액션(${params.characters[0]?.actions?.join(", ") || "idle, walk, attack, die"})별 프레임 생성

### 무기 생성 순서
1. \`asset_generate_weapons\` — gpt-image-1, 투명 배경으로 무기 아이콘 생성

### 배경 생성 순서
1. \`asset_generate_image_gemini\` — asset_type: background, 배경 이미지 생성
`;
}

export function registerConceptTools(server: McpServer): void {
  // ── Create/Update Game Concept ──────────────────────────────────────────────
  server.registerTool(
    "asset_create_concept",
    {
      title: "Create Game Concept",
      description: `Create or update a game visual and audio concept that guides all asset generation.

This tool stores a style guide JSON file that subsequent asset generation tools will reference to maintain visual/audio consistency across all generated game assets.

Args:
  - game_name (string): Name of the game
  - genre (string): Game genre (e.g., "platformer", "RPG", "puzzle", "shooter")
  - art_style (string): Visual art style description (e.g., "pixel art 16-bit", "hand-drawn cartoon", "dark fantasy 3D")
  - color_palette (string[]): List of colors defining the palette (e.g., ["#1a1a2e", "#16213e", "#e94560"])
  - description (string): Overall visual feel and atmosphere of the game
  - theme (string): Core themes (e.g., "space exploration", "medieval fantasy", "cyberpunk city")
  - target_platform (string, optional): Target platform (e.g., "mobile", "PC", "web")
  - visual_references (string[], optional): Reference games or art styles for inspiration
  - music_style (string, optional): Music genre/style (e.g., "chiptune", "orchestral", "electronic")
  - concept_file (string, optional): Path to save concept file (default: ./game-concept.json)

Returns:
  JSON with the saved concept details and file path.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("Name of the game"),
        genre: z.string().min(1).max(100).describe("Game genre (e.g., platformer, RPG, puzzle)"),
        art_style: z.string().min(1).max(500).describe("Visual art style (e.g., pixel art 16-bit, hand-drawn cartoon)"),
        color_palette: z.array(z.string()).min(1).max(20).describe("Color palette as hex codes or color names"),
        description: z.string().min(10).max(2000).describe("Overall visual feel and atmosphere"),
        theme: z.string().min(1).max(500).describe("Core themes of the game"),
        target_platform: z.string().optional().describe("Target platform (mobile, PC, web, console)"),
        visual_references: z.array(z.string()).optional().describe("Reference games or art styles for inspiration"),
        music_style: z.string().optional().describe("Music genre/style (chiptune, orchestral, ambient)"),
        concept_file: z.string().optional().describe("Path to save concept JSON file"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const conceptFile = params.concept_file || DEFAULT_CONCEPT_FILE;
      const now = new Date().toISOString();
      const existing = loadConcept(conceptFile);

      const concept: GameConcept = {
        game_name: params.game_name,
        genre: params.genre,
        art_style: params.art_style,
        color_palette: params.color_palette,
        description: params.description,
        theme: params.theme,
        target_platform: params.target_platform,
        visual_references: params.visual_references,
        music_style: params.music_style,
        created_at: existing?.created_at || now,
        updated_at: now,
      };

      saveConcept(concept, conceptFile);

      const output = {
        success: true,
        concept_file: path.resolve(conceptFile),
        concept,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── Get Game Concept ────────────────────────────────────────────────────────
  server.registerTool(
    "asset_get_concept",
    {
      title: "Get Game Concept",
      description: `Retrieve the current game concept/style guide.

Returns the game concept JSON that defines the visual and audio style for asset generation.
If no concept exists, returns null with a suggestion to create one first.

Args:
  - concept_file (string, optional): Path to the concept JSON file (default: ./game-concept.json)

Returns:
  The game concept object or null if not found.`,
      inputSchema: z.object({
        concept_file: z.string().optional().describe("Path to the concept JSON file"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const conceptFile = params.concept_file || DEFAULT_CONCEPT_FILE;
      const concept = loadConcept(conceptFile);

      if (!concept) {
        const output = {
          found: false,
          message: `No game concept found at ${path.resolve(conceptFile)}. Use asset_create_concept to create one first.`,
          concept: null,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const output = { found: true, concept_file: path.resolve(conceptFile), concept };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── List Generated Assets ───────────────────────────────────────────────────
  server.registerTool(
    "asset_list_assets",
    {
      title: "List Generated Assets",
      description: `List all generated game assets from the asset registry.

Args:
  - asset_type (string, optional): Filter by type: "image", "music", "video", or "all" (default: "all")
  - output_dir (string, optional): Directory where assets are stored (default: ./generated-assets)
  - limit (number, optional): Maximum number of assets to return (default: 50)
  - offset (number, optional): Number of assets to skip (default: 0)

Returns:
  Paginated list of generated assets with file paths and metadata.`,
      inputSchema: z.object({
        asset_type: z.enum(["image", "music", "video", "all"]).default("all").describe("Filter by asset type"),
        output_dir: z.string().optional().describe("Assets output directory"),
        limit: z.number().int().min(1).max(200).default(50).describe("Max results to return"),
        offset: z.number().int().min(0).default(0).describe("Pagination offset"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const registryPath = path.resolve(outputDir, "assets-registry.json");

      if (!fs.existsSync(registryPath)) {
        const output = {
          total: 0,
          count: 0,
          offset: params.offset,
          assets: [],
          has_more: false,
          message: `No assets registry found at ${registryPath}. Generate assets first.`,
        };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      }

      const registry = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
        assets: Array<{ type: string; [key: string]: unknown }>;
        last_updated: string;
      };

      const filtered =
        params.asset_type === "all"
          ? registry.assets
          : registry.assets.filter((a) => a.type === params.asset_type);

      const paginated = filtered.slice(params.offset, params.offset + params.limit);

      const output = {
        total: filtered.length,
        count: paginated.length,
        offset: params.offset,
        assets: paginated,
        has_more: filtered.length > params.offset + paginated.length,
        next_offset:
          filtered.length > params.offset + paginated.length
            ? params.offset + paginated.length
            : undefined,
        last_updated: registry.last_updated,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── Create Game Concept (Markdown) ─────────────────────────────────────────
  server.registerTool(
    "asset_create_concept_md",
    {
      title: "Create Game Concept Markdown",
      description: `게임 컨셉, 에셋 목록, 스타일 가이드를 CONCEPT.md 마크다운 파일로 생성합니다.

이 도구는 모든 에셋 생성 작업의 첫 번째 단계입니다. 생성된 CONCEPT.md에는:
- 게임 기본 정보 (장르, 테마, 플랫폼)
- 아트 스타일 + 색상 팔레트
- BASE STYLE PROMPT (모든 이미지 생성 시 공통으로 사용)
- 캐릭터 목록 (타입, 필요 액션 포함)
- 무기 목록
- 배경 목록
- 생성 가이드 (프로세스 순서)

Args:
  - game_name: 게임 이름
  - genre: 게임 장르
  - theme: 게임 테마
  - description: 전체 게임 설명
  - target_platform: 타겟 플랫폼 (mobile, PC, web 등)
  - art_style: 비주얼 아트 스타일
  - color_palette: 색상 팔레트 (hex 코드 배열)
  - base_style_prompt: 모든 이미지에 공통 적용할 스타일 프롬프트
  - characters: 캐릭터 목록 [{id, type, name, description, actions}]
  - weapons: 무기 목록 [{id, name, description}]
  - backgrounds: 배경 목록 [{id, name, description}]
  - visual_references: 레퍼런스 게임/스타일 (선택)
  - music_style: 음악 스타일 (선택)
  - output_file: CONCEPT.md 저장 경로 (기본: ./CONCEPT.md)

Returns:
  생성된 CONCEPT.md 파일 경로와 에셋 통계.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름"),
        genre: z.string().min(1).max(100).describe("게임 장르 (예: casual defense shooter, RPG, puzzle)"),
        theme: z.string().min(1).max(500).describe("게임 테마 (예: Korean supernatural, cyberpunk)"),
        description: z.string().min(10).max(2000).describe("전체 게임 설명 및 분위기"),
        target_platform: z.string().default("mobile").describe("타겟 플랫폼 (mobile, PC, web)"),
        art_style: z.string().min(1).max(500).describe("비주얼 아트 스타일"),
        color_palette: z.array(z.string()).min(1).max(20).describe("색상 팔레트 (hex 코드 배열)"),
        base_style_prompt: z.string().min(10).max(2000).describe("모든 이미지에 공통 적용할 베이스 스타일 프롬프트 (영문)"),
        characters: z.array(z.object({
          id: z.string().describe("캐릭터 식별자 (파일명 기반, 예: hero_male, dokkaebi)"),
          type: z.enum(["player", "enemy", "boss", "npc"]).describe("캐릭터 타입"),
          name: z.string().describe("캐릭터 표시 이름"),
          description: z.string().describe("캐릭터 외형 설명 (영문 프롬프트용)"),
          actions: z.array(z.string()).describe("필요 액션 목록 (예: [idle, walk, run, attack, die])"),
        })).describe("캐릭터 목록"),
        weapons: z.array(z.object({
          id: z.string().describe("무기 식별자"),
          name: z.string().describe("무기 이름"),
          description: z.string().describe("무기 설명 (영문 프롬프트용)"),
        })).default([]).describe("무기 목록"),
        backgrounds: z.array(z.object({
          id: z.string().describe("배경 식별자"),
          name: z.string().describe("배경 이름"),
          description: z.string().describe("배경 설명 (영문 프롬프트용)"),
        })).default([]).describe("배경 목록"),
        visual_references: z.array(z.string()).optional().describe("레퍼런스 게임/스타일"),
        music_style: z.string().optional().describe("음악 스타일"),
        output_file: z.string().optional().describe("CONCEPT.md 저장 경로 (기본: ./CONCEPT.md)"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const outputFile = params.output_file || DEFAULT_CONCEPT_MD_FILE;
      const resolved = path.resolve(outputFile);
      ensureDir(path.dirname(resolved));

      const content = buildConceptMd({
        game_name: params.game_name,
        genre: params.genre,
        theme: params.theme,
        description: params.description,
        target_platform: params.target_platform,
        art_style: params.art_style,
        color_palette: params.color_palette,
        visual_references: params.visual_references,
        music_style: params.music_style,
        base_style_prompt: params.base_style_prompt,
        characters: params.characters,
        weapons: params.weapons,
        backgrounds: params.backgrounds,
      });

      fs.writeFileSync(resolved, content, "utf-8");

      // 동시에 game-concept.json도 업데이트 (기존 도구 호환성)
      const conceptJson: GameConcept = {
        game_name: params.game_name,
        genre: params.genre,
        art_style: params.art_style,
        color_palette: params.color_palette,
        description: params.description,
        theme: params.theme,
        target_platform: params.target_platform,
        visual_references: params.visual_references,
        music_style: params.music_style,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const jsonPath = path.resolve(DEFAULT_CONCEPT_FILE);
      ensureDir(path.dirname(jsonPath));
      fs.writeFileSync(jsonPath, JSON.stringify(conceptJson, null, 2));

      const output = {
        success: true,
        concept_md_file: resolved,
        concept_json_file: jsonPath,
        stats: {
          characters: params.characters.length,
          weapons: params.weapons.length,
          backgrounds: params.backgrounds.length,
          total_assets: params.characters.length + params.weapons.length + params.backgrounds.length,
        },
        next_steps: [
          "1. asset_generate_execution_plan — 게임 엔진 파악 및 실행 계획 생성",
          "2. asset_generate_character_base — 각 캐릭터 정면 베이스 생성 (gpt-image-1, 투명 배경)",
          "3. asset_generate_sprite_sheet — 각 캐릭터 액션 스프라이트 생성 (Gemini)",
          "4. asset_generate_weapons — 무기 아이콘 생성 (gpt-image-1, 투명 배경)",
          "5. asset_generate_image_gemini — 배경 이미지 생성",
        ],
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );
}
