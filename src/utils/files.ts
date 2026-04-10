import * as fs from "fs";
import * as path from "path";
import * as https from "https";
import * as http from "http";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import type { GeneratedAsset, AssetRegistry } from "../types.js";

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
  return path.resolve(outputDir, "assets-registry.json");
}

export function loadAssetRegistry(outputDir: string): AssetRegistry {
  const registryPath = getAssetRegistryPath(outputDir);
  if (fs.existsSync(registryPath)) {
    const data = fs.readFileSync(registryPath, "utf-8");
    return JSON.parse(data) as AssetRegistry;
  }
  return { assets: [], last_updated: new Date().toISOString() };
}

export function saveAssetToRegistry(
  asset: GeneratedAsset,
  outputDir: string = DEFAULT_OUTPUT_DIR
): void {
  ensureDir(outputDir);
  const registry = loadAssetRegistry(outputDir);
  registry.assets.push(asset);
  registry.last_updated = new Date().toISOString();
  const registryPath = getAssetRegistryPath(outputDir);
  fs.writeFileSync(registryPath, JSON.stringify(registry, null, 2));
}

export function generateAssetId(): string {
  return `asset_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}
