import sharp from "sharp";
import * as fs from "fs";
import * as path from "path";
import {
  collectFiles,
  detectEngine,
  type GameEngine,
} from "./project-scanner.js";

// ─── Engine-format compatibility ──────────────────────────────────────────────
//
// WebP is about 30–60% smaller than PNG at visually identical quality (alpha
// supported). Engines that can load WebP natively at runtime get it by default;
// engines without native WebP loaders fall back to PNG.
//
// Support matrix (runtime texture loading, not editor import):
//   - Phaser 3         ✓  browser-native decoder
//   - Cocos Creator 3  ✓  built-in decoder (web + native builds since 3.x)
//   - Godot 3+         ✓  first-class .webp texture format
//   - Unity            ✗  no native runtime WebP; requires Unity.WebP plugin
//   - unknown          ✗  safe default — don't assume
const ENGINE_WEBP_SUPPORT: Record<GameEngine, boolean> = {
  phaser: true,
  cocos_creator: true,
  godot: true,
  unity: false,
  unknown: false,
};

export type ImageFormat = "png" | "webp";

// ─── Engine detection (cached per cwd) ────────────────────────────────────────

const engineCache = new Map<string, GameEngine>();

export function getCachedEngine(cwd: string): GameEngine {
  const cached = engineCache.get(cwd);
  if (cached !== undefined) return cached;
  let engine: GameEngine = "unknown";
  try {
    const files = collectFiles(cwd, 4);
    engine = detectEngine(cwd, files).engine;
  } catch {
    engine = "unknown";
  }
  engineCache.set(cwd, engine);
  return engine;
}

/** Invalidate the cached engine for a cwd — useful in tests or after a project moves. */
export function clearEngineCache(cwd?: string): void {
  if (cwd) engineCache.delete(cwd);
  else engineCache.clear();
}

// ─── Format resolution ────────────────────────────────────────────────────────

/**
 * Decide which output format to use. Precedence:
 *   1. Explicit `format` argument (per-call user override)
 *   2. `ASSET_OUTPUT_FORMAT` env var (global override: "png" | "webp")
 *   3. Engine auto-detect from cwd → WebP if engine supports it
 *   4. Fallback: "png"
 */
export function resolveOutputFormat(
  explicit?: ImageFormat,
  cwd: string = process.cwd()
): ImageFormat {
  if (explicit === "png" || explicit === "webp") return explicit;

  const envFormat = (process.env.ASSET_OUTPUT_FORMAT || "").toLowerCase();
  if (envFormat === "png" || envFormat === "webp") return envFormat;

  const engine = getCachedEngine(cwd);
  if (ENGINE_WEBP_SUPPORT[engine]) return "webp";

  return "png";
}

// ─── Writer ───────────────────────────────────────────────────────────────────

export interface WriteOptimizedOptions {
  /** Explicit format override. If omitted, resolved via engine/env/default. */
  format?: ImageFormat;
  /** Working directory to use for engine auto-detect. Defaults to process.cwd(). */
  cwd?: string;
  /** WebP quality 1–100 (default 90). Lower = smaller + more artifacts. */
  webpQuality?: number;
  /** PNG zlib compressionLevel 0–9 (default 9 = smallest, slightly slower). */
  pngCompressionLevel?: number;
  /** Optional longest-side cap. Images exceeding this are downscaled with Lanczos. */
  maxDim?: number;
}

export interface WriteOptimizedResult {
  path: string;
  format: ImageFormat;
  sizeBytes: number;
  /** Dimensions actually written (post-resize if any). */
  width: number;
  height: number;
}

function swapExtension(filePath: string, format: ImageFormat): string {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.${format}`);
}

/** PNG magic: \x89 P N G \r \n \x1a \n */
function isPngBuffer(buf: Buffer): boolean {
  return (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  );
}

/**
 * Encode a buffer with engine-aware format + optional resize, write to disk,
 * and return the final path (extension may differ from `targetPath`).
 *
 * The function is a drop-in replacement for `fs.writeFileSync(path, pngBuffer)`:
 *
 *     const { path: out } = await writeOptimized(buf, "/foo/hero_base.png");
 *     // `out` ends in .webp on Phaser/Cocos/Godot projects, .png elsewhere.
 */
export async function writeOptimized(
  buffer: Buffer,
  targetPath: string,
  options: WriteOptimizedOptions = {}
): Promise<WriteOptimizedResult> {
  const format = resolveOutputFormat(options.format, options.cwd);
  const finalPath = swapExtension(targetPath, format);

  // Ensure target dir exists
  fs.mkdirSync(path.dirname(finalPath), { recursive: true });

  // Fast path: target is PNG, input is already PNG, no resize requested.
  // Re-encoding through sharp can actually INCREASE size (~15%) because the
  // upstream encoder may use adaptive filtering / palette mode that sharp's
  // defaults don't match. Preserve the original bytes instead.
  const shouldPassThrough =
    format === "png" && !options.maxDim && isPngBuffer(buffer);

  if (shouldPassThrough) {
    fs.writeFileSync(finalPath, buffer);
    const stats = fs.statSync(finalPath);
    const meta = await sharp(finalPath).metadata();
    return {
      path: finalPath,
      format,
      sizeBytes: stats.size,
      width: meta.width ?? 0,
      height: meta.height ?? 0,
    };
  }

  let pipeline = sharp(buffer);

  if (options.maxDim && options.maxDim > 0) {
    pipeline = pipeline.resize({
      width: options.maxDim,
      height: options.maxDim,
      fit: "inside",
      withoutEnlargement: true,
    });
  }

  if (format === "webp") {
    pipeline = pipeline.webp({
      quality: options.webpQuality ?? 90,
      alphaQuality: 100,
      effort: 4,
      smartSubsample: true,
    });
  } else {
    pipeline = pipeline.png({
      compressionLevel: options.pngCompressionLevel ?? 9,
      adaptiveFiltering: true,
    });
  }

  await pipeline.toFile(finalPath);
  const stats = fs.statSync(finalPath);
  const meta = await sharp(finalPath).metadata();

  return {
    path: finalPath,
    format,
    sizeBytes: stats.size,
    width: meta.width ?? 0,
    height: meta.height ?? 0,
  };
}

/**
 * Synchronous-looking replacement for `fs.writeFileSync(path, pngBuffer)`
 * when the caller only needs the final path. Internally still async.
 */
export async function writeOptimizedToPath(
  buffer: Buffer,
  targetPath: string,
  options: WriteOptimizedOptions = {}
): Promise<string> {
  const result = await writeOptimized(buffer, targetPath, options);
  return result.path;
}
