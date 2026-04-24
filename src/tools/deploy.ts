import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { ensureDir } from "../utils/files.js";
import {
  loadDeployMap,
  saveDeployMap,
  approveEntry,
  revokeEntry,
  entryNeedsReapproval,
  hashFile,
  type DeployEntry,
  type DeployTarget,
  type DeployFormat,
} from "../utils/deploy-map.js";

function resolveEntries(
  requested: string[] | "all" | undefined,
  available: string[]
): string[] {
  if (!requested || requested === "all") return available;
  if (typeof requested === "string") return [requested];
  return requested;
}

function formatFromPath(targetPath: string, override?: DeployFormat): DeployFormat {
  if (override) return override;
  const ext = path.extname(targetPath).toLowerCase();
  if (ext === ".webp") return "webp";
  if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
  return "png";
}

async function resizeAndWrite(
  masterAbsPath: string,
  target: DeployTarget,
  projectRoot: string
): Promise<{ deployed: boolean; targetAbs: string; bytes: number }> {
  const targetAbs = path.isAbsolute(target.path)
    ? target.path
    : path.resolve(projectRoot, target.path);
  const format = formatFromPath(target.path, target.format);
  const fit = target.fit ?? "cover";

  let pipeline = sharp(masterAbsPath).resize(target.width, target.height, { fit });
  if (format === "webp") pipeline = pipeline.webp({ quality: 90 });
  else if (format === "jpeg") pipeline = pipeline.jpeg({ quality: 90 });
  else pipeline = pipeline.png({ compressionLevel: 9 });

  const newBuffer = await pipeline.toBuffer();

  // idempotent: 기존 파일과 바이트 동일하면 재작성 스킵
  if (fs.existsSync(targetAbs)) {
    const existing = fs.readFileSync(targetAbs);
    if (existing.equals(newBuffer)) {
      return { deployed: false, targetAbs, bytes: existing.length };
    }
  }

  ensureDir(path.dirname(targetAbs));
  fs.writeFileSync(targetAbs, newBuffer);
  return { deployed: true, targetAbs, bytes: newBuffer.length };
}

export function registerDeployTools(server: McpServer): void {
  // ── asset_approve ────────────────────────────────────────────────────────
  server.registerTool(
    "asset_approve",
    {
      title: "Approve assets for deployment",
      description: `Mark master assets as "approved" — only approved entries are copied to code paths by asset_deploy.

approved 시점의 master_hash 가 approved_hash 로 고정됩니다. 이후 마스터가 변경되면 asset_deploy 가 "재확정 필요" 경고를 띄우며 배포를 건너뜁니다.

Args:
  - entries (string[] | "all"): 매니페스트 엔트리 키(마스터 상대경로) 또는 "all"
  - output_dir (string, optional): 마스터 저장 디렉터리 (default: ASSETS_OUTPUT_DIR env or ./.minigame-assets)

Returns:
  approved: 확정된 엔트리 키 배열
  skipped: [{entry, reason}] (missing_master | not_in_manifest)`,
      inputSchema: z.object({
        entries: z.union([z.array(z.string()), z.literal("all")]).describe("엔트리 키 배열 또는 \"all\""),
        output_dir: z.string().optional(),
      }).shape,
    },
    async (params) => {
      const outputDir = params.output_dir ?? DEFAULT_OUTPUT_DIR;
      const map = loadDeployMap(outputDir);
      const keys = resolveEntries(params.entries, Object.keys(map.entries));

      const approved: string[] = [];
      const skipped: Array<{ entry: string; reason: string }> = [];
      for (const k of keys) {
        const res = approveEntry(map, k);
        if (res.ok) approved.push(k);
        else skipped.push({ entry: k, reason: res.reason });
      }
      saveDeployMap(outputDir, map);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ approved, skipped, total_entries: Object.keys(map.entries).length }, null, 2),
        }],
      };
    }
  );

  // ── asset_revoke ─────────────────────────────────────────────────────────
  server.registerTool(
    "asset_revoke",
    {
      title: "Revoke approval (keep history)",
      description: `Remove the "approved" flag from entries. 엔트리 자체는 매니페스트에 남겨둡니다 (이력 보존).

Args:
  - entries (string[]): 해제할 엔트리 키 배열
  - output_dir (string, optional)

Returns:
  revoked: 해제된 엔트리 키 배열
  skipped: [{entry, reason}]`,
      inputSchema: z.object({
        entries: z.array(z.string()),
        output_dir: z.string().optional(),
      }).shape,
    },
    async (params) => {
      const outputDir = params.output_dir ?? DEFAULT_OUTPUT_DIR;
      const map = loadDeployMap(outputDir);

      const revoked: string[] = [];
      const skipped: Array<{ entry: string; reason: string }> = [];
      for (const k of params.entries) {
        const res = revokeEntry(map, k);
        if (res.ok) revoked.push(k);
        else skipped.push({ entry: k, reason: res.reason });
      }
      saveDeployMap(outputDir, map);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({ revoked, skipped }, null, 2),
        }],
      };
    }
  );

  // ── asset_deploy ─────────────────────────────────────────────────────────
  server.registerTool(
    "asset_deploy",
    {
      title: "Deploy approved masters to code paths",
      description: `Resize each approved master to its deploy_targets[].{width,height,format,fit} and write into code paths.

**승인 게이트**: approved=false 인 엔트리는 기본적으로 스킵됩니다 (force 로 override 가능).
**재확정 요구**: master_hash ≠ approved_hash 면 스킵하고 needs_reapproval 에 보고. asset_approve 를 다시 호출해야 배포됩니다.
**Idempotent**: 대상 경로에 이미 동일 바이트가 있으면 재작성하지 않습니다 (mtime 유지).

Args:
  - project_root (string, optional): deploy_targets[].path 의 기준 루트 (default: cwd)
  - output_dir (string, optional): 마스터 저장 디렉터리 (default: ./.minigame-assets)
  - dry_run (boolean, optional): 실제 복사 없이 계획만 출력 (default: false)
  - force (boolean, optional): approved 체크 무시 (default: false — 테스트용)
  - entries (string[], optional): 특정 엔트리만 배포 (생략 시 모든 approved 엔트리)

Returns:
  deployed: [{entry, target, width, height, bytes}]
  skipped: [{entry, target, reason}]   (not_approved | needs_reapproval | no_targets | unchanged | missing_master)
  warnings: string[]`,
      inputSchema: z.object({
        project_root: z.string().optional(),
        output_dir: z.string().optional(),
        dry_run: z.boolean().optional(),
        force: z.boolean().optional(),
        entries: z.array(z.string()).optional(),
      }).shape,
    },
    async (params) => {
      const outputDir = params.output_dir ?? DEFAULT_OUTPUT_DIR;
      const projectRoot = params.project_root ?? process.cwd();
      const dryRun = params.dry_run ?? false;
      const force = params.force ?? false;

      const map = loadDeployMap(outputDir);
      const keys = params.entries && params.entries.length > 0
        ? params.entries
        : Object.keys(map.entries);

      const deployed: Array<{ entry: string; target: string; width: number; height: number; bytes: number }> = [];
      const skipped: Array<{ entry: string; target?: string; reason: string }> = [];
      const warnings: string[] = [];

      for (const key of keys) {
        const entry: DeployEntry | undefined = map.entries[key];
        if (!entry) {
          skipped.push({ entry: key, reason: "not_in_manifest" });
          continue;
        }

        const masterAbs = path.isAbsolute(entry.master_path)
          ? entry.master_path
          : path.resolve(outputDir, entry.master_path);
        if (!fs.existsSync(masterAbs)) {
          skipped.push({ entry: key, reason: "missing_master" });
          continue;
        }

        if (!force && !entry.approved) {
          skipped.push({ entry: key, reason: "not_approved" });
          continue;
        }

        if (!force && entryNeedsReapproval(entry)) {
          skipped.push({ entry: key, reason: "needs_reapproval" });
          continue;
        }

        if (entry.deploy_targets.length === 0) {
          skipped.push({ entry: key, reason: "no_targets" });
          continue;
        }

        const currentHash = hashFile(masterAbs);
        for (const target of entry.deploy_targets) {
          if (dryRun) {
            deployed.push({
              entry: key,
              target: target.path,
              width: target.width,
              height: target.height,
              bytes: 0,
            });
            continue;
          }

          try {
            const res = await resizeAndWrite(masterAbs, target, projectRoot);
            if (res.deployed) {
              target.last_deployed_at = new Date().toISOString();
              target.last_deployed_hash = currentHash ?? undefined;
              deployed.push({
                entry: key,
                target: target.path,
                width: target.width,
                height: target.height,
                bytes: res.bytes,
              });
            } else {
              skipped.push({ entry: key, target: target.path, reason: "unchanged" });
            }
          } catch (err) {
            warnings.push(`${key} → ${target.path}: ${(err as Error).message}`);
          }
        }
      }

      if (!dryRun) saveDeployMap(outputDir, map);

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            dry_run: dryRun,
            force,
            deployed,
            skipped,
            warnings,
            summary: `${deployed.length} deployed, ${skipped.length} skipped, ${warnings.length} warnings`,
          }, null, 2),
        }],
      };
    }
  );
}
