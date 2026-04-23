/**
 * workflow.ts — 실행 계획 및 일괄 워크플로우 도구
 *
 * 도구 목록:
 *  - asset_generate_execution_plan : CONCEPT.md + 게임 엔진 분석 → EXECUTION-PLAN.md
 *  - asset_generate_weapons        : 무기 목록을 gpt-image-1 투명 배경으로 일괄 생성
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import {
  DEFAULT_CONCEPT_MD_FILE,
  DEFAULT_EXECUTION_PLAN_FILE,
  DEFAULT_OUTPUT_DIR,
} from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import {
  buildAssetPath,
  generateFileName,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { addPadding } from "../utils/image-process.js";
import { handleApiError } from "../utils/errors.js";
import {
  collectFiles,
  detectEngine,
  detectAssetDirectories,
  getEngineRecommendations,
} from "../utils/project-scanner.js";
import type { GeneratedAsset } from "../types.js";

// ─── CONCEPT.md 파서 ──────────────────────────────────────────────────────────

interface ConceptMdParsed {
  game_name: string;
  genre: string;
  theme: string;
  platform: string;
  art_style: string;
  color_palette: string;
  base_style_prompt: string;
  characters: Array<{ id: string; type: string; name: string; actions: string[] }>;
  weapons: Array<{ id: string; name: string }>;
  backgrounds: Array<{ id: string; name: string }>;
}

function parseConceptMd(content: string): ConceptMdParsed {
  // BASE STYLE PROMPT 코드블록 추출
  const baseStyleMatch = content.match(/## BASE STYLE PROMPT[\s\S]*?```\s*\n([\s\S]*?)```/);
  const base_style_prompt = baseStyleMatch ? baseStyleMatch[1].trim() : "";

  // 게임 정보 테이블 파싱
  const getTableValue = (label: string): string => {
    const re = new RegExp(`\\*\\*${label}\\*\\*\\s*\\|\\s*([^|\\n]+)`);
    const m = content.match(re);
    return m ? m[1].trim() : "";
  };

  const game_name = (content.match(/^# (.+?) - Game Concept/m) || [])[1]?.trim() || "";
  const genre = getTableValue("장르");
  const theme = getTableValue("테마");
  const platform = getTableValue("플랫폼");

  // 아트 스타일
  const art_style_match = content.match(/- \*\*스타일\*\*: (.+)/);
  const art_style = art_style_match ? art_style_match[1].trim() : "";

  // 색상 팔레트
  const palette_match = content.match(/- \*\*색상 팔레트\*\*: (.+)/);
  const color_palette = palette_match ? palette_match[1].trim() : "";

  // 캐릭터 테이블 파싱
  const characters: ConceptMdParsed["characters"] = [];
  const charSectionMatch = content.match(/### 캐릭터[^#]*\n\|[^\n]+\|\n\|[-| ]+\|\n((?:\|[^\n]+\|\n)*)/);
  if (charSectionMatch) {
    const rows = charSectionMatch[1].trim().split("\n");
    for (const row of rows) {
      const cols = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 5) {
        characters.push({
          id: cols[0],
          type: cols[1],
          name: cols[2],
          actions: cols[4].split(",").map((a) => a.trim()).filter(Boolean),
        });
      }
    }
  }

  // 무기 테이블 파싱
  const weapons: ConceptMdParsed["weapons"] = [];
  const weaponSectionMatch = content.match(/### 무기[^#]*\n\|[^\n]+\|\n\|[-| ]+\|\n((?:\|[^\n]+\|\n)*)/);
  if (weaponSectionMatch) {
    const rows = weaponSectionMatch[1].trim().split("\n");
    for (const row of rows) {
      const cols = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        weapons.push({ id: cols[0], name: cols[1] });
      }
    }
  }

  // 배경 테이블 파싱
  const backgrounds: ConceptMdParsed["backgrounds"] = [];
  const bgSectionMatch = content.match(/### 배경[^#]*\n\|[^\n]+\|\n\|[-| ]+\|\n((?:\|[^\n]+\|\n)*)/);
  if (bgSectionMatch) {
    const rows = bgSectionMatch[1].trim().split("\n");
    for (const row of rows) {
      const cols = row.split("|").map((c) => c.trim()).filter(Boolean);
      if (cols.length >= 2) {
        backgrounds.push({ id: cols[0], name: cols[1] });
      }
    }
  }

  return { game_name, genre, theme, platform, art_style, color_palette, base_style_prompt, characters, weapons, backgrounds };
}

// ─── 실행 계획 마크다운 생성 ───────────────────────────────────────────────────

function buildExecutionPlanMd(
  concept: ConceptMdParsed,
  engine: string,
  exportFormats: string[],
  outputDir: string
): string {
  const now = new Date().toISOString().split("T")[0];
  const formatList = exportFormats.length > 0 ? exportFormats.join(", ") : "individual";

  const charSteps = concept.characters.map((c, i) => {
    const actionList = c.actions.join(", ");
    return (
      `#### ${i + 1}. ${c.name} (${c.id}) — 타입: ${c.type}\n` +
      `- [ ] **베이스 생성**: \`asset_generate_character_base\` — provider: openai, model: gpt-image-2 (기본), magenta 크로마키 자동 적용 → 투명 PNG\n` +
      `  - character_name: \`${c.id}\`\n` +
      `- [ ] **스프라이트 생성**: \`asset_generate_sprite_sheet\` — provider: openai, model: gpt-image-2, chroma_key_bg: magenta (각 액션별 편집)\n` +
      `  - actions: [${actionList}]\n` +
      `  - export_formats: [${formatList}]`
    );
  }).join("\n\n");

  const weaponSteps = concept.weapons.length > 0
    ? concept.weapons.map((w, i) =>
        `- [ ] **${i + 1}. ${w.name} (${w.id})**: \`asset_generate_weapons\` — gpt-image-1, transparent background`
      ).join("\n")
    : "- 무기 없음";

  const bgSteps = concept.backgrounds.length > 0
    ? concept.backgrounds.map((b, i) =>
        `- [ ] **${i + 1}. ${b.name} (${b.id})**: \`asset_generate_image_gemini\` — asset_type: background`
      ).join("\n")
    : "- 배경 없음";

  return `# ${concept.game_name} - 에셋 생성 실행 계획
> 생성일: ${now}

---

## 프로젝트 정보

| 항목 | 내용 |
|------|------|
| **게임 엔진** | ${engine} |
| **에셋 출력 경로** | \`${outputDir}\` |
| **Export 포맷** | ${formatList} |
| **플랫폼** | ${concept.platform} |

---

## 에셋 통계

| 카테고리 | 개수 |
|---------|------|
| 캐릭터 | ${concept.characters.length}개 |
| 무기 | ${concept.weapons.length}개 |
| 배경 | ${concept.backgrounds.length}개 |
| **총합** | **${concept.characters.length + concept.weapons.length + concept.backgrounds.length}개** |

---

## 실행 순서

### Step 1. 컨셉 확인 ✅
- CONCEPT.md 파일 확인 완료
- BASE STYLE PROMPT 확인: \`${concept.base_style_prompt.slice(0, 60)}...\`

---

### Step 2. 캐릭터 생성

> **프로세스**: 정면 베이스 이미지(gpt-image-1) → 각 액션 스프라이트(Gemini 편집)

${charSteps}

---

### Step 3. 무기 생성

> **프로세스**: gpt-image-1로 투명 배경 아이콘 생성

${weaponSteps}

---

### Step 4. 배경 생성

> **프로세스**: Gemini Imagen으로 배경 이미지 생성

${bgSteps}

---

## 완료 체크리스트

- [ ] Step 1: CONCEPT.md 확인
- [ ] Step 2: 캐릭터 ${concept.characters.length}개 생성 (베이스 + 스프라이트)
- [ ] Step 3: 무기 ${concept.weapons.length}개 생성
- [ ] Step 4: 배경 ${concept.backgrounds.length}개 생성

---

## 참고 도구 목록

| 도구 | 용도 |
|------|------|
| \`asset_generate_character_base\` | 캐릭터 정면 베이스 생성 (gpt-image-2, 마젠타 크로마키 → 투명) |
| \`asset_generate_sprite_sheet\` | 캐릭터 액션 스프라이트 시트 (gpt-image-2) |
| \`asset_generate_weapons\` | 무기 아이콘 일괄 생성 (gpt-image-1, 투명) |
| \`asset_generate_image_gemini\` | 배경 이미지 생성 (Gemini) |
| \`asset_edit_character_design\` | 캐릭터 디자인 수정 후 자동 재생성 |
| \`asset_remove_background\` | 배경 제거 (투명 PNG) |
| \`asset_list_assets\` | 생성된 에셋 목록 조회 |
`;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerWorkflowTools(server: McpServer): void {
  // ── 실행 계획 생성 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_execution_plan",
    {
      title: "Generate Asset Execution Plan",
      description: `CONCEPT.md를 읽고 게임 엔진을 파악하여 에셋 생성 실행 계획(EXECUTION-PLAN.md)을 생성합니다.

프로세스 2단계에 해당합니다:
1. CONCEPT.md에서 게임 정보, 에셋 목록, 스타일 파싱
2. 게임 프로젝트 경로가 있으면 엔진 자동 감지 (Cocos, Unity, Phaser, Godot)
3. 엔진별 export 포맷, 출력 경로 자동 설정
4. 단계별 실행 계획 EXECUTION-PLAN.md 생성

Args:
  - concept_md (string, optional): CONCEPT.md 경로 (기본: ./CONCEPT.md)
  - project_path (string, optional): 게임 프로젝트 경로 (엔진 감지용)
  - output_file (string, optional): EXECUTION-PLAN.md 저장 경로 (기본: ./EXECUTION-PLAN.md)
  - output_dir (string, optional): 에셋 출력 디렉토리 (기본: ./generated-assets)

Returns:
  생성된 EXECUTION-PLAN.md 경로와 파싱된 에셋 목록 요약.`,
      inputSchema: z.object({
        concept_md: z.string().optional().describe("CONCEPT.md 파일 경로"),
        project_path: z.string().optional().describe("게임 프로젝트 경로 (엔진 감지용)"),
        output_file: z.string().optional().describe("EXECUTION-PLAN.md 저장 경로"),
        output_dir: z.string().optional().describe("에셋 출력 디렉토리"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const conceptMdPath = path.resolve(params.concept_md || DEFAULT_CONCEPT_MD_FILE);
      const outputFile = path.resolve(params.output_file || DEFAULT_EXECUTION_PLAN_FILE);
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

      if (!fs.existsSync(conceptMdPath)) {
        return {
          content: [{
            type: "text" as const,
            text: `CONCEPT.md 파일을 찾을 수 없습니다: ${conceptMdPath}\n먼저 asset_create_concept_md 도구로 CONCEPT.md를 생성하세요.`,
          }],
          isError: true,
        };
      }

      const conceptContent = fs.readFileSync(conceptMdPath, "utf-8");
      const concept = parseConceptMd(conceptContent);

      // 게임 엔진 감지
      let engine = "unknown";
      let exportFormats: string[] = ["individual"];
      let detectedOutputDir = outputDir;

      if (params.project_path) {
        const rootPath = path.resolve(params.project_path);
        if (fs.existsSync(rootPath)) {
          const allFiles = collectFiles(rootPath, 6);
          const engineResult = detectEngine(rootPath, allFiles);
          const assetDirs = detectAssetDirectories(rootPath, engineResult.engine);
          const recommendations = getEngineRecommendations(engineResult.engine, assetDirs);
          engine = engineResult.engine;
          exportFormats = recommendations.export_formats.length > 0
            ? recommendations.export_formats
            : ["individual"];
          detectedOutputDir = recommendations.output_dir || outputDir;
        }
      }

      const planContent = buildExecutionPlanMd(concept, engine, exportFormats, detectedOutputDir);
      ensureDir(path.dirname(outputFile));
      fs.writeFileSync(outputFile, planContent, "utf-8");

      const output = {
        success: true,
        execution_plan_file: outputFile,
        concept_md_file: conceptMdPath,
        game_name: concept.game_name,
        detected_engine: engine,
        export_formats: exportFormats,
        assets: {
          characters: concept.characters.map((c) => ({ id: c.id, type: c.type, actions: c.actions })),
          weapons: concept.weapons.map((w) => ({ id: w.id, name: w.name })),
          backgrounds: concept.backgrounds.map((b) => ({ id: b.id, name: b.name })),
        },
        total_assets: concept.characters.length + concept.weapons.length + concept.backgrounds.length,
        next_step: "EXECUTION-PLAN.md를 확인하고 Step 2 (캐릭터 베이스 생성)부터 시작하세요.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 무기 일괄 생성 ──────────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_weapons",
    {
      title: "Generate Weapon Icons",
      description: `무기 아이콘을 gpt-image-1로 투명 배경으로 일괄 생성합니다.

프로세스 3.2단계에 해당합니다:
- 각 무기를 gpt-image-1 (투명 배경) 로 생성
- 아이콘 스타일, 탑다운 각도
- CONCEPT.md의 BASE STYLE PROMPT 자동 적용

Args:
  - weapons (array): 무기 목록 [{id, name, description, prompt}]
    - id: 파일명 기반 식별자
    - name: 무기 이름
    - description: 무기 설명
    - prompt: 생성 프롬프트 (없으면 description으로 자동 생성)
  - concept_md (string, optional): CONCEPT.md 경로 (BASE STYLE PROMPT 로드용)
  - size (string, optional): 이미지 크기 (기본: 1024x1024)
  - quality (string, optional): 생성 품질 (기본: medium)
  - output_dir (string, optional): 출력 디렉토리

Returns:
  각 무기 생성 결과 (파일 경로, asset ID).`,
      inputSchema: z.object({
        weapons: z.array(z.object({
          id: z.string().describe("무기 식별자 (파일명 기반)"),
          name: z.string().describe("무기 이름"),
          description: z.string().describe("무기 외형 설명"),
          prompt: z.string().optional().describe("커스텀 생성 프롬프트 (없으면 자동 생성)"),
        })).min(1).max(20).describe("무기 목록"),
        concept_md: z.string().optional().describe("CONCEPT.md 경로 (BASE STYLE PROMPT 로드용)"),
        size: z.enum(["1024x1024", "1792x1024", "1024x1792"]).default("1024x1024").describe("이미지 크기"),
        quality: z.enum(["low", "medium", "high", "auto"]).default("medium").describe("생성 품질"),
        output_dir: z.string().optional().describe("출력 디렉토리"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

      // CONCEPT.md에서 BASE STYLE PROMPT 로드
      let baseStyle = "";
      const conceptMdPath = path.resolve(params.concept_md || DEFAULT_CONCEPT_MD_FILE);
      if (fs.existsSync(conceptMdPath)) {
        const content = fs.readFileSync(conceptMdPath, "utf-8");
        const parsed = parseConceptMd(content);
        baseStyle = parsed.base_style_prompt;
      }

      const results: Array<{
        id: string;
        name: string;
        success: boolean;
        file_path?: string;
        asset_id?: string;
        error?: string;
      }> = [];

      for (const weapon of params.weapons) {
        const weaponPrompt = weapon.prompt ||
          `${weapon.description}, game weapon icon, top-down view, clean icon style, single object, centered, no background details`;

        const finalPrompt = baseStyle
          ? `${baseStyle}, ${weaponPrompt}`
          : weaponPrompt;

        try {
          const result = await generateImageOpenAI({
            prompt: finalPrompt,
            size: params.size,
            quality: params.quality,
            background: "transparent",
          });

          const fileName = generateFileName(`weapon_${weapon.id}`, "png");
          const filePath = buildAssetPath(outputDir, "weapons", fileName);
          saveBase64File(result.base64, filePath);

          // 여백 추가 (엣지 잘림 방지)
          await addPadding(filePath, filePath, 8);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "icon",
            provider: "openai",
            prompt: weapon.prompt || weaponPrompt,
            file_path: filePath,
            file_name: fileName,
            mime_type: "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              weapon_id: weapon.id,
              weapon_name: weapon.name,
            },
          };

          saveAssetToRegistry(asset, outputDir);

          results.push({
            id: weapon.id,
            name: weapon.name,
            success: true,
            file_path: filePath,
            asset_id: asset.id,
          });
        } catch (error) {
          results.push({
            id: weapon.id,
            name: weapon.name,
            success: false,
            error: handleApiError(error, "OpenAI weapon"),
          });
        }
      }

      const succeeded = results.filter((r) => r.success).length;
      const output = {
        total: params.weapons.length,
        succeeded,
        failed: params.weapons.length - succeeded,
        results,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );
}
