/**
 * consolidate.ts — 분산된 sub-registry / sub-deploy-map 통합 마이그레이션
 *
 * v3.0.x 이전 버전으로 만든 프로젝트는 마케팅·로고 등의 도구가 자기 sub-dir
 * (`marketing/app-icon/`, `marketing/thumbnail/` 등)에 별도 `assets-registry.json`
 * / `deploy-map.json` 을 만들었다. 새 버전은 항상 프로젝트 루트(`.minigame-assets/`)
 * 한 곳으로 통합하지만, 기존 산출물은 그대로 흩어져 있어 `asset_list_assets` 등
 * 통합 추적 도구가 일부 자산을 못 본다.
 *
 * 본 도구는 한 번 호출로:
 *  1. project_root 아래의 모든 sub `assets-registry.json` 을 메인으로 흡수
 *  2. 모든 sub `deploy-map.json` 의 entries 를 메인으로 흡수 (key 충돌 시 메인 우선)
 *  3. 메인 자산 중 `relative_path` 가 비어 있으면 자동 부착
 *  4. 흡수가 끝난 sub 파일들은 삭제 (dry_run 시 미리보기만)
 *
 * 멱등 — 두 번 호출해도 동일 상태로 수렴. id 충돌 시 메인 보존, sub 자산은 스킵.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import type { GeneratedAsset, AssetRegistry } from "../types.js";
import { resolveRegistryRoot } from "../utils/registry-root.js";
import { handleApiError } from "../utils/errors.js";
import type { DeployMap, DeployEntry } from "../utils/deploy-map.js";

const REGISTRY_FILE = "assets-registry.json";
const DEPLOY_FILE = "deploy-map.json";

interface SubFile {
  path: string;
  kind: "registry" | "deploy";
}

function findSubFiles(rootAbs: string): SubFile[] {
  const out: SubFile[] = [];
  if (!fs.existsSync(rootAbs)) return out;

  const stack: string[] = [rootAbs];
  while (stack.length) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        // node_modules / 숨김 폴더는 skip (단 root 자체는 통과)
        if (e.name === "node_modules") continue;
        if (e.name.startsWith(".") && full !== rootAbs) continue;
        stack.push(full);
      } else if (e.isFile() && (e.name === REGISTRY_FILE || e.name === DEPLOY_FILE)) {
        // 메인 파일 자체는 제외
        if (path.dirname(full) === rootAbs) continue;
        out.push({
          path: full,
          kind: e.name === REGISTRY_FILE ? "registry" : "deploy",
        });
      }
    }
  }
  return out;
}

function readJsonSafe<T>(p: string): T | null {
  try {
    const raw = fs.readFileSync(p, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function computeRelativePath(rootAbs: string, filePath: string): string | undefined {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(rootAbs, filePath);
    if (abs !== rootAbs && !abs.startsWith(rootAbs + path.sep)) return undefined;
    return path.relative(rootAbs, abs).split(path.sep).join("/");
  } catch {
    return undefined;
  }
}

export function registerConsolidateTools(server: McpServer): void {
  server.registerTool(
    "asset_consolidate_registry",
    {
      title: "Consolidate scattered registries / deploy-maps",
      description: `프로젝트 루트(\`.minigame-assets/\`) 아래 흩어진 \`assets-registry.json\` / \`deploy-map.json\` 을 메인 한 곳으로 통합합니다.

**언제 사용**:
- v3.0.x 이전 도구로 만든 프로젝트에서 \`marketing/app-icon/\`, \`marketing/thumbnail/\` 등에 별도 registry 가 흩어져 있을 때
- \`asset_list_assets\`/\`asset_list_missing\`/\`minigame-assets-status\` 가 일부 자산을 못 보는 증상

**동작 (멱등)**:
1. project_root 하위 모든 sub-registry/sub-deploy-map 탐색 (메인 제외)
2. sub 자산을 메인으로 병합 — id 충돌 시 메인 우선, sub는 스킵
3. deploy-map 의 entries 흡수 — key 충돌 시 메인 우선
4. 메인 자산 중 \`relative_path\` 가 없으면 자동 부착 (POSIX, root 기준)
5. 통합 후 sub 파일 삭제 (dry_run=true 면 미리보기만)

Args:
  - project_root: 프로젝트 루트 디렉터리. 기본 \`./.minigame-assets/\`. 어떤 sub-dir 을 줘도 도구가 \`.minigame-assets/\` 를 자동 resolve.
  - dry_run: true 면 변경 미리보기만 (파일 수정 없음). 기본 false.

Returns:
  통합 요약 — 흡수된 자산 수, 삭제된 sub 파일 목록, 충돌 사례.`,
      inputSchema: z.object({
        project_root: z.string().optional().describe("프로젝트 루트. 기본 .minigame-assets/"),
        dry_run: z.boolean().default(false).describe("true면 미리보기만, 파일 변경 없음"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (params) => {
      try {
        const rootAbs = resolveRegistryRoot(params.project_root || DEFAULT_OUTPUT_DIR);

        if (!fs.existsSync(rootAbs)) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                success: false,
                reason: "project_root가 존재하지 않습니다",
                project_root: rootAbs,
              }, null, 2),
            }],
          };
        }

        // 1. 메인 registry / deploy-map 로드
        const mainRegistryPath = path.join(rootAbs, REGISTRY_FILE);
        const mainDeployPath = path.join(rootAbs, DEPLOY_FILE);
        const mainRegistry: AssetRegistry =
          readJsonSafe<AssetRegistry>(mainRegistryPath) ?? {
            assets: [],
            last_updated: new Date().toISOString(),
          };
        const mainDeploy: DeployMap =
          readJsonSafe<DeployMap>(mainDeployPath) ?? {
            version: 1,
            generated_at: new Date().toISOString(),
            entries: {},
          };

        // 2. sub 파일 수집
        const subs = findSubFiles(rootAbs);

        // 3. 흡수 처리
        const existingIds = new Set(mainRegistry.assets.map((a) => a.id));
        const existingKeys = new Set(Object.keys(mainDeploy.entries));
        const absorbedAssets: GeneratedAsset[] = [];
        const skippedIds: string[] = [];
        const absorbedDeployKeys: string[] = [];
        const skippedKeys: string[] = [];
        const subRegistryFiles: string[] = [];
        const subDeployFiles: string[] = [];

        for (const s of subs) {
          if (s.kind === "registry") {
            subRegistryFiles.push(s.path);
            const r = readJsonSafe<AssetRegistry>(s.path);
            if (!r || !Array.isArray(r.assets)) continue;
            for (const a of r.assets) {
              if (!a || typeof a.id !== "string") continue;
              if (existingIds.has(a.id)) {
                skippedIds.push(a.id);
                continue;
              }
              existingIds.add(a.id);
              absorbedAssets.push(a);
            }
          } else {
            subDeployFiles.push(s.path);
            const d = readJsonSafe<DeployMap>(s.path);
            if (!d || !d.entries) continue;
            for (const [k, v] of Object.entries(d.entries)) {
              if (existingKeys.has(k)) {
                skippedKeys.push(k);
                continue;
              }
              existingKeys.add(k);
              mainDeploy.entries[k] = v as DeployEntry;
              absorbedDeployKeys.push(k);
            }
          }
        }

        // 4. relative_path 자동 부착 (메인 + 새로 흡수된 자산 모두)
        const allAssets = [...mainRegistry.assets, ...absorbedAssets];
        let relativePathFilled = 0;
        for (const a of allAssets) {
          if (a.relative_path) continue;
          const fp = (a as { file_path?: string }).file_path;
          if (typeof fp !== "string" || fp.length === 0) continue;
          const rel = computeRelativePath(rootAbs, fp);
          if (rel) {
            a.relative_path = rel;
            relativePathFilled += 1;
          }
        }

        const summary = {
          project_root: rootAbs,
          dry_run: params.dry_run,
          before: {
            main_assets: mainRegistry.assets.length,
            main_deploy_entries: Object.keys(mainDeploy.entries).length - absorbedDeployKeys.length,
            sub_registry_files: subRegistryFiles.length,
            sub_deploy_files: subDeployFiles.length,
          },
          absorbed: {
            assets: absorbedAssets.length,
            deploy_entries: absorbedDeployKeys.length,
            relative_path_filled: relativePathFilled,
          },
          skipped: {
            asset_ids_existing: skippedIds.length,
            deploy_keys_existing: skippedKeys.length,
          },
          sub_files: {
            registries: subRegistryFiles.map((p) => path.relative(rootAbs, p)),
            deploy_maps: subDeployFiles.map((p) => path.relative(rootAbs, p)),
          },
        };

        if (params.dry_run) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ ...summary, action: "preview" }, null, 2),
            }],
          };
        }

        // 5. 실제 적용 — 메인 파일 업데이트 + sub 파일 삭제
        mainRegistry.assets = allAssets;
        mainRegistry.last_updated = new Date().toISOString();
        mainDeploy.generated_at = new Date().toISOString();

        fs.writeFileSync(mainRegistryPath, JSON.stringify(mainRegistry, null, 2), "utf-8");
        fs.writeFileSync(mainDeployPath, JSON.stringify(mainDeploy, null, 2), "utf-8");

        const deletedFiles: string[] = [];
        const deleteErrors: Array<{ file: string; reason: string }> = [];
        for (const s of [...subRegistryFiles, ...subDeployFiles]) {
          try {
            fs.unlinkSync(s);
            deletedFiles.push(path.relative(rootAbs, s));
          } catch (err) {
            deleteErrors.push({
              file: path.relative(rootAbs, s),
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              ...summary,
              after: {
                main_assets: mainRegistry.assets.length,
                main_deploy_entries: Object.keys(mainDeploy.entries).length,
                deleted_sub_files: deletedFiles.length,
              },
              deleted_files: deletedFiles,
              ...(deleteErrors.length > 0 ? { delete_errors: deleteErrors } : {}),
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: handleApiError(err, "consolidate registry"),
          }],
        };
      }
    },
  );
}
