import * as fs from "fs";
import * as path from "path";

// ─── 타입 ─────────────────────────────────────────────────────────────────────

export type GameEngine =
  | "cocos_creator"
  | "unity"
  | "phaser"
  | "godot"
  | "unknown";

export interface EngineSignal {
  signal: string;
  weight: number;
}

export interface EngineDetectionResult {
  engine: GameEngine;
  confidence: number; // 0~100
  signals: string[];
  version?: string;
}

export interface AssetDirectory {
  path: string;
  purpose: "sprites" | "audio" | "video" | "ui" | "general";
  existing_files: number;
}

export interface AssetReference {
  file: string;
  line: number;
  asset_name: string;
  asset_type: "image" | "audio" | "video" | "unknown";
  raw: string;
}

export interface ProjectInfo {
  name: string;
  root_path: string;
  engine: EngineDetectionResult;
  asset_directories: AssetDirectory[];
  recommended_export_format: string[];
  recommended_asset_output_dir: string;
  package_info?: Record<string, unknown>;
}

// ─── 파일 탐색 유틸 ───────────────────────────────────────────────────────────

function walkDir(
  dir: string,
  depth: number,
  maxDepth: number,
  result: string[]
): void {
  if (depth > maxDepth) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // 무거운 디렉토리 스킵
    if (["node_modules", ".git", "dist", "build", "Library", ".DS_Store"].includes(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkDir(full, depth + 1, maxDepth, result);
    } else {
      result.push(full);
    }
  }
}

export function collectFiles(rootPath: string, maxDepth = 6): string[] {
  const files: string[] = [];
  walkDir(rootPath, 0, maxDepth, files);
  return files;
}

function fileExists(p: string): boolean {
  return fs.existsSync(p);
}

function dirExists(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function readJsonSafe(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(fs.readFileSync(p, "utf-8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readFileSafe(p: string): string {
  try {
    return fs.readFileSync(p, "utf-8");
  } catch {
    return "";
  }
}

function countFilesInDir(dir: string): number {
  try {
    return fs.readdirSync(dir).length;
  } catch {
    return 0;
  }
}

// ─── 엔진 감지 ────────────────────────────────────────────────────────────────

export function detectEngine(
  rootPath: string,
  allFiles: string[]
): EngineDetectionResult {
  const scores: Record<GameEngine, number> = {
    cocos_creator: 0,
    unity: 0,
    phaser: 0,
    godot: 0,
    unknown: 0,
  };
  const signals: Record<GameEngine, string[]> = {
    cocos_creator: [],
    unity: [],
    phaser: [],
    godot: [],
    unknown: [],
  };

  const rel = (p: string) => path.relative(rootPath, p);

  // ── Cocos Creator 감지 ───────────────────────────────────────
  const cocosProjectJson = path.join(rootPath, "project.json");
  if (fileExists(cocosProjectJson)) {
    const pj = readJsonSafe(cocosProjectJson);
    if (pj && String(pj["engine"] || "").includes("cocos")) {
      scores.cocos_creator += 50;
      signals.cocos_creator.push("project.json with engine=cocos-creator");
    }
  }
  if (fileExists(path.join(rootPath, ".cocoscreator"))) {
    scores.cocos_creator += 40;
    signals.cocos_creator.push(".cocoscreator file");
  }
  // package.json cocos 의존성
  const pkgJson = readJsonSafe(path.join(rootPath, "package.json"));
  if (pkgJson) {
    const allDeps = {
      ...((pkgJson["dependencies"] as Record<string, string>) || {}),
      ...((pkgJson["devDependencies"] as Record<string, string>) || {}),
    };
    if (Object.keys(allDeps).some((k) => k.includes("cocos") || k.includes("creator"))) {
      scores.cocos_creator += 30;
      signals.cocos_creator.push("package.json cocos dependency");
    }
  }
  const fireFiles = allFiles.filter((f) => f.endsWith(".fire") || f.endsWith(".prefab")).slice(0, 3);
  if (fireFiles.length > 0) {
    scores.cocos_creator += 25;
    signals.cocos_creator.push(`.fire/.prefab scene files (${fireFiles.map(rel).join(", ")})`);
  }
  const cocosMetaFiles = allFiles.filter((f) => f.endsWith(".meta")).slice(0, 3);
  if (cocosMetaFiles.length > 0 && dirExists(path.join(rootPath, "assets"))) {
    scores.cocos_creator += 15;
    signals.cocos_creator.push("assets/ directory with .meta files");
  }
  // TypeScript/JS에서 cc. 또는 cocos 참조
  const tsJsFiles = allFiles.filter((f) => /\.(ts|js)$/.test(f)).slice(0, 20);
  for (const f of tsJsFiles) {
    const content = readFileSafe(f);
    if (/\bcc\.\w+|import.*from.*['"]cc['"]|cocos\./.test(content)) {
      scores.cocos_creator += 20;
      signals.cocos_creator.push(`cc namespace in ${rel(f)}`);
      break;
    }
  }

  // ── Unity 감지 ────────────────────────────────────────────────
  if (dirExists(path.join(rootPath, "Assets")) && dirExists(path.join(rootPath, "ProjectSettings"))) {
    scores.unity += 60;
    signals.unity.push("Assets/ + ProjectSettings/ directories");
  }
  if (fileExists(path.join(rootPath, "Packages", "manifest.json"))) {
    scores.unity += 30;
    signals.unity.push("Packages/manifest.json");
  }
  const unityFiles = allFiles.filter((f) => f.endsWith(".unity")).slice(0, 3);
  if (unityFiles.length > 0) {
    scores.unity += 25;
    signals.unity.push(`.unity scene files (${unityFiles.map(rel).join(", ")})`);
  }
  const csFiles = allFiles.filter((f) => f.endsWith(".cs")).slice(0, 5);
  for (const f of csFiles) {
    const content = readFileSafe(f);
    if (/using UnityEngine|MonoBehaviour|UnityEditor/.test(content)) {
      scores.unity += 20;
      signals.unity.push(`UnityEngine namespace in ${rel(f)}`);
      break;
    }
  }

  // ── Phaser 감지 ───────────────────────────────────────────────
  if (pkgJson) {
    const allDeps = {
      ...((pkgJson["dependencies"] as Record<string, string>) || {}),
      ...((pkgJson["devDependencies"] as Record<string, string>) || {}),
    };
    if (allDeps["phaser"] || allDeps["phaser3"]) {
      scores.phaser += 60;
      signals.phaser.push(`phaser in package.json (${allDeps["phaser"] || allDeps["phaser3"]})`);
    }
  }
  const webFiles = allFiles.filter((f) => /\.(ts|js|mjs)$/.test(f)).slice(0, 30);
  for (const f of webFiles) {
    const content = readFileSafe(f);
    if (/import Phaser|require.*['"]phaser['"]|new Phaser\.Game/.test(content)) {
      scores.phaser += 30;
      signals.phaser.push(`Phaser import in ${rel(f)}`);
      break;
    }
    if (/this\.load\.image|this\.load\.atlas|this\.add\.sprite/.test(content)) {
      scores.phaser += 10;
      signals.phaser.push(`Phaser loader API in ${rel(f)}`);
    }
  }

  // ── Godot 감지 ────────────────────────────────────────────────
  if (fileExists(path.join(rootPath, "project.godot"))) {
    scores.godot += 70;
    signals.godot.push("project.godot file");
  }
  const gdFiles = allFiles.filter((f) => f.endsWith(".gd")).slice(0, 3);
  if (gdFiles.length > 0) {
    scores.godot += 30;
    signals.godot.push(`.gd GDScript files (${gdFiles.map(rel).join(", ")})`);
  }
  const tscnFiles = allFiles.filter((f) => f.endsWith(".tscn")).slice(0, 3);
  if (tscnFiles.length > 0) {
    scores.godot += 20;
    signals.godot.push(`.tscn scene files`);
  }

  // ── 최종 판정 ─────────────────────────────────────────────────
  const best = (Object.entries(scores) as [GameEngine, number][])
    .filter(([k]) => k !== "unknown")
    .sort((a, b) => b[1] - a[1])[0];

  if (!best || best[1] === 0) {
    return { engine: "unknown", confidence: 0, signals: [] };
  }

  const total = Object.values(scores).reduce((a, b) => a + b, 0) || 1;
  const confidence = Math.min(100, Math.round((best[1] / total) * 200));

  // Godot 버전 감지
  let version: string | undefined;
  if (best[0] === "godot") {
    const godotCfg = readFileSafe(path.join(rootPath, "project.godot"));
    const m = godotCfg.match(/config_version=(\d+)/);
    if (m) version = `Godot config v${m[1]}`;
  }
  if (best[0] === "unity") {
    const unityVer = readFileSafe(path.join(rootPath, "ProjectSettings", "ProjectVersion.txt"));
    const m = unityVer.match(/m_EditorVersion:\s*(.+)/);
    if (m) version = m[1].trim();
  }

  return {
    engine: best[0],
    confidence,
    signals: signals[best[0]],
    version,
  };
}

// ─── 에셋 디렉토리 감지 ──────────────────────────────────────────────────────

export function detectAssetDirectories(
  rootPath: string,
  engine: GameEngine
): AssetDirectory[] {
  const dirs: AssetDirectory[] = [];

  const candidates: Array<{ rel: string; purpose: AssetDirectory["purpose"] }> = [];

  if (engine === "cocos_creator") {
    candidates.push(
      { rel: "assets/resources", purpose: "general" },
      { rel: "assets/images", purpose: "sprites" },
      { rel: "assets/textures", purpose: "sprites" },
      { rel: "assets/sprites", purpose: "sprites" },
      { rel: "assets/audio", purpose: "audio" },
      { rel: "assets/sounds", purpose: "audio" },
      { rel: "assets/ui", purpose: "ui" },
    );
  } else if (engine === "unity") {
    candidates.push(
      { rel: "Assets/Resources", purpose: "general" },
      { rel: "Assets/Sprites", purpose: "sprites" },
      { rel: "Assets/Textures", purpose: "sprites" },
      { rel: "Assets/Art", purpose: "sprites" },
      { rel: "Assets/Audio", purpose: "audio" },
      { rel: "Assets/Sounds", purpose: "audio" },
      { rel: "Assets/UI", purpose: "ui" },
    );
  } else if (engine === "phaser") {
    candidates.push(
      { rel: "public/assets", purpose: "general" },
      { rel: "src/assets", purpose: "general" },
      { rel: "assets/images", purpose: "sprites" },
      { rel: "assets/sprites", purpose: "sprites" },
      { rel: "assets/audio", purpose: "audio" },
      { rel: "public/images", purpose: "sprites" },
    );
  } else if (engine === "godot") {
    candidates.push(
      { rel: "assets", purpose: "general" },
      { rel: "assets/sprites", purpose: "sprites" },
      { rel: "assets/textures", purpose: "sprites" },
      { rel: "assets/audio", purpose: "audio" },
      { rel: "assets/ui", purpose: "ui" },
    );
  } else {
    // unknown — 일반적인 디렉토리 탐색
    candidates.push(
      { rel: "assets", purpose: "general" },
      { rel: "public/assets", purpose: "general" },
      { rel: "src/assets", purpose: "general" },
      { rel: "resources", purpose: "general" },
    );
  }

  for (const c of candidates) {
    const full = path.join(rootPath, c.rel);
    if (dirExists(full)) {
      dirs.push({
        path: full,
        purpose: c.purpose,
        existing_files: countFilesInDir(full),
      });
    }
  }

  return dirs;
}

// ─── 에셋 참조 스캔 ───────────────────────────────────────────────────────────

const ASSET_PATTERNS: Array<{
  regex: RegExp;
  type: AssetReference["asset_type"];
  nameGroup: number;
}> = [
  // Phaser: this.load.image('key', 'path'), this.load.atlas('key', ...)
  { regex: /this\.load\.(image|atlas|spritesheet)\(\s*['"]([^'"]+)['"]/g, type: "image", nameGroup: 2 },
  // Phaser: this.add.sprite(..., 'key')
  { regex: /this\.add\.sprite\([^,]+,[^,]+,\s*['"]([^'"]+)['"]/g, type: "image", nameGroup: 1 },
  // Cocos: cc.loader.loadRes / resources.load
  { regex: /(?:resources|cc\.loader)\.load(?:Res)?\(\s*['"]([^'"]+)['"]/g, type: "image", nameGroup: 1 },
  // Cocos: spriteFrame, SpriteAtlas
  { regex: /['"]([^'"]+\.(?:png|jpg|jpeg|webp|plist))['"]/g, type: "image", nameGroup: 1 },
  // Unity C#: Resources.Load<Sprite>("...")
  { regex: /Resources\.Load[^(]*\(\s*["']([^"']+)["']/g, type: "image", nameGroup: 1 },
  // Unity: [SerializeField] Sprite / AudioClip
  { regex: /\[SerializeField\].*(?:Sprite|AudioClip|Texture2D)\s+\w+/g, type: "image", nameGroup: 0 },
  // Audio: load.audio / AudioClip
  { regex: /this\.load\.audio\(\s*['"]([^'"]+)['"]/g, type: "audio", nameGroup: 1 },
  { regex: /AudioSource\.PlayClipAtPoint|GetComponent<AudioSource>/g, type: "audio", nameGroup: 0 },
  // Godot: load("res://...")
  { regex: /load\(\s*["']res:\/\/([^"']+)["']\)/g, type: "image", nameGroup: 1 },
  // preload
  { regex: /preload\(\s*["']res:\/\/([^"']+)["']\)/g, type: "image", nameGroup: 1 },
];

export function scanAssetReferences(
  rootPath: string,
  engine: GameEngine,
  allFiles: string[]
): AssetReference[] {
  const extensions: Record<GameEngine, string[]> = {
    cocos_creator: [".ts", ".js"],
    unity: [".cs"],
    phaser: [".ts", ".js", ".mjs"],
    godot: [".gd", ".cs"],
    unknown: [".ts", ".js", ".cs", ".gd"],
  };

  const targetExts = extensions[engine];
  const sourceFiles = allFiles.filter((f) => targetExts.some((ext) => f.endsWith(ext)));

  const refs: AssetReference[] = [];
  const seen = new Set<string>();

  for (const filePath of sourceFiles.slice(0, 50)) {
    const content = readFileSafe(filePath);
    if (!content) continue;
    const lines = content.split("\n");

    for (const pattern of ASSET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = pattern.regex.exec(content)) !== null) {
        const rawMatch = match[0];
        const assetName =
          pattern.nameGroup > 0 ? (match[pattern.nameGroup] || rawMatch) : rawMatch;

        // 너무 짧거나 중복 건너뜀
        if (assetName.length < 2 || seen.has(assetName)) continue;
        seen.add(assetName);

        // 라인 번호 계산
        const before = content.slice(0, match.index);
        const lineNum = before.split("\n").length;
        const lineText = lines[lineNum - 1]?.trim() || rawMatch;

        refs.push({
          file: path.relative(rootPath, filePath),
          line: lineNum,
          asset_name: assetName,
          asset_type: pattern.type,
          raw: lineText.slice(0, 120),
        });
      }
    }
  }

  return refs;
}

// ─── 엔진별 권장 설정 ─────────────────────────────────────────────────────────

export function getEngineRecommendations(
  engine: GameEngine,
  assetDirs: AssetDirectory[]
): {
  export_formats: string[];
  output_dir: string;
  image_provider: string;
  notes: string[];
} {
  const spriteDir = assetDirs.find((d) => d.purpose === "sprites");
  const generalDir = assetDirs.find((d) => d.purpose === "general");
  const baseOutputDir = spriteDir?.path || generalDir?.path || "./generated-assets";

  switch (engine) {
    case "cocos_creator":
      return {
        export_formats: ["cocos"],
        output_dir: baseOutputDir,
        image_provider: "openai",
        notes: [
          ".plist + spritesheet.png 포맷으로 생성됩니다",
          "생성 후 Cocos Creator Assets 패널에 드래그 앤 드롭하세요",
          "SpriteAtlas 컴포넌트로 .plist 파일을 로드하세요",
        ],
      };
    case "unity":
      return {
        export_formats: ["unity"],
        output_dir: baseOutputDir,
        image_provider: "openai",
        notes: [
          "spritesheet.png + unity.json 포맷으로 생성됩니다",
          "PNG 임포트 후 Sprite Mode → Multiple로 설정하세요",
          "Sprite Editor에서 Grid by Cell Size로 슬라이싱하세요",
        ],
      };
    case "phaser":
      return {
        export_formats: ["phaser"],
        output_dir: baseOutputDir,
        image_provider: "openai",
        notes: [
          "spritesheet.png + phaser atlas JSON 포맷으로 생성됩니다",
          "this.load.atlas('key', 'sheet.png', 'atlas.json') 으로 로드하세요",
          "Phaser 3.x 텍스처 아틀라스 포맷과 호환됩니다",
        ],
      };
    case "godot":
      return {
        export_formats: ["individual"],
        output_dir: baseOutputDir,
        image_provider: "openai",
        notes: [
          "개별 PNG 파일로 생성됩니다",
          "AnimatedSprite2D 노드에 각 프레임을 추가하세요",
          "또는 SpriteFrames 리소스를 생성하여 애니메이션을 구성하세요",
        ],
      };
    default:
      return {
        export_formats: ["individual"],
        output_dir: "./generated-assets",
        image_provider: "openai",
        notes: ["엔진을 감지할 수 없어 개별 PNG로 생성합니다"],
      };
  }
}
