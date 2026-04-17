/**
 * canon.ts
 *
 * Canon 레지스트리 CRUD 유틸리티.
 * Canon = 한 번만 생성되는 마스터 레퍼런스 에셋.
 * 모든 파생 에셋은 Canon을 기준으로 스타일/색상 일관성을 유지해야 함.
 *
 * 저장 경로: {outputDir}/canon/canon_registry.json
 */

import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CANON_DIR, DEFAULT_CANON_REGISTRY_FILE } from "../constants.js";
import type { CanonEntry, CanonRegistry } from "../types.js";

export function getCanonDir(outputDir: string = DEFAULT_OUTPUT_DIR): string {
  return path.resolve(outputDir, DEFAULT_CANON_DIR);
}

export function getCanonRegistryPath(outputDir: string = DEFAULT_OUTPUT_DIR): string {
  return path.join(getCanonDir(outputDir), DEFAULT_CANON_REGISTRY_FILE);
}

export function loadCanonRegistry(outputDir: string = DEFAULT_OUTPUT_DIR): CanonRegistry {
  const registryPath = getCanonRegistryPath(outputDir);
  if (fs.existsSync(registryPath)) {
    try {
      const data = fs.readFileSync(registryPath, "utf-8");
      return JSON.parse(data) as CanonRegistry;
    } catch {
      // 손상된 파일 → 빈 레지스트리로 시작
    }
  }
  return {
    version: "1.0",
    entries: [],
    last_updated: new Date().toISOString(),
  };
}

export function saveCanonRegistry(
  registry: CanonRegistry,
  outputDir: string = DEFAULT_OUTPUT_DIR
): void {
  const canonDir = getCanonDir(outputDir);
  if (!fs.existsSync(canonDir)) {
    fs.mkdirSync(canonDir, { recursive: true });
  }
  registry.last_updated = new Date().toISOString();
  const registryPath = getCanonRegistryPath(outputDir);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2), "utf-8");
}

/**
 * Canon 엔트리 등록 (동일 id 존재 시 덮어쓰기).
 */
export function registerCanonEntry(
  entry: CanonEntry,
  outputDir: string = DEFAULT_OUTPUT_DIR
): CanonRegistry {
  const registry = loadCanonRegistry(outputDir);
  const existingIdx = registry.entries.findIndex((e) => e.id === entry.id);
  if (existingIdx >= 0) {
    registry.entries[existingIdx] = entry;
  } else {
    registry.entries.push(entry);
  }
  saveCanonRegistry(registry, outputDir);
  return registry;
}

/**
 * ID로 Canon 엔트리 조회.
 */
export function getCanonEntry(
  id: string,
  outputDir: string = DEFAULT_OUTPUT_DIR
): CanonEntry | null {
  const registry = loadCanonRegistry(outputDir);
  return registry.entries.find((e) => e.id === id) ?? null;
}

/**
 * 타입별 Canon 엔트리 목록 반환.
 */
export function findCanonByType(
  type: CanonEntry["type"],
  outputDir: string = DEFAULT_OUTPUT_DIR
): CanonEntry[] {
  const registry = loadCanonRegistry(outputDir);
  return registry.entries.filter((e) => e.type === type);
}

/**
 * 태그로 Canon 엔트리 검색 (부분 일치).
 */
export function searchCanonByTags(
  tags: string[],
  outputDir: string = DEFAULT_OUTPUT_DIR
): CanonEntry[] {
  const registry = loadCanonRegistry(outputDir);
  const lowerTags = tags.map((t) => t.toLowerCase());
  return registry.entries.filter((e) =>
    e.tags?.some((tag) => lowerTags.some((lt) => tag.toLowerCase().includes(lt)))
  );
}

/**
 * Canon 엔트리 삭제.
 */
export function removeCanonEntry(
  id: string,
  outputDir: string = DEFAULT_OUTPUT_DIR
): boolean {
  const registry = loadCanonRegistry(outputDir);
  const before = registry.entries.length;
  registry.entries = registry.entries.filter((e) => e.id !== id);
  if (registry.entries.length < before) {
    saveCanonRegistry(registry, outputDir);
    return true;
  }
  return false;
}

/**
 * Canon ID 생성 (타입 + 이름 기반).
 */
export function generateCanonId(type: string, name: string): string {
  const safeType = type.replace(/[^a-zA-Z0-9]/g, "_");
  const safeName = name.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase();
  return `canon_${safeType}_${safeName}`;
}
