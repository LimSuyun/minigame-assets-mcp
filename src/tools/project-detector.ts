import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import {
  collectFiles,
  detectEngine,
  detectAssetDirectories,
  scanAssetReferences,
  scanDisplaySizes,
  getEngineRecommendations,
} from "../utils/project-scanner.js";
import type { GameEngine } from "../utils/project-scanner.js";
import type { GameDesign, CanonRegistry } from "../types.js";

// ─── 3-Path 감지 헬퍼 ─────────────────────────────────────────────────────────

interface ThreePathResult {
  path_recommendation: "A" | "B" | "C";
  has_game_design: boolean;
  game_design_valid: boolean;
  game_design_missing_fields: string[];
  game_name?: string;
  preset?: string;
  has_concept_md: boolean;
  has_size_spec: boolean;
  has_asset_plan: boolean;
  canon_count: number;
  generated_asset_count: number;
}

function detectThreePath(rootPath: string): ThreePathResult {
  // GAME_DESIGN.json 감지
  const gameDesignPath = path.join(rootPath, "GAME_DESIGN.json");
  let hasGameDesign = false;
  let gameDesignValid = false;
  const missingFields: string[] = [];
  let gameName: string | undefined;
  let preset: string | undefined;

  if (fs.existsSync(gameDesignPath)) {
    hasGameDesign = true;
    try {
      const design = JSON.parse(fs.readFileSync(gameDesignPath, "utf-8")) as GameDesign;
      if (!design.game_name) missingFields.push("game_name");
      if (!design.art_style) missingFields.push("art_style");
      if (!design.size_profile && !design.canvas_size) missingFields.push("size_profile 또는 canvas_size");
      gameDesignValid = missingFields.length === 0;
      gameName = design.game_name;
      preset = design.size_profile;
    } catch {
      missingFields.push("JSON 파싱 오류");
    }
  }

  // CONCEPT.md 감지
  const conceptMdPath = path.join(rootPath, "CONCEPT.md");
  const hasConceptMd = fs.existsSync(conceptMdPath);

  // asset_size_spec.json 감지
  const sizeSpecPaths = [
    path.join(rootPath, "asset_size_spec.json"),
    path.join(rootPath, "generated-assets", "asset_size_spec.json"),
  ];
  const hasSizeSpec = sizeSpecPaths.some((p) => fs.existsSync(p));

  // FULL_ASSET_PLAN.md 감지
  const assetPlanPaths = [
    path.join(rootPath, "FULL_ASSET_PLAN.md"),
    path.join(rootPath, "EXECUTION-PLAN.md"),
  ];
  const hasAssetPlan = assetPlanPaths.some((p) => fs.existsSync(p));

  // Canon 수 집계
  let canonCount = 0;
  const canonRegistryPaths = [
    path.join(rootPath, "canon", "canon_registry.json"),
    path.join(rootPath, "generated-assets", "canon", "canon_registry.json"),
  ];
  for (const crPath of canonRegistryPaths) {
    if (fs.existsSync(crPath)) {
      try {
        const registry = JSON.parse(fs.readFileSync(crPath, "utf-8")) as CanonRegistry;
        canonCount = registry.entries?.length ?? 0;
      } catch { /* ignore */ }
      break;
    }
  }

  // generated-assets 에셋 수 집계
  let generatedAssetCount = 0;
  const registryPaths = [
    path.join(rootPath, "generated-assets", "asset_registry.json"),
    path.join(rootPath, "asset_registry.json"),
  ];
  for (const rPath of registryPaths) {
    if (fs.existsSync(rPath)) {
      try {
        const registry = JSON.parse(fs.readFileSync(rPath, "utf-8")) as { assets?: unknown[] };
        generatedAssetCount = registry.assets?.length ?? 0;
      } catch { /* ignore */ }
      break;
    }
  }

  // Path 추천
  let pathRecommendation: "A" | "B" | "C";
  if (hasGameDesign) {
    pathRecommendation = "A";
  } else if (hasConceptMd) {
    pathRecommendation = "B";
  } else {
    pathRecommendation = "C";
  }

  return {
    path_recommendation: pathRecommendation,
    has_game_design: hasGameDesign,
    game_design_valid: gameDesignValid,
    game_design_missing_fields: missingFields,
    game_name: gameName,
    preset,
    has_concept_md: hasConceptMd,
    has_size_spec: hasSizeSpec,
    has_asset_plan: hasAssetPlan,
    canon_count: canonCount,
    generated_asset_count: generatedAssetCount,
  };
}

export function registerProjectDetectorTools(server: McpServer): void {
  // ── 1. 프로젝트 분석 ────────────────────────────────────────────────────────
  server.registerTool(
    "asset_analyze_project",
    {
      title: "Analyze Game Project",
      description: `Scan a game project directory to detect:
1. **3-Path Entry System** (★ primary purpose):
   - Path A: GAME_DESIGN.json found → ready to generate assets immediately
   - Path B: CONCEPT.md found → auto-convert to GAME_DESIGN.json then proceed
   - Path C: Neither found → run wizard to create GAME_DESIGN.json

2. **Asset generation status**: GAME_DESIGN.json validity, canon count, generated asset count,
   asset_size_spec.json presence, FULL_ASSET_PLAN.md presence.

3. **Game engine detection** (secondary): Cocos Creator, Unity, Phaser, Godot
   with recommended settings for sprite/image generation tools.

Call this tool FIRST before any asset generation workflow. The path_recommendation
field tells you which entry path to use.

Args:
  - project_path (string): Absolute or relative path to the project root directory
                           (defaults to current directory if ".")
  - scan_asset_refs (boolean, optional): Scan source code for asset references (default: true)
  - max_scan_files (number, optional): Max source files to scan (default: 50)

Returns:
  - path_recommendation: "A" | "B" | "C" (3-path entry recommendation)
  - has_game_design, game_design_valid, game_design_missing_fields
  - has_concept_md, has_size_spec, has_asset_plan
  - canon_count, generated_asset_count, game_name, preset
  - engine detection + asset directories + recommended settings`,
      inputSchema: z.object({
        project_path: z.string().min(1).describe("Path to the project root directory (use '.' for current directory)"),
        scan_asset_refs: z.boolean().default(true).describe("Scan source code for asset references"),
        max_scan_files: z.number().int().min(1).max(200).default(50).describe("Max files to scan"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const rootPath = path.resolve(params.project_path);

      if (!fs.existsSync(rootPath)) {
        return {
          content: [{
            type: "text" as const,
            text: `Error: Directory not found: ${rootPath}`,
          }],
          isError: true,
        };
      }

      // 파일 수집
      const allFiles = collectFiles(rootPath, 6);

      // 엔진 감지
      const engineResult = detectEngine(rootPath, allFiles);

      // 에셋 디렉토리 감지
      const assetDirs = detectAssetDirectories(rootPath, engineResult.engine);

      // 권장 설정
      const recommendations = getEngineRecommendations(engineResult.engine, assetDirs);

      // package.json 정보
      let packageInfo: Record<string, unknown> | null = null;
      try {
        const pkgPath = path.join(rootPath, "package.json");
        if (fs.existsSync(pkgPath)) {
          packageInfo = JSON.parse(fs.readFileSync(pkgPath, "utf-8")) as Record<string, unknown>;
        }
      } catch { /* ignore */ }

      const projectName =
        (packageInfo?.["name"] as string) ||
        path.basename(rootPath);

      // 에셋 참조 스캔
      let assetRefs: ReturnType<typeof scanAssetReferences> = [];
      if (params.scan_asset_refs) {
        assetRefs = scanAssetReferences(
          rootPath,
          engineResult.engine,
          allFiles.slice(0, params.max_scan_files)
        );
      }

      // 이미지/오디오 참조 요약
      const imageRefs = assetRefs.filter((r) => r.asset_type === "image").slice(0, 30);
      const audioRefs = assetRefs.filter((r) => r.asset_type === "audio").slice(0, 10);

      // 3-Path 진입 시스템 감지
      const threePathResult = detectThreePath(rootPath);

      const output = {
        // ─── 3-Path 진입 시스템 (★ 에셋 생성 워크플로우 핵심) ──────────────
        three_path_entry: {
          path_recommendation: threePathResult.path_recommendation,
          path_description: {
            A: "GAME_DESIGN.json 발견 → 즉시 에셋 생성 가능",
            B: "CONCEPT.md 발견 → 자동 변환 후 진행",
            C: "문서 없음 → 위자드 실행 필요",
          }[threePathResult.path_recommendation],
          has_game_design: threePathResult.has_game_design,
          game_design_valid: threePathResult.game_design_valid,
          game_design_missing_fields: threePathResult.game_design_missing_fields,
          game_name: threePathResult.game_name,
          preset: threePathResult.preset,
          has_concept_md: threePathResult.has_concept_md,
          has_size_spec: threePathResult.has_size_spec,
          has_asset_plan: threePathResult.has_asset_plan,
          canon_count: threePathResult.canon_count,
          generated_asset_count: threePathResult.generated_asset_count,
        },
        // ─── 게임 엔진 감지 ──────────────────────────────────────────────────
        project: {
          name: projectName,
          root_path: rootPath,
          total_files_scanned: allFiles.length,
        },
        engine: {
          detected: engineResult.engine,
          confidence: `${engineResult.confidence}%`,
          version: engineResult.version,
          signals: engineResult.signals,
        },
        asset_directories: assetDirs.map((d) => ({
          path: d.path,
          purpose: d.purpose,
          existing_files: d.existing_files,
        })),
        asset_references: {
          total_found: assetRefs.length,
          images: imageRefs.map((r) => ({
            asset_name: r.asset_name,
            file: r.file,
            line: r.line,
          })),
          audio: audioRefs.map((r) => ({
            asset_name: r.asset_name,
            file: r.file,
            line: r.line,
          })),
        },
        recommended_settings: {
          export_formats: recommendations.export_formats,
          output_dir: recommendations.output_dir,
          image_provider: recommendations.image_provider,
          notes: recommendations.notes,
        },
        ready_to_use: {
          sprite_sheet_params: {
            export_formats: recommendations.export_formats,
            output_dir: recommendations.output_dir,
          },
          image_generation_params: {
            provider: recommendations.image_provider,
            output_dir: recommendations.output_dir,
          },
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 2. 에셋 참조 기반 생성 계획 수립 ────────────────────────────────────────
  server.registerTool(
    "asset_plan_from_project",
    {
      title: "Plan Asset Generation from Project Code",
      description: `Scan a game project and generate a detailed asset creation plan based on
what the code references (sprites, atlases, audio files) that don't exist yet.

Identifies missing assets by comparing code references with existing files.

Args:
  - project_path (string): Path to the game project root directory
  - concept_file (string, optional): Path to game concept JSON for enriching prompts

Returns:
  A list of missing assets with suggested generation parameters ready to pass
  directly to asset_generate_image_openai, asset_generate_sprite_sheet, etc.`,
      inputSchema: z.object({
        project_path: z.string().min(1).describe("Path to the game project root directory"),
        concept_file: z.string().optional().describe("Path to game concept JSON for style hints"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const rootPath = path.resolve(params.project_path);

      if (!fs.existsSync(rootPath)) {
        return {
          content: [{ type: "text" as const, text: `Error: Directory not found: ${rootPath}` }],
          isError: true,
        };
      }

      const allFiles = collectFiles(rootPath, 6);
      const engineResult = detectEngine(rootPath, allFiles);
      const assetDirs = detectAssetDirectories(rootPath, engineResult.engine);
      const recommendations = getEngineRecommendations(engineResult.engine, assetDirs);
      const assetRefs = scanAssetReferences(rootPath, engineResult.engine, allFiles);

      // 실제로 존재하는 파일명 목록
      const existingFileNames = new Set(
        allFiles.map((f) => path.basename(f).toLowerCase())
      );

      // 미싱 에셋 판별
      interface MissingAsset {
        asset_name: string;
        asset_type: AssetReference["asset_type"];
        referenced_in: string[];
        suggested_tool: string;
        suggested_params: Record<string, unknown>;
      }

      type AssetReference = (typeof assetRefs)[0];

      // asset_name 기준으로 중복 제거 + 참조 파일 집계
      const assetMap = new Map<string, { refs: AssetReference[]; type: AssetReference["asset_type"] }>();
      for (const ref of assetRefs) {
        const key = ref.asset_name.toLowerCase();
        if (!assetMap.has(key)) {
          assetMap.set(key, { refs: [], type: ref.asset_type });
        }
        assetMap.get(key)!.refs.push(ref);
      }

      const missingAssets: MissingAsset[] = [];
      const existingAssets: string[] = [];

      for (const [key, { refs, type }] of assetMap) {
        const baseName = path.basename(key).toLowerCase();
        const isExisting =
          existingFileNames.has(baseName) ||
          existingFileNames.has(baseName + ".png") ||
          existingFileNames.has(baseName + ".jpg");

        if (isExisting) {
          existingAssets.push(key);
          continue;
        }

        // 에셋 이름에서 타입 추측
        const guessedType = guessAssetType(key);
        const tool =
          type === "audio"
            ? "asset_generate_music_local"
            : guessedType === "character" || guessedType === "sprite"
            ? "asset_generate_character_base"
            : "asset_generate_image_openai";

        const suggestedParams: Record<string, unknown> = {
          output_dir: recommendations.output_dir,
          export_formats: recommendations.export_formats,
        };

        if (type !== "audio") {
          suggestedParams["asset_type"] = guessedType;
          suggestedParams["prompt"] =
            `Game asset: ${path.basename(key, path.extname(key)).replace(/[-_]/g, " ")}. ` +
            `High quality, game-ready sprite.`;
          suggestedParams["provider"] = recommendations.image_provider;
        } else {
          suggestedParams["prompt"] =
            `Game sound effect: ${path.basename(key, path.extname(key)).replace(/[-_]/g, " ")}`;
          suggestedParams["music_type"] = "sound_effect";
        }

        missingAssets.push({
          asset_name: key,
          asset_type: type,
          referenced_in: refs.map((r) => `${r.file}:${r.line}`),
          suggested_tool: tool,
          suggested_params: suggestedParams,
        });
      }

      const output = {
        project_path: rootPath,
        engine: engineResult.engine,
        total_references: assetRefs.length,
        existing_assets_count: existingAssets.length,
        missing_assets_count: missingAssets.length,
        missing_assets: missingAssets.slice(0, 50),
        recommended_settings: {
          export_formats: recommendations.export_formats,
          output_dir: recommendations.output_dir,
          notes: recommendations.notes,
        },
        summary:
          missingAssets.length === 0
            ? "All referenced assets appear to exist already."
            : `Found ${missingAssets.length} potentially missing assets. ` +
              `Use the suggested_tool and suggested_params for each to generate them.`,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 3. 디자인 문서 기반 에셋 플랜 생성 ─────────────────────────────────────
  server.registerTool(
    "asset_generate_asset_plan",
    {
      title: "Generate Asset Plan from Design Documents",
      description: `Scan a game project for design documents and source code to generate a structured asset-plan.json.

Works with or without ASSET-DESIGN-CONCEPT.md. Automatically discovers design docs:
- ASSET-DESIGN-CONCEPT.md, GDD.md, game-design.md, design-doc.md, README.md, docs/*.md, etc.
- game-concept.json for base style hints
- Source code for referenced asset names

For each missing asset:
- If a matching section is found in design docs → extracts the prompt from code blocks
- If no doc match → generates a style-consistent prompt from game-concept.json

Saves the result as asset-plan.json with per-asset prompts, sizes, priorities, and generation params.

Args:
  - project_path (string): Path to the game project root
  - output_file (string, optional): Where to save asset-plan.json (default: <project_path>/asset-plan.json)
  - concept_file (string, optional): Path to game-concept.json

Returns:
  Summary of the generated asset plan with total counts by category.`,
      inputSchema: z.object({
        project_path: z.string().min(1).describe("Path to the game project root"),
        output_file: z.string().optional().describe("Path to save asset-plan.json (default: <project_path>/asset-plan.json)"),
        concept_file: z.string().optional().describe("Path to game-concept.json"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const rootPath = path.resolve(params.project_path);

      if (!fs.existsSync(rootPath)) {
        return {
          content: [{ type: "text" as const, text: `Error: Directory not found: ${rootPath}` }],
          isError: true,
        };
      }

      // 1) 게임 컨셉 로드
      const conceptPaths = [
        params.concept_file,
        path.join(rootPath, "game-concept.json"),
        path.join(rootPath, "concept", "game-concept.json"),
        path.join(rootPath, "docs", "game-concept.json"),
      ].filter(Boolean) as string[];

      let concept: Record<string, unknown> | null = null;
      let conceptFileFound = "";
      for (const cp of conceptPaths) {
        try {
          if (fs.existsSync(cp)) {
            concept = JSON.parse(fs.readFileSync(cp, "utf-8")) as Record<string, unknown>;
            conceptFileFound = cp;
            break;
          }
        } catch { /* ignore */ }
      }

      // 2) 디자인 문서 탐색
      const DESIGN_DOC_CANDIDATES = [
        "ASSET-DESIGN-CONCEPT.md",
        "ASSET_DESIGN_CONCEPT.md",
        "GDD.md",
        "game-design-document.md",
        "game-design.md",
        "GameDesignDocument.md",
        "design-doc.md",
        "design.md",
        "DESIGN.md",
        "game-concept.md",
        "README.md",
        "docs/design.md",
        "docs/gdd.md",
        "docs/assets.md",
        "docs/game-design.md",
        "docs/asset-design.md",
        "documents/design.md",
      ];

      // _bmad-output 같은 폴더의 md 파일도 탐색
      const allFiles = collectFiles(rootPath, 6);
      const extraMdFiles = allFiles
        .filter((f) => f.endsWith(".md") && !f.includes("node_modules"))
        .map((f) => path.relative(rootPath, f));

      const allCandidates = [
        ...DESIGN_DOC_CANDIDATES,
        ...extraMdFiles.filter((f) => !DESIGN_DOC_CANDIDATES.includes(f)),
      ];

      interface DesignDoc {
        file: string;
        fullPath: string;
        sections: MarkdownSection[];
        baseStyle?: string; // 공통 base prompt (첫 번째 코드 블록에 있을 수 있음)
      }

      const designDocs: DesignDoc[] = [];
      for (const candidate of allCandidates.slice(0, 30)) {
        const fullPath = path.isAbsolute(candidate) ? candidate : path.join(rootPath, candidate);
        if (!fs.existsSync(fullPath)) continue;
        try {
          const content = fs.readFileSync(fullPath, "utf-8");
          if (content.length < 100) continue; // 너무 짧은 파일 스킵
          const sections = parseMarkdownSections(content);
          // "BASE STYLE" 또는 공통 프롬프트 추출
          const baseSection = sections.find((s) =>
            /base.?style|base.?prompt|공통|기본.?스타일/i.test(s.header + s.content)
          );
          const baseStyle = baseSection?.codeBlocks[0] || "";
          designDocs.push({ file: candidate, fullPath, sections, baseStyle });
        } catch { /* ignore */ }
      }

      // 3) 코드 스캔으로 미싱 에셋 파악
      const engineResult = detectEngine(rootPath, allFiles);
      const assetDirs = detectAssetDirectories(rootPath, engineResult.engine);
      const recommendations = getEngineRecommendations(engineResult.engine, assetDirs);
      const assetRefs = scanAssetReferences(rootPath, engineResult.engine, allFiles);

      const existingFileNames = new Set(
        allFiles.map((f) => path.basename(f).toLowerCase())
      );

      // 미싱 에셋 목록 (중복 제거)
      const assetMap = new Map<string, { type: string; refs: string[] }>();
      for (const ref of assetRefs) {
        const key = ref.asset_name.toLowerCase();
        if (!assetMap.has(key)) {
          assetMap.set(key, { type: ref.asset_type, refs: [] });
        }
        assetMap.get(key)!.refs.push(`${ref.file}:${ref.line}`);
      }

      // 4) 에셋 플랜 생성
      interface AssetPlanEntry {
        id: string;
        category: string;
        asset_type: string;
        priority: number;
        size: string;
        format: string;
        prompt: string;
        prompt_source: "design_doc" | "concept_generated" | "generic";
        doc_matched?: string;
        tool: string;
        params: Record<string, unknown>;
        referenced_in: string[];
        status: "pending" | "exists";
      }

      const planEntries: AssetPlanEntry[] = [];

      // 베이스 스타일 (첫 번째 design doc에서 추출 또는 concept에서 구성)
      const globalBaseStyle =
        designDocs.find((d) => d.baseStyle)?.baseStyle ||
        buildBaseStyleFromConcept(concept);

      for (const [assetKey, { type, refs }] of assetMap) {
        const baseName = path.basename(assetKey);
        const isExisting =
          existingFileNames.has(baseName) ||
          existingFileNames.has(baseName + ".png") ||
          existingFileNames.has(baseName + ".jpg");

        if (isExisting) continue; // 이미 존재하는 에셋 스킵

        const assetName = path.basename(assetKey, path.extname(assetKey));
        const category = categorizeAsset(assetName);
        const assetTypeFull = guessAssetType(assetKey);
        const priority = getCategoryPriority(category);
        const { size, format } = getAssetSizeSpec(assetName, designDocs);

        // 디자인 문서에서 매칭 섹션 탐색
        let prompt = "";
        let promptSource: AssetPlanEntry["prompt_source"] = "generic";
        let docMatched = "";

        for (const doc of designDocs) {
          const section = findBestSection(assetName, doc.sections);
          if (section && section.codeBlocks.length > 0) {
            // 코드 블록에서 프롬프트 추출
            const rawPrompt = section.codeBlocks.find((b) => b.length > 20) || "";
            if (rawPrompt) {
              // [BASE STYLE] 플레이스홀더를 실제 base style로 교체
              prompt = rawPrompt.replace(/\[BASE STYLE\]\s*\+?\s*/gi, globalBaseStyle ? globalBaseStyle + ", " : "");
              promptSource = "design_doc";
              docMatched = doc.file;
              break;
            }
          }
        }

        // 디자인 문서 매칭 실패 시 컨셉 기반 프롬프트 생성
        if (!prompt) {
          prompt = buildPromptFromConcept(assetName, category, concept, globalBaseStyle);
          promptSource = concept ? "concept_generated" : "generic";
        }

        // 생성 도구 결정
        const tool =
          type === "audio"
            ? "asset_generate_music_local"
            : category === "enemy" || category === "boss" || category === "character"
            ? "asset_generate_character_base"
            : "asset_generate_image_openai";

        const toolParams: Record<string, unknown> = {
          output_dir: recommendations.output_dir,
        };

        if (type !== "audio") {
          toolParams["asset_type"] = assetTypeFull;
          toolParams["prompt"] = prompt;
          toolParams["provider"] = recommendations.image_provider;
          if (recommendations.export_formats.length > 0) {
            toolParams["export_formats"] = recommendations.export_formats;
          }
        } else {
          toolParams["prompt"] = prompt;
          toolParams["music_type"] = "background";
        }

        planEntries.push({
          id: assetName,
          category,
          asset_type: assetTypeFull,
          priority,
          size,
          format,
          prompt,
          prompt_source: promptSource,
          ...(docMatched ? { doc_matched: docMatched } : {}),
          tool,
          params: toolParams,
          referenced_in: refs,
          status: "pending",
        });
      }

      // 우선순위 정렬
      planEntries.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

      // 5) asset-plan.json 저장
      const outputFile = params.output_file || path.join(rootPath, "asset-plan.json");

      const categoryCounts: Record<string, number> = {};
      for (const e of planEntries) {
        categoryCounts[e.category] = (categoryCounts[e.category] || 0) + 1;
      }

      const planOutput = {
        generated_at: new Date().toISOString(),
        project_path: rootPath,
        engine: engineResult.engine,
        concept_file: conceptFileFound || null,
        design_docs_scanned: designDocs.map((d) => d.file),
        base_style: globalBaseStyle || null,
        summary: {
          total_assets: planEntries.length,
          by_category: categoryCounts,
          prompt_sources: {
            from_design_doc: planEntries.filter((e) => e.prompt_source === "design_doc").length,
            from_concept: planEntries.filter((e) => e.prompt_source === "concept_generated").length,
            generic: planEntries.filter((e) => e.prompt_source === "generic").length,
          },
        },
        assets: planEntries,
      };

      fs.writeFileSync(outputFile, JSON.stringify(planOutput, null, 2), "utf-8");

      const resultText = [
        `✅ asset-plan.json 생성 완료: ${outputFile}`,
        ``,
        `📊 에셋 플랜 요약:`,
        `  - 총 에셋: ${planEntries.length}개`,
        `  - 카테고리별: ${Object.entries(categoryCounts).map(([k, v]) => `${k}(${v})`).join(", ")}`,
        `  - 디자인 문서 기반 프롬프트: ${planOutput.summary.prompt_sources.from_design_doc}개`,
        `  - 컨셉 기반 생성 프롬프트: ${planOutput.summary.prompt_sources.from_concept}개`,
        `  - 제네릭 프롬프트: ${planOutput.summary.prompt_sources.generic}개`,
        ``,
        `📄 스캔된 디자인 문서: ${designDocs.length > 0 ? designDocs.map((d) => d.file).join(", ") : "없음 (컨셉 기반으로 생성)"}`,
        `🎨 게임 컨셉: ${conceptFileFound || "없음"}`,
      ].join("\n");

      return {
        content: [{ type: "text" as const, text: resultText }],
        structuredContent: planOutput,
      };
    }
  );

  // ── 4. 코드 기반 display-size 스캔 ───────────────────────────────────────────
  server.registerTool(
    "asset_scan_display_sizes",
    {
      title: "Scan Game Code for Actual Display Sizes",
      description: `Scans game source code to extract actual runtime display dimensions for each asset key, so image generation can match the sizes the game code actually renders at.

Recognized patterns:
  - Phaser: \`add.sprite(x, y, 'key').setDisplaySize(w, h)\`, \`.setScale(n)\`
  - Cocos Creator: \`.setContentSize(w, h)\` near a sprite frame key
  - Godot: \`$Sprite.scale = Vector2(n, n)\`
  - Unity: (pattern set under development)

Per-key output includes: detected width/height, scale factor, source lines, and a suggested generation size (2× display for sharp rendering, snapped to multiple of 64, capped at 1024).

Typical workflow:
  1. Run asset_scan_display_sizes → review detected sizes
  2. Pass \`size: "<suggested_generation_size>x<suggested_generation_size>"\` to asset_generate_* tools
  3. Or set \`maxDim\` during writeOptimized for automatic downscale to display size

Args:
  - project_path (string): Path to the game project root

Returns:
  Array of detections sorted by asset_key, plus a summary of engine and total asset keys found.`,
      inputSchema: z.object({
        project_path: z.string().min(1).describe("Path to the game project root"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const rootPath = path.resolve(params.project_path);
      if (!fs.existsSync(rootPath)) {
        return {
          content: [{ type: "text" as const, text: `Error: Directory not found: ${rootPath}` }],
          isError: true,
        };
      }

      const allFiles = collectFiles(rootPath, 6);
      const engineResult = detectEngine(rootPath, allFiles);
      const detections = scanDisplaySizes(rootPath, engineResult.engine, allFiles);

      const output = {
        project_path: rootPath,
        engine: engineResult.engine,
        confidence: engineResult.confidence,
        total_detections: detections.length,
        detections,
        usage_hint: detections.length > 0
          ? `Pass the suggested_generation_size to each asset_generate_* call for its matching asset_key. For example: { asset_key: "${detections[0].asset_key}", size: "${detections[0].suggested_generation_size}x${detections[0].suggested_generation_size}" }.`
          : "No display-size hints found. Either the code does not set explicit display sizes, or the patterns did not match this project's style. Generation will use defaults.",
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );
}

// ─── 헬퍼 ─────────────────────────────────────────────────────────────────────

// ── 마크다운 파싱 ─────────────────────────────────────────────────────────────

interface MarkdownSection {
  level: number;
  header: string;
  content: string;
  codeBlocks: string[];
}

function parseMarkdownSections(content: string): MarkdownSection[] {
  const sections: MarkdownSection[] = [];
  const lines = content.split("\n");
  let current: MarkdownSection | null = null;

  for (const line of lines) {
    const headerMatch = line.match(/^(#{1,4})\s+(.+)/);
    if (headerMatch) {
      if (current) {
        current.codeBlocks = extractCodeBlocks(current.content);
        sections.push(current);
      }
      current = {
        level: headerMatch[1].length,
        header: headerMatch[2].trim(),
        content: "",
        codeBlocks: [],
      };
    } else if (current) {
      current.content += line + "\n";
    }
  }
  if (current) {
    current.codeBlocks = extractCodeBlocks(current.content);
    sections.push(current);
  }
  return sections;
}

function extractCodeBlocks(content: string): string[] {
  const blocks: string[] = [];
  const regex = /```[^\n]*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    const block = match[1].trim();
    if (block.length > 10) blocks.push(block);
  }
  return blocks;
}

// ── 섹션 매칭 ────────────────────────────────────────────────────────────────

function findBestSection(
  assetName: string,
  sections: MarkdownSection[]
): MarkdownSection | null {
  // asset name을 키워드로 분리 (예: "enemy-dokkaebi" → ["enemy", "dokkaebi"])
  const keywords = assetName.toLowerCase().split(/[-_\s]+/).filter((k) => k.length > 1);

  let bestScore = 0;
  let best: MarkdownSection | null = null;

  for (const section of sections) {
    const haystack = (section.header + " " + section.content.slice(0, 300)).toLowerCase();
    let score = 0;

    for (const kw of keywords) {
      if (haystack.includes(kw)) {
        // 헤더 매칭은 더 높은 점수
        score += section.header.toLowerCase().includes(kw) ? 3 : 1;
      }
    }

    // 코드 블록이 있을 때 보너스
    if (score > 0 && section.codeBlocks.length > 0) score += 2;

    if (score > bestScore) {
      bestScore = score;
      best = section;
    }
  }

  // 최소 점수 2 이상만 유효한 매칭으로 인정
  return bestScore >= 2 ? best : null;
}

// ── 에셋 분류 ────────────────────────────────────────────────────────────────

function categorizeAsset(name: string): string {
  const lower = name.toLowerCase();
  if (/boss/.test(lower)) return "boss";
  if (/enemy|mob|monster|npc/.test(lower)) return "enemy";
  if (/weapon|gun|sword|bow|cannon|laser|drone|missile/.test(lower)) return "weapon";
  if (/bg|background|backdrop|zone|map/.test(lower)) return "background";
  if (/player|hero|character|protagonist/.test(lower)) return "player";
  if (/ui|icon|slot|button|panel|hud|badge|frame/.test(lower)) return "ui";
  if (/particle|fx|effect|spark|explosion/.test(lower)) return "effect";
  if (/tile|block|wall|floor|platform/.test(lower)) return "tile";
  if (/bgm|music|sfx|audio|sound/.test(lower)) return "audio";
  if (/logo|title/.test(lower)) return "logo";
  return "sprite";
}

function getCategoryPriority(category: string): number {
  const priorities: Record<string, number> = {
    player: 1,
    enemy: 2,
    boss: 3,
    weapon: 4,
    background: 5,
    ui: 6,
    tile: 7,
    effect: 8,
    audio: 9,
    logo: 10,
    sprite: 11,
  };
  return priorities[category] ?? 99;
}

// ── 크기/포맷 스펙 ───────────────────────────────────────────────────────────

function getAssetSizeSpec(
  assetName: string,
  designDocs: Array<{ sections: MarkdownSection[] }>
): { size: string; format: string } {
  const lower = assetName.toLowerCase();

  // 디자인 문서에서 크기 힌트 탐색
  for (const doc of designDocs) {
    for (const section of doc.sections) {
      const hay = section.header + " " + section.content;
      const keywords = lower.split(/[-_]/);
      const isRelevant = keywords.some((k) => k.length > 2 && hay.toLowerCase().includes(k));
      if (isRelevant) {
        const sizeMatch = hay.match(/(\d{2,4})[×x](\d{2,4})px/);
        if (sizeMatch) {
          return { size: `${sizeMatch[1]}x${sizeMatch[2]}`, format: "PNG, transparent background" };
        }
      }
    }
  }

  // 카테고리 기반 기본 크기
  if (/boss/.test(lower)) return { size: "128x128", format: "PNG, transparent background" };
  if (/enemy|mob|monster/.test(lower)) return { size: "64x64", format: "PNG, transparent background" };
  if (/weapon|item/.test(lower)) return { size: "48x48", format: "PNG, transparent background" };
  if (/bg|background/.test(lower)) return { size: "390x844", format: "PNG" };
  if (/icon/.test(lower)) return { size: "32x32", format: "PNG, transparent background" };
  if (/badge|frame/.test(lower)) return { size: "48x48", format: "PNG, transparent background" };
  if (/slot/.test(lower)) return { size: "60x60", format: "PNG, transparent background" };
  if (/particle|spark/.test(lower)) return { size: "16x16", format: "PNG, transparent background" };
  return { size: "64x64", format: "PNG, transparent background" };
}

// ── 컨셉 기반 프롬프트 생성 ───────────────────────────────────────────────────

function buildBaseStyleFromConcept(concept: Record<string, unknown> | null): string {
  if (!concept) return "";
  const parts: string[] = [];
  if (concept["art_style"]) parts.push(String(concept["art_style"]));
  if (concept["theme"]) parts.push(`theme: ${String(concept["theme"]).split("—")[0].trim()}`);
  const palette = concept["color_palette"];
  if (Array.isArray(palette) && palette.length > 0) {
    parts.push(`color palette: ${(palette as string[]).slice(0, 4).join(", ")}`);
  }
  return parts.join(", ");
}

function buildPromptFromConcept(
  assetName: string,
  category: string,
  concept: Record<string, unknown> | null,
  baseStyle: string
): string {
  const humanName = assetName.replace(/[-_]/g, " ");
  const base = baseStyle ? `${baseStyle}, ` : "";
  const gameName = concept?.["game_name"] ? `${String(concept["game_name"])} ` : "";
  const genre = concept?.["genre"] ? `${String(concept["genre"])} game ` : "game ";

  switch (category) {
    case "enemy":
    case "boss":
      return `${base}${gameName}${genre}enemy character: ${humanName}, game-ready sprite, transparent background`;
    case "weapon":
      return `${base}${gameName}${genre}weapon icon: ${humanName}, 48x48px icon style, top-down angle, transparent background`;
    case "background":
      return `${base}2D ${gameName}${genre}background: ${humanName}, no characters, portrait orientation`;
    case "player":
      return `${base}${gameName}${genre}player character: ${humanName}, main protagonist, game-ready sprite, transparent background`;
    case "ui":
      return `${base}${gameName}UI element: ${humanName}, clean game UI style, transparent background`;
    case "effect":
      return `${base}particle/effect sprite: ${humanName}, small sprite, transparent background`;
    default:
      return `${base}${gameName}${genre}asset: ${humanName}, game-ready, transparent background`;
  }
}

function guessAssetType(name: string): string {
  const lower = name.toLowerCase();
  if (/player|hero|character|char|avatar|protagonist/.test(lower)) return "character";
  if (/enemy|boss|monster|mob|npc/.test(lower)) return "character";
  if (/bg|background|backdrop|scene/.test(lower)) return "background";
  if (/button|btn|panel|hud|ui|menu|icon|badge/.test(lower)) return "ui_element";
  if (/icon/.test(lower)) return "icon";
  if (/tile|block|platform|wall|floor/.test(lower)) return "tile";
  if (/effect|fx|particle|explode|hit/.test(lower)) return "effect";
  if (/logo|title|brand/.test(lower)) return "logo";
  return "sprite";
}
