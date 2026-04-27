import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import type { GeneratedAsset, AssetRegistry } from "../types.js";
import { loadDeployMap, saveDeployMap, upsertEntry } from "./deploy-map.js";
import { resolveRegistryRoot } from "./registry-root.js";

export function ensureDir(dirPath: string): void {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

export function buildAssetPath(
  outputDir: string,
  subDir: string,
  fileName: string
): string {
  const fullDir = path.resolve(outputDir, subDir);
  ensureDir(fullDir);
  return path.join(fullDir, fileName);
}

export function generateFileName(prefix: string, extension: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const random = Math.random().toString(36).slice(2, 6);
  return `${prefix}_${timestamp}_${random}.${extension}`;
}

export function saveBase64File(
  base64Data: string,
  filePath: string
): void {
  const buffer = Buffer.from(base64Data, "base64");
  fs.writeFileSync(filePath, buffer);
}

export async function downloadFile(url: string, filePath: string): Promise<void> {
  const protocol = url.startsWith("https") ? https : http;
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(filePath);
    protocol.get(url, (response) => {
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (err) => {
      fs.unlink(filePath, () => {});
      reject(err);
    });
  });
}

export function getAssetRegistryPath(outputDir: string): string {
  const root = resolveRegistryRoot(outputDir);
  return path.resolve(root, "assets-registry.json");
}

export function loadAssetRegistry(outputDir: string): AssetRegistry {
  const registryPath = getAssetRegistryPath(outputDir);
  if (fs.existsSync(registryPath)) {
    const data = fs.readFileSync(registryPath, "utf-8");
    return JSON.parse(data) as AssetRegistry;
  }
  return { assets: [], last_updated: new Date().toISOString() };
}

/**
 * provider 문자열 정규화.
 * - 단순 vendor 표기(`"openai"`, `"local"`) 인데 metadata.model 이 있으면 `vendor/<model>` 로 보강.
 * - 이미 슬래시가 들어 있으면 그대로 둔다 (`openai/gpt-image-2`).
 * - vendor 가 비표준 표기여도 손대지 않는다.
 */
function normalizeProvider(asset: GeneratedAsset): GeneratedAsset {
  const p = asset.provider;
  if (typeof p !== "string" || p.length === 0) return asset;
  if (p.includes("/")) return asset; // 이미 표준 형식
  const model = (asset.metadata as { model?: unknown } | undefined)?.model;
  if (typeof model !== "string" || model.length === 0) return asset;
  return { ...asset, provider: `${p}/${model}` };
}

/**
 * file_path 가 registry 루트 안에 있을 때 POSIX 상대경로를 계산한다.
 * 루트 밖이거나 계산 실패 시 undefined.
 */
function computeRelativePath(rootAbs: string, filePath: string): string | undefined {
  try {
    const abs = path.isAbsolute(filePath) ? filePath : path.resolve(rootAbs, filePath);
    const inside =
      abs === rootAbs ||
      abs.startsWith(rootAbs + path.sep);
    if (!inside) return undefined;
    return path.relative(rootAbs, abs).split(path.sep).join("/");
  } catch {
    return undefined;
  }
}

export function saveAssetToRegistry(
  asset: GeneratedAsset,
  outputDir: string = DEFAULT_OUTPUT_DIR
): void {
  // 어떤 sub-dir 이 들어와도 registry/deploy-map 은 항상 프로젝트 루트 한 곳으로 통합
  const root = resolveRegistryRoot(outputDir);
  ensureDir(root);

  // provider 정규화 + relative_path 자동 부착 (이미 채워져 있으면 보존)
  const filePath = (asset as { file_path?: string }).file_path;
  const enriched: GeneratedAsset = (() => {
    let acc = normalizeProvider(asset);
    if (!acc.relative_path && typeof filePath === "string" && filePath.length > 0) {
      const rel = computeRelativePath(root, filePath);
      if (rel) acc = { ...acc, relative_path: rel };
    }
    return acc;
  })();

  const registry = loadAssetRegistry(root);
  registry.assets.push(enriched);
  registry.last_updated = new Date().toISOString();
  const registryPath = getAssetRegistryPath(root);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));

  // Deploy 매니페스트에도 자동 upsert (approved=false 로 등록 — 사용자가 asset_approve 로 확정)
  if (typeof filePath === "string" && filePath.length > 0) {
    try {
      const masterAbs = path.isAbsolute(filePath)
        ? filePath
        : path.resolve(root, filePath);
      if (fs.existsSync(masterAbs)) {
        const map = loadDeployMap(root);
        const meta = asset as { width?: number; height?: number };
        upsertEntry(map, root, masterAbs, {
          width: meta.width ?? null,
          height: meta.height ?? null,
        });
        saveDeployMap(root, map);
      }
    } catch {
      // 매니페스트 업데이트 실패가 생성 자체를 막으면 안 됨 — silent
    }
  }
}

export function generateAssetId(): string {
  return `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
