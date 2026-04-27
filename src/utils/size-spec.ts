/**
 * size-spec.ts — asset_size_spec.json 로딩 + 자산 경로 → spec 키 추론
 *
 * 게임 코드가 표시 사이즈를 강제하는 환경에서 자산이 spec 비율을 따르지 않으면
 * stretch/squash 가 발생한다. 이 유틸은 다음을 한 곳에서 처리한다:
 *   1) asset_size_spec.json 안전 로드
 *   2) 자산 파일 경로 패턴 → spec 카테고리·키 자동 추론
 *   3) spec 항목 → DeployTarget 변환 (asset_deploy 자동 채움용)
 *   4) 비율 호환성 검사 (asset_validate 강화용)
 */

import * as fs from "fs";
import * as path from "path";
import type {
  AssetSizeSpecFile,
  NestedSizeSpecs,
  SizeSpec,
} from "../types.js";
import type { DeployFit, DeployTarget } from "./deploy-map.js";

/** asset_size_spec.json 안전 로드. 없거나 깨지면 null. */
export function loadSizeSpecFile(specPath: string): AssetSizeSpecFile | null {
  try {
    const abs = path.resolve(specPath);
    if (!fs.existsSync(abs)) return null;
    const raw = fs.readFileSync(abs, "utf-8");
    const parsed = JSON.parse(raw) as AssetSizeSpecFile;
    if (!parsed?.specs) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * 자산 파일의 registry root 기준 상대경로(POSIX)로부터
 * NestedSizeSpecs 의 카테고리·키를 추론한다.
 *
 * 예시:
 *   "backgrounds/bg_alley.webp"                  → backgrounds.full
 *   "backgrounds/bg_loading.webp"                → backgrounds.full
 *   "backgrounds/bg_main_bg_far.webp"            → backgrounds.parallax_far
 *   "sprites/hero/hero_base.webp"                → characters.base_master
 *   "sprites/hero/hero_idle_f00.webp"            → characters.sprite_frame
 *   "weapons/sword/sword_icon.png"               → ui.icon_md   (게임 무기 아이콘은 보통 ui_icon 매핑)
 *   "ui/icons/icon_inventory.webp"               → ui.icon_md
 *   "ui/buttons/btn_play_md.webp"                → ui.button_md
 *   "ui/popups/popup_panel.webp"                 → ui.popup_panel
 *   "effects/explosion_md.webp"                  → effects.md
 *   "tilesets/forest/tileset.webp"               → tiles.tileset
 *   "marketing/app-icon/app_icon.png"            → marketing.app_icon
 *   "marketing/thumbnail/thumb.webp"             → marketing.thumbnail
 *   "logos/foo_logo_dark.webp"                   → marketing.app_icon
 *   "thumbnails/foo_thumb_*.webp"                → marketing.thumbnail
 *
 * 추론 실패 시 null.
 */
export interface SpecKey {
  category: keyof NestedSizeSpecs;
  key: string;
}

export function inferSpecKeyFromPath(relPathPosix: string): SpecKey | null {
  const p = relPathPosix.replace(/\\/g, "/").toLowerCase();
  const file = p.split("/").pop() ?? "";

  // ─ marketing ─
  if (p.startsWith("marketing/app-icon/") || p.startsWith("logos/")) {
    return { category: "marketing", key: "app_icon" };
  }
  if (p.startsWith("marketing/thumbnail/") || p.startsWith("thumbnails/")) {
    return { category: "marketing", key: "thumbnail" };
  }
  if (p.startsWith("marketing/banner/")) {
    return { category: "marketing", key: "google_play_banner" };
  }
  if (p.startsWith("marketing/screenshots/")) {
    return file.includes("ios")
      ? { category: "marketing", key: "store_screenshot_ios" }
      : { category: "marketing", key: "store_screenshot_android" };
  }
  if (p.startsWith("marketing/social/")) {
    if (file.includes("instagram_story")) return { category: "marketing", key: "instagram_story" };
    if (file.includes("instagram"))       return { category: "marketing", key: "instagram_post" };
    return { category: "marketing", key: "instagram_post" };
  }

  // ─ tilesets ─
  if (p.startsWith("tilesets/")) {
    return { category: "tiles", key: "tileset" };
  }

  // ─ effects ─
  if (p.startsWith("effects/")) {
    if (file.includes("_xl") || file.includes("xlarge")) return { category: "effects", key: "xl" };
    if (file.includes("_lg") || file.includes("_large")) return { category: "effects", key: "lg" };
    if (file.includes("_sm") || file.includes("_small")) return { category: "effects", key: "sm" };
    return { category: "effects", key: "md" };
  }

  // ─ UI ─
  if (p.startsWith("ui/buttons/") || /(^|_)btn(_|\.)/.test(file)) {
    if (file.includes("_lg") || file.includes("_large")) return { category: "ui", key: "button_lg" };
    if (file.includes("_sm") || file.includes("_small")) return { category: "ui", key: "button_sm" };
    return { category: "ui", key: "button_md" };
  }
  if (p.startsWith("ui/popups/") || /popup|panel|dialog|modal/.test(file)) {
    return { category: "ui", key: "popup_panel" };
  }
  if (p.startsWith("ui/icons/") || /(^|_)icon(_|\.)/.test(file)) {
    if (file.includes("_lg") || file.includes("_large")) return { category: "ui", key: "icon_lg" };
    if (file.includes("_sm") || file.includes("_small")) return { category: "ui", key: "icon_sm" };
    return { category: "ui", key: "icon_md" };
  }

  // ─ weapons (게임 무기 아이콘은 보통 인벤토리 슬롯 = ui.icon_md) ─
  if (p.startsWith("weapons/")) {
    return { category: "ui", key: "icon_md" };
  }

  // ─ backgrounds + parallax ─
  if (p.startsWith("backgrounds/")) {
    if (file.includes("_far"))  return { category: "backgrounds", key: "parallax_far" };
    if (file.includes("_mid"))  return { category: "backgrounds", key: "parallax_mid" };
    if (file.includes("_near")) return { category: "backgrounds", key: "parallax_near" };
    return { category: "backgrounds", key: "full" };
  }

  // ─ characters / sprites ─
  if (p.startsWith("sprites/") || p.startsWith("characters/")) {
    if (file.endsWith("_base.png") || file.endsWith("_base.webp") || /_base[^/]*$/.test(file)) {
      return { category: "characters", key: "base_master" };
    }
    if (/portrait_thumb|_thumb/.test(file)) return { category: "characters", key: "portrait_thumb" };
    if (/portrait_bust|_bust/.test(file))   return { category: "characters", key: "portrait_bust" };
    if (/portrait/.test(file))              return { category: "characters", key: "portrait_full" };
    if (/char_card|_card/.test(file))       return { category: "characters", key: "char_card" };
    // 액션 프레임 또는 시트
    return { category: "characters", key: "sprite_frame" };
  }

  return null;
}

/**
 * NestedSizeSpecs 에서 SpecKey 로 SizeSpec 항목을 안전 조회한다.
 * - tiles.tileset / characters.* / ui.* / effects.* / backgrounds.* / marketing.*
 *   는 SizeSpec 객체.
 * - ui.hp_bar_width 같은 number 필드는 무시 (null).
 */
export function lookupSpecEntry(specs: NestedSizeSpecs, k: SpecKey): SizeSpec | null {
  const cat = specs[k.category] as Record<string, unknown> | undefined;
  if (!cat) return null;
  const v = cat[k.key];
  if (!v || typeof v !== "object") return null;
  const s = v as Partial<SizeSpec>;
  if (typeof s.width !== "number" || typeof s.height !== "number") return null;
  return v as SizeSpec;
}

/**
 * SizeSpec → DeployTarget. 기본 deploy 경로는 `public/assets/<category>/<file>`.
 * 호출처가 path 를 명시하면 그것을 우선.
 */
export interface BuildDeployTargetOptions {
  /** 결과 파일 경로 (project_root 기준 상대). 미지정 시 자동 생성. */
  path?: string;
  /** 파일명 fallback (자동 경로 생성용) */
  fileName?: string;
  /** 기본 fit (배경/UI 패널은 'cover', 스프라이트/아이콘은 'contain') */
  fit?: DeployFit;
  /** 출력 포맷 — 기본 'png' */
  format?: "png" | "webp" | "jpeg";
  /** category 추론 결과 — 자동 path 생성에 활용 */
  categoryHint?: string;
}

export function specEntryToDeployTarget(
  spec: SizeSpec,
  opts: BuildDeployTargetOptions = {},
): DeployTarget {
  const fit: DeployFit =
    opts.fit ??
    (opts.categoryHint === "characters" || opts.categoryHint === "ui_icon" ? "contain" : "cover");
  const format =
    opts.format ?? (spec.format === "webp" ? "webp" : spec.format === "jpeg" ? "jpeg" : "png");
  const targetPath =
    opts.path ??
    (opts.fileName
      ? `public/assets/${opts.categoryHint ?? "misc"}/${opts.fileName}`
      : `public/assets/${opts.categoryHint ?? "misc"}/asset.${format}`);
  return {
    path: targetPath,
    width: spec.width,
    height: spec.height,
    fit,
    format,
  };
}

/**
 * 마스터 자산의 실제 (W, H) 와 spec (W, H) 를 비교해 비율 호환성 보고.
 * tolerance 는 비율 차이 비율 (기본 5%).
 *
 * 반환값:
 *   - kind="ok"           — 비율 일치 (또는 spec 미발견)
 *   - kind="ratio_mismatch" — 비율 차이 > tolerance, stretch/squash 위험
 *   - kind="upscale_risk"   — 마스터 두 변 모두 spec 보다 작음 (업스케일 위험)
 *   - kind="exact"          — 정확히 일치
 */
export type RatioCompatReport =
  | { kind: "ok"; reason: "exact" | "within_tolerance"; masterRatio: number; specRatio: number }
  | { kind: "ratio_mismatch"; masterRatio: number; specRatio: number; deltaPct: number }
  | { kind: "upscale_risk"; masterRatio: number; specRatio: number; specPx: { w: number; h: number }; masterPx: { w: number; h: number } };

export function compareRatio(
  masterW: number,
  masterH: number,
  spec: SizeSpec,
  tolerancePct = 5,
): RatioCompatReport {
  if (masterW <= 0 || masterH <= 0) {
    return { kind: "ratio_mismatch", masterRatio: 0, specRatio: spec.width / spec.height, deltaPct: 100 };
  }
  const masterRatio = masterW / masterH;
  const specRatio = spec.width / spec.height;
  if (masterW === spec.width && masterH === spec.height) {
    return { kind: "ok", reason: "exact", masterRatio, specRatio };
  }
  const delta = Math.abs(masterRatio - specRatio) / specRatio;
  const deltaPct = delta * 100;
  if (deltaPct > tolerancePct) {
    return { kind: "ratio_mismatch", masterRatio, specRatio, deltaPct };
  }
  if (masterW < spec.width && masterH < spec.height) {
    return {
      kind: "upscale_risk",
      masterRatio,
      specRatio,
      specPx: { w: spec.width, h: spec.height },
      masterPx: { w: masterW, h: masterH },
    };
  }
  return { kind: "ok", reason: "within_tolerance", masterRatio, specRatio };
}
