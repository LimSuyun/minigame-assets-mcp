/**
 * slug.ts — 자산 파일명용 안전한 슬러그 생성
 *
 * 정책:
 *  - 우선순위 1: CONCEPT 의 `name_slug` (사용자가 명시 지정한 영문 슬러그)
 *  - 우선순위 2: game_name 에서 ASCII 알파넘 + 한글 보존 (옛 동작 호환)
 *
 * 한글이 포함된 게임명은 일부 빌드툴/CDN/asset loader 에서 인코딩 문제를
 * 일으킬 수 있으므로, 사용자가 영문 `name_slug` 를 명시 지정하면 그것을 우선한다.
 */

const SAFE_KOREAN_RE = /[^\w가-힣-]/g;
const SAFE_ASCII_RE = /[^a-z0-9-]/g;

/**
 * CONCEPT.name_slug 를 우선 사용, 없으면 game_name 에서 한글 보존 슬러그 생성.
 *
 * @param input - { name_slug, game_name } 또는 단순 game_name 문자열
 * @returns 파일명 안전 슬러그 (소문자, 공백→underscore)
 */
export function makeAssetSlug(
  input: string | { name_slug?: string; game_name: string },
): string {
  if (typeof input === "string") {
    return slugifyKorean(input);
  }
  if (input.name_slug && input.name_slug.trim()) {
    return slugifyAscii(input.name_slug);
  }
  return slugifyKorean(input.game_name);
}

/** ASCII 전용 — name_slug 처럼 사용자가 의도한 영문 슬러그용 */
export function slugifyAscii(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(SAFE_ASCII_RE, "")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 한글 보존 — 옛 safeName 호환 */
export function slugifyKorean(s: string): string {
  return s
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(SAFE_KOREAN_RE, "");
}
