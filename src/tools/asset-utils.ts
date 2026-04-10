/**
 * asset-utils.ts — 에셋 검증 및 유틸리티 도구
 *
 * 도구 목록:
 *  - asset_validate            : 에셋 파일 네이밍 규칙 + 스펙 검사 (범용)
 *  - asset_generate_atlas_json : 스프라이트 시트 → Atlas JSON (엔진 선택 가능)
 *  - asset_list_missing        : 필수 에셋 누락 목록 (CONCEPT.md 또는 직접 지정)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_CONCEPT_MD_FILE } from "../constants.js";

// ─── 유틸리티 ─────────────────────────────────────────────────────────────────

function walkDir(dir: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath));
    } else {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * CONCEPT.md의 에셋 목록 테이블에서 파일 ID 목록을 추출합니다.
 * 각 테이블의 ID 컬럼(첫 번째 컬럼) 값을 읽어 반환합니다.
 */
function extractAssetIdsFromConceptMd(conceptMdPath: string): string[] {
  if (!fs.existsSync(conceptMdPath)) return [];
  const content = fs.readFileSync(conceptMdPath, "utf-8");
  const ids: string[] = [];

  // 테이블 행 파싱: | id | ... | 형식에서 첫 번째 컬럼 추출
  // 구분선(|---|) 및 헤더 행 제외
  const tableRowRe = /^\|([^|]+)\|/gm;
  let match: RegExpExecArray | null;
  while ((match = tableRowRe.exec(content)) !== null) {
    const val = match[1].trim();
    // 헤더/구분선 제외
    if (!val || /^[-:\s]+$/.test(val) || /^\*\*/.test(val) || val === "ID") continue;
    ids.push(val);
  }
  return ids;
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerAssetUtilTools(server: McpServer): void {
  // ── 1. 에셋 검증 ────────────────────────────────────────────────────────────
  server.registerTool(
    "asset_validate",
    {
      title: "Validate Game Assets",
      description: `에셋 폴더의 파일들을 네이밍 규칙과 크기 스펙으로 검사합니다.

**기본 네이밍 패턴** (naming_pattern 미지정 시 적용):
\`[카테고리]_[이름](_[상태])?(_[번호])?.ext\`

**크기 규칙** (size_rules로 직접 지정):
- 카테고리별 기대 크기를 지정하면 PNG 파일의 실제 크기를 검사
- 예: {"bg": {"w": 390, "h": 844}, "char": {"w": 48, "h": 48}}
- 미지정 시 크기 검사 없이 네이밍만 검사

**검사 공통 항목**:
- 소문자 전용 (대문자 금지)
- 하이픈(-) 사용 금지 (언더스코어만)
- 공백 사용 금지

Args:
  - assets_dir: 검사할 에셋 폴더 경로
  - naming_pattern: 정규식 문자열 (미지정 시 기본 패턴)
  - valid_categories: 허용 카테고리 목록 (미지정 시 파일명 패턴만 검사)
  - size_rules: 카테고리별 기대 크기 {"카테고리": {"w": N, "h": N}}
  - extensions: 허용 확장자 목록 (기본: png, jpg, ogg, mp3, json, wav)

Returns:
  통과/실패 파일 목록과 에러 상세.`,
      inputSchema: z.object({
        assets_dir: z.string().min(1).describe("검사할 에셋 폴더 경로"),
        naming_pattern: z.string().optional().describe("네이밍 규칙 정규식 (기본: [카테고리]_[이름]_... 패턴)"),
        valid_categories: z.array(z.string()).optional().describe("허용 카테고리 코드 목록 (예: [char, tile, fx, ui, bg, sfx, bgm])"),
        size_rules: z.record(z.object({
          w: z.number().int().positive(),
          h: z.number().int().positive(),
        })).optional().describe("카테고리별 기대 크기 (예: {\"bg\": {\"w\": 390, \"h\": 844}})"),
        extensions: z.array(z.string()).default(["png", "jpg", "ogg", "mp3", "json", "wav"]).describe("허용 확장자"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const assetsDir = path.resolve(params.assets_dir);
      const allFiles = walkDir(assetsDir);
      const extSet = new Set(params.extensions);

      // 네이밍 패턴 구성
      let namingRe: RegExp;
      if (params.naming_pattern) {
        try {
          namingRe = new RegExp(params.naming_pattern);
        } catch {
          return {
            content: [{ type: "text" as const, text: `naming_pattern 정규식 오류: ${params.naming_pattern}` }],
            isError: true,
          };
        }
      } else {
        // 기본: [word]_[word](s).ext — 카테고리 없이 범용 소문자+언더스코어
        namingRe = /^[a-z0-9]+(_[a-z0-9]+)*\.[a-z0-9]+$/;
      }

      const results: Array<{
        file: string;
        valid: boolean;
        errors: string[];
        size?: { w: number; h: number };
      }> = [];

      for (const fullPath of allFiles) {
        const fileName = path.basename(fullPath);
        const relPath = fullPath.replace(assetsDir, "").replace(/^[\\/]/, "");
        const ext = path.extname(fileName).replace(".", "").toLowerCase();
        const errors: string[] = [];

        // 확장자 검사
        if (!extSet.has(ext)) {
          errors.push(`허용되지 않는 확장자: .${ext}`);
        }

        // 네이밍 패턴 검사
        if (!namingRe.test(fileName)) {
          errors.push(`네이밍 패턴 불일치`);
        }

        // 대소문자 / 하이픈 / 공백 검사
        if (/[A-Z]/.test(fileName)) errors.push("대문자 사용 금지");
        if (/-/.test(fileName)) errors.push("하이픈(-) 사용 금지 (언더스코어만 허용)");
        if (/ /.test(fileName)) errors.push("공백 사용 금지");

        // 카테고리 코드 검사
        if (params.valid_categories && params.valid_categories.length > 0) {
          const cat = fileName.split("_")[0];
          if (!params.valid_categories.includes(cat)) {
            errors.push(`허용되지 않는 카테고리 코드: '${cat}' (허용: ${params.valid_categories.join(", ")})`);
          }
        }

        // PNG 크기 검사
        let sizeInfo: { w: number; h: number } | undefined;
        if (params.size_rules && fileName.endsWith(".png")) {
          try {
            const cat = fileName.split("_")[0];
            const expected = params.size_rules[cat];
            if (expected) {
              const metadata = await sharp(fullPath).metadata();
              const w = metadata.width || 0;
              const h = metadata.height || 0;
              sizeInfo = { w, h };
              if (w !== expected.w || h !== expected.h) {
                errors.push(`크기 불일치: ${w}×${h}px (기대: ${expected.w}×${expected.h}px)`);
              }
            }
          } catch {
            errors.push("PNG 메타데이터 읽기 실패");
          }
        }

        results.push({
          file: relPath,
          valid: errors.length === 0,
          errors,
          ...(sizeInfo ? { size: sizeInfo } : {}),
        });
      }

      const passed = results.filter((r) => r.valid);
      const failed = results.filter((r) => !r.valid);

      const output = {
        assets_dir: assetsDir,
        summary: {
          total: results.length,
          passed: passed.length,
          failed: failed.length,
        },
        errors: failed.map((r) => ({ file: r.file, errors: r.errors, size: r.size })),
        passed_files: passed.map((r) => r.file),
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 2. Atlas JSON 생성 ──────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_atlas_json",
    {
      title: "Generate Sprite Atlas JSON",
      description: `스프라이트 시트 정보를 입력하면 게임 엔진 호환 Atlas JSON을 생성합니다.

**지원 포맷**:
- \`phaser\` : Phaser 3 TexturePacker 호환 (frames + meta + animations)
- \`unity\`  : Unity TexturePacker 호환 JSON
- \`cocos\`  : Cocos Creator 호환 JSON
- \`generic\`: 엔진 무관 범용 포맷

**프레임 키 네이밍**:
\`[sheet_name]_[action]_[번호 2자리]\`
예: char_enemy_basic_walk_00, char_enemy_basic_walk_01

**피벗 포인트 가이드**:
- 캐릭터/적: pivot_y = 1.0 (발바닥 기준)
- 포탑/회전체: pivot_x = 0.5, pivot_y = 0.5 (중심)
- 투사체: pivot_x = 0.0, pivot_y = 0.5 (발사점)
- 이펙트: pivot_x = 0.5, pivot_y = 0.5 (중심)

Args:
  - sheet_name: 시트 이름 (예: char_enemy_basic)
  - frame_width: 프레임 1개 너비 (px)
  - frame_height: 프레임 1개 높이 (px)
  - animations: [{name, frame_count, row}] 애니메이션 목록
  - format: 출력 포맷 (phaser | unity | cocos | generic, 기본: phaser)
  - pivot_x: 피벗 x (0~1, 기본 0.5)
  - pivot_y: 피벗 y (0~1, 기본 1.0)
  - output_file: 저장할 JSON 파일 경로 (없으면 반환만)

Returns:
  Atlas JSON 내용 및 저장 경로.`,
      inputSchema: z.object({
        sheet_name: z.string().min(1).describe("스프라이트 시트 이름 (예: char_player, enemy_slime)"),
        frame_width: z.number().int().min(1).describe("프레임 너비 (px)"),
        frame_height: z.number().int().min(1).describe("프레임 높이 (px)"),
        animations: z.array(z.object({
          name: z.string().describe("애니메이션 이름 (예: idle, walk, attack, death)"),
          frame_count: z.number().int().min(1).describe("프레임 수"),
          row: z.number().int().min(0).describe("시트에서 이 애니메이션의 행 번호 (0부터)"),
        })).min(1).describe("애니메이션 목록"),
        format: z.enum(["phaser", "unity", "cocos", "generic"]).default("phaser").describe("출력 포맷"),
        pivot_x: z.number().min(0).max(1).default(0.5).describe("피벗 x (0~1)"),
        pivot_y: z.number().min(0).max(1).default(1.0).describe("피벗 y (0~1)"),
        output_file: z.string().optional().describe("JSON 저장 경로"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const frames: Record<string, object> = {};
      const maxFrames = Math.max(...params.animations.map((a) => a.frame_count));
      const maxRow = Math.max(...params.animations.map((a) => a.row));
      const sheetWidth = maxFrames * params.frame_width;
      const sheetHeight = (maxRow + 1) * params.frame_height;

      for (const anim of params.animations) {
        for (let i = 0; i < anim.frame_count; i++) {
          const key = `${params.sheet_name}_${anim.name}_${String(i).padStart(2, "0")}`;
          const frameRect = {
            x: i * params.frame_width,
            y: anim.row * params.frame_height,
            w: params.frame_width,
            h: params.frame_height,
          };

          if (params.format === "phaser") {
            frames[key] = {
              frame: frameRect,
              rotated: false,
              trimmed: false,
              spriteSourceSize: { x: 0, y: 0, w: params.frame_width, h: params.frame_height },
              sourceSize: { w: params.frame_width, h: params.frame_height },
              pivot: { x: params.pivot_x, y: params.pivot_y },
            };
          } else if (params.format === "unity") {
            frames[key] = {
              ...frameRect,
              pivot: { x: params.pivot_x, y: 1 - params.pivot_y }, // Unity는 y축 반전
            };
          } else if (params.format === "cocos") {
            frames[key] = {
              spriteSize: `{${params.frame_width},${params.frame_height}}`,
              spriteSourceSize: `{${params.frame_width},${params.frame_height}}`,
              textureRect: `{{${frameRect.x},${frameRect.y}},{${params.frame_width},${params.frame_height}}}`,
              textureRotated: false,
            };
          } else {
            // generic
            frames[key] = {
              x: frameRect.x, y: frameRect.y,
              w: params.frame_width, h: params.frame_height,
              pivot_x: params.pivot_x, pivot_y: params.pivot_y,
            };
          }
        }
      }

      const animationMap = Object.fromEntries(
        params.animations.map((anim) => [
          anim.name,
          Array.from({ length: anim.frame_count }, (_, i) =>
            `${params.sheet_name}_${anim.name}_${String(i).padStart(2, "0")}`
          ),
        ])
      );

      let atlas: object;
      if (params.format === "phaser") {
        atlas = {
          frames,
          meta: {
            app: "minigame-assets-mcp",
            image: `${params.sheet_name}_sheet.png`,
            size: { w: sheetWidth, h: sheetHeight },
            scale: 1,
          },
          animations: animationMap,
        };
      } else if (params.format === "cocos") {
        atlas = {
          frames,
          metadata: {
            format: 2,
            size: `{${sheetWidth},${sheetHeight}}`,
            realTextureFileName: `${params.sheet_name}_sheet.png`,
            textureFileName: `${params.sheet_name}_sheet.png`,
          },
          animations: animationMap,
        };
      } else {
        atlas = {
          frames,
          meta: {
            image: `${params.sheet_name}_sheet.png`,
            size: { w: sheetWidth, h: sheetHeight },
            format: params.format,
          },
          animations: animationMap,
        };
      }

      if (params.output_file) {
        fs.writeFileSync(path.resolve(params.output_file), JSON.stringify(atlas, null, 2), "utf-8");
      }

      const output = {
        success: true,
        sheet_name: params.sheet_name,
        format: params.format,
        sheet_size: { w: sheetWidth, h: sheetHeight },
        frame_size: { w: params.frame_width, h: params.frame_height },
        total_frames: Object.keys(frames).length,
        animations: params.animations.map((a) => ({ name: a.name, frames: a.frame_count })),
        output_file: params.output_file ? path.resolve(params.output_file) : null,
        atlas,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );

  // ── 3. 누락 에셋 목록 ───────────────────────────────────────────────────────
  server.registerTool(
    "asset_list_missing",
    {
      title: "List Missing Assets",
      description: `필수 에셋 목록과 비교하여 폴더에 없는 파일을 반환합니다.

**필수 목록 소스** (우선순위 순):
1. \`required_assets\` 파라미터로 직접 지정
2. \`spec_file\` JSON 파일에서 로드 (\`required_assets\` 배열 키)
3. \`concept_md\` CONCEPT.md에서 에셋 ID 목록 추출 (테이블 첫 번째 컬럼)

세 가지 모두 없으면 현재 폴더에 있는 파일만 나열합니다.

Args:
  - assets_dir: 에셋 폴더 경로
  - required_assets: 필수 파일 목록 (상대 경로, 직접 지정)
  - spec_file: 필수 에셋 목록이 담긴 JSON 파일 경로
  - concept_md: CONCEPT.md 경로 (에셋 ID 추출용)
  - extensions: 파일 존재 확인 시 시도할 확장자 (기본: [png, json])

Returns:
  누락 파일 목록과 완료율.`,
      inputSchema: z.object({
        assets_dir: z.string().min(1).describe("에셋 폴더 경로"),
        required_assets: z.array(z.string()).optional().describe("필수 파일 상대 경로 목록 (직접 지정)"),
        spec_file: z.string().optional().describe("required_assets 배열이 담긴 JSON 파일 경로"),
        concept_md: z.string().optional().describe("CONCEPT.md 경로 (에셋 ID 자동 추출)"),
        extensions: z.array(z.string()).default(["png", "json"]).describe("존재 확인 시 시도할 확장자"),
      }).strict(),
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      const assetsDir = path.resolve(params.assets_dir);

      // 필수 목록 로드 (우선순위)
      let required: string[] = [];

      if (params.required_assets && params.required_assets.length > 0) {
        // 1. 직접 지정
        required = params.required_assets;
      } else if (params.spec_file) {
        // 2. JSON 스펙 파일에서 로드
        try {
          const specPath = path.resolve(params.spec_file);
          const spec = JSON.parse(fs.readFileSync(specPath, "utf-8")) as Record<string, unknown>;
          if (Array.isArray(spec["required_assets"])) {
            required = spec["required_assets"] as string[];
          }
        } catch {
          return {
            content: [{ type: "text" as const, text: `spec_file 로드 실패: ${params.spec_file}` }],
            isError: true,
          };
        }
      } else if (params.concept_md) {
        // 3. CONCEPT.md에서 에셋 ID 추출
        const conceptPath = path.resolve(params.concept_md);
        const ids = extractAssetIdsFromConceptMd(conceptPath);
        // ID만 있으므로 extensions를 조합해서 파일 후보 생성
        for (const id of ids) {
          for (const ext of params.extensions) {
            required.push(`${id}.${ext}`);
          }
        }
      }

      if (required.length === 0) {
        // 필수 목록 없음 — 현재 파일 목록만 반환
        const existing = walkDir(assetsDir).map((f) =>
          f.replace(assetsDir, "").replace(/^[\\/]/, "")
        );
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              assets_dir: assetsDir,
              message: "required_assets, spec_file, concept_md 중 하나를 지정해야 누락 목록을 확인할 수 있습니다.",
              existing_files: existing,
              total_existing: existing.length,
            }, null, 2),
          }],
        };
      }

      const missing: string[] = [];
      const present: string[] = [];

      for (const rel of required) {
        const fullPath = path.join(assetsDir, rel);
        if (fs.existsSync(fullPath)) {
          present.push(rel);
        } else {
          missing.push(rel);
        }
      }

      const output = {
        assets_dir: assetsDir,
        source: params.required_assets
          ? "direct"
          : params.spec_file
          ? "spec_file"
          : "concept_md",
        summary: {
          total_required: required.length,
          present: present.length,
          missing: missing.length,
          completion: `${Math.round((present.length / required.length) * 100)}%`,
        },
        missing_files: missing,
        present_files: present,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
        structuredContent: output,
      };
    }
  );
}
