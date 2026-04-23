/**
 * review.ts
 *
 * 생성된 에셋 품질·구조 검토 도구.
 *
 * 도구:
 *   - asset_review : 파일/디렉토리의 에셋을 체계적으로 검토
 *                    (구조 + 크로마 잔류 + 비주얼 AI 체크)
 *
 * 모드:
 *   - quick    : 구조·크로마 잔류만 (비 AI, 빠름)
 *   - standard : quick + 샘플링 비주얼 (Gemini Vision, 기본 30% 샘플링)
 *   - deep     : quick + 전수 비주얼 (높은 비용)
 *
 * 기존 자원 재사용:
 *   - checkSpriteFrameQuality (services/claude-vision.ts) — Gemini Vision 기반 프레임 체크
 *   - scanChromaResidue (utils/image-process.ts) — 크로마 픽셀 정량 측정
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { scanChromaResidue, type ChromaResidueReport } from "../utils/image-process.js";
import { checkSpriteFrameQuality } from "../services/claude-vision.js";
import { handleApiError } from "../utils/errors.js";

// ─── 타입 ────────────────────────────────────────────────────────────────────

type ReviewMode = "quick" | "standard" | "deep";

interface StructuralReport {
  fileSizeKB: number;
  width: number;
  height: number;
  hasAlpha: boolean;
  channels: number;
  issues: string[];
}

interface AssetReviewResult {
  file_path: string;
  file_name: string;
  passed: boolean;
  issues: string[];
  structural: StructuralReport;
  chroma_residue?: ChromaResidueReport;
  visual?: { passed: boolean; issues: string[] };
  skipped_visual?: boolean;
  skipped_visual_reason?: string;
}

// ─── 구조 체크 ────────────────────────────────────────────────────────────────

async function runStructuralCheck(
  filePath: string,
  opts: { expectAlpha: boolean; maxSizeKB?: number; minWidth?: number; minHeight?: number }
): Promise<StructuralReport> {
  const issues: string[] = [];
  const stat = fs.statSync(filePath);
  const fileSizeKB = Math.round(stat.size / 1024);

  if (opts.maxSizeKB && fileSizeKB > opts.maxSizeKB) {
    issues.push(`파일 크기 ${fileSizeKB}KB > 권장 한계 ${opts.maxSizeKB}KB`);
  }

  const meta = await sharp(filePath).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  const channels = meta.channels ?? 0;
  const hasAlpha = Boolean(meta.hasAlpha);

  if (width === 0 || height === 0) issues.push(`유효하지 않은 해상도 ${width}×${height}`);
  if (opts.minWidth && width < opts.minWidth) issues.push(`너비 ${width} < 권장 최소 ${opts.minWidth}`);
  if (opts.minHeight && height < opts.minHeight) issues.push(`높이 ${height} < 권장 최소 ${opts.minHeight}`);
  if (opts.expectAlpha && !hasAlpha) issues.push("알파 채널 없음 (투명 배경 에셋은 RGBA 필요)");

  return { fileSizeKB, width, height, hasAlpha, channels, issues };
}

// ─── 파일 탐색 ────────────────────────────────────────────────────────────────

function collectPngFiles(targetPath: string, maxFiles: number): string[] {
  const resolved = path.resolve(targetPath);
  if (!fs.existsSync(resolved)) throw new Error(`경로 없음: ${resolved}`);

  const stat = fs.statSync(resolved);
  if (stat.isFile()) {
    return resolved.toLowerCase().endsWith(".png") ? [resolved] : [];
  }

  // 디렉토리: 재귀 탐색
  const results: string[] = [];
  const walk = (dir: string) => {
    if (results.length >= maxFiles) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const ent of entries) {
      if (results.length >= maxFiles) return;
      const full = path.join(dir, ent.name);
      // 숨김·임시·매니페스트 파일 스킵
      if (ent.name.startsWith(".") || ent.name.startsWith("_")) continue;
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".png")) {
        results.push(full);
      }
    }
  };
  walk(resolved);
  return results.slice(0, maxFiles);
}

// ─── 에셋 타입 추론 ──────────────────────────────────────────────────────────

function inferAssetType(filePath: string): {
  type: "character" | "sprite" | "background" | "thumbnail" | "logo" | "weapon" | "other";
  expectAlpha: boolean;
} {
  const lower = filePath.toLowerCase();
  if (lower.includes("/sprites/") || lower.includes("_base.png")) {
    return { type: lower.includes("_base.png") ? "character" : "sprite", expectAlpha: true };
  }
  if (lower.includes("/backgrounds/") || lower.includes("/screens/")) {
    return { type: "background", expectAlpha: false };
  }
  if (lower.includes("/thumbnails/") || lower.includes("thumb")) {
    return { type: "thumbnail", expectAlpha: false };
  }
  if (lower.includes("/logos/") || lower.includes("logo")) {
    return { type: "logo", expectAlpha: true };
  }
  if (lower.includes("/weapons/")) {
    return { type: "weapon", expectAlpha: true };
  }
  return { type: "other", expectAlpha: false };
}

// ─── 메인 리뷰 로직 ──────────────────────────────────────────────────────────

async function reviewOneAsset(
  filePath: string,
  mode: ReviewMode,
  shouldRunVisual: boolean,
  characterHint?: string,
): Promise<AssetReviewResult> {
  const { type: assetType, expectAlpha } = inferAssetType(filePath);
  const issues: string[] = [];

  // 1. 구조 체크
  const structural = await runStructuralCheck(filePath, {
    expectAlpha,
    maxSizeKB: assetType === "thumbnail" ? 2048 : assetType === "background" ? 3072 : 1500,
    minWidth: 256,
    minHeight: 256,
  });
  for (const i of structural.issues) issues.push(`[structural] ${i}`);

  // 2. 크로마 잔류 스캔 (투명 에셋만)
  let chromaResidue: ChromaResidueReport | undefined;
  if (expectAlpha) {
    try {
      chromaResidue = await scanChromaResidue(filePath);
      if (chromaResidue.residuePixels > 50) {
        issues.push(
          `[chroma] 마젠타 잔류 ${chromaResidue.residuePixels}px (${chromaResidue.residuePercent.toFixed(3)}%), ` +
          `최대 클러스터 ${chromaResidue.largestCluster}px`
        );
      }
    } catch (e) {
      issues.push(`[chroma] 스캔 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  // 3. 비주얼 체크 (AI)
  let visual: AssetReviewResult["visual"];
  let skippedVisual = false;
  let skippedReason: string | undefined;

  if (!shouldRunVisual) {
    skippedVisual = true;
    skippedReason = mode === "quick" ? "mode=quick (비주얼 스킵)" : "샘플링 미선택";
  } else if (assetType === "background" || assetType === "thumbnail" || assetType === "logo") {
    // checkSpriteFrameQuality는 캐릭터 프레임 기준이라 배경/로고엔 부적합
    skippedVisual = true;
    skippedReason = `비주얼 체크는 character/sprite 전용 (현재: ${assetType})`;
  } else {
    try {
      const b64 = fs.readFileSync(filePath).toString("base64");
      const r = await checkSpriteFrameQuality(b64, characterHint);
      visual = { passed: r.passed, issues: r.issues };
      if (!r.passed) {
        for (const i of r.issues) issues.push(`[visual] ${i}`);
      }
    } catch (e) {
      issues.push(`[visual] 체크 실패: ${e instanceof Error ? e.message : e}`);
    }
  }

  return {
    file_path: filePath,
    file_name: path.basename(filePath),
    passed: issues.length === 0,
    issues,
    structural,
    chroma_residue: chromaResidue,
    visual,
    skipped_visual: skippedVisual,
    skipped_visual_reason: skippedReason,
  };
}

// ─── 마크다운 리포트 생성 ────────────────────────────────────────────────────

function buildMarkdownReport(
  targetPath: string,
  mode: ReviewMode,
  results: AssetReviewResult[],
  elapsedMs: number,
): string {
  const passed = results.filter((r) => r.passed).length;
  const failed = results.length - passed;

  const lines: string[] = [];
  lines.push(`# Asset Review Report`);
  lines.push("");
  lines.push(`- **Target**: \`${targetPath}\``);
  lines.push(`- **Mode**: ${mode}`);
  lines.push(`- **Total assets**: ${results.length}`);
  lines.push(`- **Passed**: ${passed}`);
  lines.push(`- **Failed**: ${failed}`);
  lines.push(`- **Elapsed**: ${(elapsedMs / 1000).toFixed(1)}s`);
  lines.push("");
  lines.push(`## 요약 상단 — 실패 에셋`);
  lines.push("");
  const failedAssets = results.filter((r) => !r.passed);
  if (failedAssets.length === 0) {
    lines.push("_모든 에셋이 통과했습니다._");
  } else {
    for (const r of failedAssets) {
      lines.push(`### ❌ ${r.file_name}`);
      lines.push(`\`${r.file_path}\``);
      lines.push("");
      lines.push(`- 해상도: ${r.structural.width}×${r.structural.height}, alpha=${r.structural.hasAlpha}, ${r.structural.fileSizeKB}KB`);
      if (r.chroma_residue && r.chroma_residue.residuePixels > 0) {
        lines.push(`- 크로마 잔류: ${r.chroma_residue.residuePixels}px (${r.chroma_residue.residuePercent.toFixed(3)}%)`);
      }
      lines.push(`- Issues:`);
      for (const iss of r.issues) lines.push(`  - ${iss}`);
      lines.push("");
    }
  }

  lines.push(`## 전체 결과`);
  lines.push("");
  lines.push(`| File | Passed | Issues | Visual |`);
  lines.push(`|------|--------|--------|--------|`);
  for (const r of results) {
    const visualStr = r.skipped_visual ? "—" : r.visual?.passed ? "✅" : "❌";
    lines.push(`| ${r.file_name} | ${r.passed ? "✅" : "❌"} | ${r.issues.length} | ${visualStr} |`);
  }
  lines.push("");

  return lines.join("\n");
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerReviewTools(server: McpServer): void {
  server.registerTool(
    "asset_review",
    {
      title: "Review Generated Assets (품질·구조 종합 검토)",
      description: `생성된 에셋을 종합 검토합니다. 파일 또는 디렉토리를 받아 각 PNG에 대해:

**체크 항목**:
1. **구조**: 해상도, 파일 크기, 알파 채널 (투명 에셋 예상 시), PNG 무결성
2. **크로마 잔류**: 투명 에셋에 남은 마젠타(#FF00FF) 픽셀 정량 측정 + 최대 클러스터 크기
   (외곽선 닫힌 포켓의 residue 검출 — 겨드랑이/다리 사이 등)
3. **비주얼 AI 체크**: Gemini Vision으로 full-body·anatomy·single-character·배경 클린 평가
   (character/sprite 타입만, 배경/썸네일은 스킵)

**모드**:
- \`quick\`: 구조 + 크로마만 (비 AI, 초고속, 무료)
- \`standard\`: quick + 비주얼 샘플링 (각 캐릭터 디렉토리 첫 N개, 기본 5장)
- \`deep\`: quick + 전수 비주얼 (비용 높음, 대량 검토 시 주의)

**사용 예**:
- 한 캐릭터 검토: target_path: "generated-assets/sprites/hero", mode: "standard"
- 전체 프로젝트 검토: target_path: "generated-assets", mode: "quick"
- 단일 파일 심층: target_path: "some.png", mode: "deep"

Args:
  - target_path (string): PNG 파일 또는 디렉토리 경로
  - mode (string): "quick" | "standard" | "deep" (기본: "standard")
  - character_hint (string, optional): 비주얼 체크에 제공할 캐릭터 설명 (정확도 향상)
  - max_assets (number, optional): 검토할 최대 PNG 개수 (기본: 50, 안전장치)
  - sample_size (number, optional): standard 모드에서 비주얼 체크할 최대 파일 수 (기본: 5)
  - output_report_path (string, optional): 마크다운 리포트 저장 경로. 미지정 시 JSON만 반환.

Returns:
  JSON: summary{ total, passed, failed } + assets[]{file_path, passed, issues, structural, chroma_residue, visual}
  + (output_report_path 지정 시) 마크다운 리포트 파일 저장.`,
      inputSchema: z.object({
        target_path: z.string().min(1).describe("PNG 파일 또는 디렉토리 경로"),
        mode: z.enum(["quick", "standard", "deep"]).default("standard"),
        character_hint: z.string().max(500).optional()
          .describe("비주얼 체크용 캐릭터 설명 (예: 'green alien soldier in black armor')"),
        max_assets: z.number().int().min(1).max(1000).default(50)
          .describe("최대 검토 PNG 개수 (안전장치)"),
        sample_size: z.number().int().min(1).max(200).default(5)
          .describe("standard 모드에서 비주얼 체크할 최대 에셋 수"),
        output_report_path: z.string().optional()
          .describe("마크다운 리포트 저장 경로 (미지정 시 JSON만 반환)"),
      }).strict(),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (params) => {
      const started = Date.now();
      try {
        const files = collectPngFiles(params.target_path, params.max_assets);
        if (files.length === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ success: false, reason: "PNG 파일을 찾을 수 없음", target_path: params.target_path }, null, 2),
            }],
          };
        }

        // 비주얼 체크 대상 결정
        let visualFiles = new Set<string>();
        if (params.mode === "deep") {
          for (const f of files) visualFiles.add(f);
        } else if (params.mode === "standard") {
          // 단순 앞에서 N개 — 정교한 샘플링은 호출자가 디렉토리 좁혀서 해결
          for (const f of files.slice(0, params.sample_size)) visualFiles.add(f);
        }

        // 각 에셋 순차 검토 (비주얼은 API 호출이라 과도한 병렬 피함)
        const results: AssetReviewResult[] = [];
        for (const f of files) {
          const shouldVisual = visualFiles.has(f);
          const r = await reviewOneAsset(f, params.mode, shouldVisual, params.character_hint);
          results.push(r);
        }

        const elapsedMs = Date.now() - started;
        const passed = results.filter((r) => r.passed).length;
        const failed = results.length - passed;

        // 권장사항 집계
        const recommendations: string[] = [];
        const chromaResidueIssues = results.filter((r) =>
          r.chroma_residue && r.chroma_residue.residuePixels > 50
        );
        if (chromaResidueIssues.length > 0) {
          recommendations.push(
            `${chromaResidueIssues.length}개 에셋에 마젠타 잔류 발견 — removeBackground 재처리 필요 (src/utils/image-process.ts의 residue 패스 확인)`
          );
        }
        const visualFailures = results.filter((r) => r.visual && !r.visual.passed);
        if (visualFailures.length > 0) {
          recommendations.push(
            `${visualFailures.length}개 에셋이 비주얼 체크 실패 — 개별 issues 확인 후 재생성 고려`
          );
        }
        const alphaFailures = results.filter((r) =>
          r.structural.issues.some((i) => i.includes("알파 채널"))
        );
        if (alphaFailures.length > 0) {
          recommendations.push(
            `${alphaFailures.length}개 에셋이 알파 채널 누락 — 투명 배경 파이프라인 점검 필요`
          );
        }

        const output = {
          success: true,
          target_path: path.resolve(params.target_path),
          mode: params.mode,
          elapsed_ms: elapsedMs,
          summary: {
            total: results.length,
            passed,
            failed,
            visual_checked: results.filter((r) => !r.skipped_visual).length,
            visual_skipped: results.filter((r) => r.skipped_visual).length,
          },
          recommendations,
          assets: results,
        };

        // 마크다운 리포트 저장 (선택)
        let reportPath: string | undefined;
        if (params.output_report_path) {
          reportPath = path.resolve(params.output_report_path);
          const dir = path.dirname(reportPath);
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(
            reportPath,
            buildMarkdownReport(path.resolve(params.target_path), params.mode, results, elapsedMs),
          );
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify(
              reportPath ? { ...output, report_file: reportPath } : output,
              null,
              2,
            ),
          }],
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Asset Review") }],
          isError: true,
        };
      }
    },
  );
}
