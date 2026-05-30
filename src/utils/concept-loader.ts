import * as fs from "fs";
import * as path from "path";
import { DEFAULT_CONCEPT_FILE } from "../constants.js";
import type { GameConcept, GameDesign } from "../types.js";

/**
 * game-concept.json에서 이미지 프롬프트용 스타일 힌트 문자열을 읽어 반환.
 * 반환 형식: "Game: X. Style: Y. Theme: Z. Colors: A, B, C."
 */
export function loadConceptHint(conceptFile: string): string {
  const resolved = path.resolve(conceptFile);
  if (!fs.existsSync(resolved)) return "";
  const concept = JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameConcept;
  return (
    `Game: ${concept.game_name}. Style: ${concept.art_style}. ` +
    `Theme: ${concept.theme}. Colors: ${concept.color_palette.join(", ")}.`
  );
}

/**
 * CONCEPT.md의 "BASE STYLE PROMPT" 섹션 내 첫 번째 코드블록(``` ```) 내용을 추출.
 * generate_assets.py의 BASE_STYLE / WEAPON_STYLE 방식과 동일하게 프롬프트 앞에 주입됩니다.
 */
export function loadBaseStyleFromConceptMd(conceptMdPath: string): string {
  const resolved = path.resolve(conceptMdPath);
  if (!fs.existsSync(resolved)) return "";
  const content = fs.readFileSync(resolved, "utf-8");
  const sectionMatch = content.match(/##\s+BASE STYLE PROMPT[^\n]*\n[\s\S]*?```([^`]*)```/);
  if (!sectionMatch) return "";
  return sectionMatch[1].trim().replace(/\n/g, " ");
}

// 모듈 레벨 상수 — hasSoftStyle 호출마다 배열이 재생성되지 않도록
const SOFT_STYLE_KEYWORDS = [
  "soft", "smooth", "watercolor", "painterly", "pastel", "dreamy",
  "hazy", "blur", "gentle", "fuzzy", "misty", "diffuse", "wash",
  "impressionist", "loose", "sketchy", "hand-painted", "hand painted",
] as const;

/**
 * 컨셉 힌트 문자열에 부드러운(soft/watercolor/painterly) 스타일 키워드가 포함됐는지 확인.
 * true면 CLEAN_LINE_STYLE_DEFAULT 주입을 건너뛰어 컨셉 스타일을 존중한다.
 *
 * "Game: Soft Farm. Style: pixel art. Colors: soft pink" 처럼 게임 이름·색상 이름에
 * "soft"가 포함돼도 false positive가 발생하지 않도록 "Style:" 섹션만 우선 검사한다.
 * Style: 섹션이 없으면 전체 텍스트를 fallback으로 검사한다.
 */
export function hasSoftStyle(conceptHint: string): boolean {
  if (!conceptHint) return false;
  const styleMatch = conceptHint.match(/\bStyle:\s*([^.]+)/i);
  const textToCheck = styleMatch ? styleMatch[1] : conceptHint;
  const lower = textToCheck.toLowerCase();
  return SOFT_STYLE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * GameDesign → GameConcept 우선순위로 AI 프롬프트용 스타일 힌트를 생성.
 * designFile이 있으면 GAME_DESIGN.json에서, 없으면 game-concept.json에서 읽음.
 * 반환 형식: "art_style, color palette: A, B, theme: Z" (쉼표 구분, Game: 접두사 없음)
 */
export function loadStyleHint(conceptFile?: string, designFile?: string): string {
  if (designFile) {
    const resolved = path.resolve(designFile);
    if (fs.existsSync(resolved)) {
      try {
        const design = JSON.parse(fs.readFileSync(resolved, "utf-8")) as GameDesign;
        const parts: string[] = [];
        if (design.art_style) parts.push(design.art_style);
        if (design.color_palette?.length) parts.push(`color palette: ${design.color_palette.slice(0, 4).join(", ")}`);
        if (design.theme) parts.push(`theme: ${design.theme}`);
        if (parts.length) return parts.join(", ");
      } catch { /* ignore — fall through to concept */ }
    }
  }
  const conceptPath = path.resolve(conceptFile || DEFAULT_CONCEPT_FILE);
  if (fs.existsSync(conceptPath)) {
    try {
      const concept = JSON.parse(fs.readFileSync(conceptPath, "utf-8")) as GameConcept;
      const parts: string[] = [];
      if (concept.art_style) parts.push(concept.art_style);
      if (concept.color_palette?.length) parts.push(`color palette: ${concept.color_palette.slice(0, 4).join(", ")}`);
      if (concept.theme) parts.push(`theme: ${concept.theme}`);
      return parts.join(", ");
    } catch { /* ignore */ }
  }
  return "";
}
