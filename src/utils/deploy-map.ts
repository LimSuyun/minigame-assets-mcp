import * as fs from "fs";
import * as path from "path";
import { createHash } from "crypto";
import { ensureDir } from "./files.js";

export const DEPLOY_MAP_FILENAME = "deploy-map.json";

export type DeployFit = "cover" | "contain" | "fill" | "inside" | "outside";
export type DeployFormat = "png" | "webp" | "jpeg";

export interface DeployTarget {
  path: string;
  width: number;
  height: number;
  fit?: DeployFit;
  format?: DeployFormat;
  source_lines?: string[];
  last_deployed_at?: string;
  last_deployed_hash?: string;
}

export interface DeployEntry {
  master_path: string;
  master_hash: string | null;
  master_width: number | null;
  master_height: number | null;
  master_size_bytes: number | null;
  updated_at: string;
  deploy_targets: DeployTarget[];
  approved: boolean;
  approved_at: string | null;
  approved_hash: string | null;
}

export interface DeployMap {
  version: 1;
  generated_at: string;
  entries: Record<string, DeployEntry>;
}

export function getDeployMapPath(outputDir: string): string {
  return path.resolve(outputDir, DEPLOY_MAP_FILENAME);
}

export function loadDeployMap(outputDir: string): DeployMap {
  const p = getDeployMapPath(outputDir);
  if (fs.existsSync(p)) {
    try {
      const raw = fs.readFileSync(p, "utf-8");
      const parsed = JSON.parse(raw) as DeployMap;
      if (parsed.version === 1 && parsed.entries) return parsed;
    } catch {
      // fall through to fresh map
    }
  }
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    entries: {},
  };
}

export function saveDeployMap(outputDir: string, map: DeployMap): void {
  ensureDir(outputDir);
  map.generated_at = new Date().toISOString();
  fs.writeFileSync(getDeployMapPath(outputDir), JSON.stringify(map, null, 2), "utf-8");
}

export function hashFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  const hash = createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return `sha256:${hash.digest("hex")}`;
}

/**
 * 마스터 경로를 매니페스트 키로 정규화한다.
 *  - outputDir 기준 상대경로
 *  - POSIX 슬래시
 */
export function toEntryKey(outputDir: string, masterAbsPath: string): string {
  const rel = path.relative(path.resolve(outputDir), path.resolve(masterAbsPath));
  return rel.split(path.sep).join("/");
}

/**
 * 신규/기존 엔트리를 생성·갱신한다. approved 는 건드리지 않는다.
 * 반환: 기존 entry 가 없었으면 "created", 있었으면 "updated" | "unchanged".
 */
export function upsertEntry(
  map: DeployMap,
  outputDir: string,
  masterAbsPath: string,
  metadata?: { width?: number | null; height?: number | null }
): { key: string; status: "created" | "updated" | "unchanged"; entry: DeployEntry } {
  const key = toEntryKey(outputDir, masterAbsPath);
  const existing = map.entries[key];
  const hash = hashFile(masterAbsPath);
  const stats = fs.existsSync(masterAbsPath) ? fs.statSync(masterAbsPath) : null;
  const now = new Date().toISOString();

  if (!existing) {
    const entry: DeployEntry = {
      master_path: key,
      master_hash: hash,
      master_width: metadata?.width ?? null,
      master_height: metadata?.height ?? null,
      master_size_bytes: stats?.size ?? null,
      updated_at: now,
      deploy_targets: [],
      approved: false,
      approved_at: null,
      approved_hash: null,
    };
    map.entries[key] = entry;
    return { key, status: "created", entry };
  }

  const unchanged =
    existing.master_hash === hash &&
    existing.master_size_bytes === (stats?.size ?? null) &&
    (metadata?.width == null || existing.master_width === metadata.width) &&
    (metadata?.height == null || existing.master_height === metadata.height);

  if (unchanged) return { key, status: "unchanged", entry: existing };

  existing.master_hash = hash;
  existing.master_size_bytes = stats?.size ?? null;
  if (metadata?.width != null) existing.master_width = metadata.width;
  if (metadata?.height != null) existing.master_height = metadata.height;
  existing.updated_at = now;
  return { key, status: "updated", entry: existing };
}

export function approveEntry(
  map: DeployMap,
  key: string
): { ok: true; entry: DeployEntry } | { ok: false; reason: string } {
  const entry = map.entries[key];
  if (!entry) return { ok: false, reason: "not_in_manifest" };
  if (entry.master_hash == null) return { ok: false, reason: "missing_master" };
  entry.approved = true;
  entry.approved_at = new Date().toISOString();
  entry.approved_hash = entry.master_hash;
  return { ok: true, entry };
}

export function revokeEntry(
  map: DeployMap,
  key: string
): { ok: true; entry: DeployEntry } | { ok: false; reason: string } {
  const entry = map.entries[key];
  if (!entry) return { ok: false, reason: "not_in_manifest" };
  entry.approved = false;
  return { ok: true, entry };
}

export function entryNeedsReapproval(entry: DeployEntry): boolean {
  if (!entry.approved) return false;
  if (!entry.master_hash || !entry.approved_hash) return true;
  return entry.master_hash !== entry.approved_hash;
}
