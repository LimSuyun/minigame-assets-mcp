/**
 * ui.ts
 *
 * UI 에셋 생성 도구 모음.
 *
 * 도구 분류:
 *   - asset_generate_ui_structural : 코드 기반 (Sharp/SVG, NO AI) — 버튼/패널/프로그레스바/슬롯
 *   - asset_generate_ui_decorative : AI 기반 (gpt-image-1) — 장식적 아이콘/뱃지/엠블럼
 *   - asset_generate_button_set    : AI 기반 (gpt-image-1) — 비주얼 버튼 세트
 *   - asset_generate_hud_set       : AI 기반 — HUD 요소
 *   - asset_generate_icon_set      : AI 기반 — 아이콘 세트
 *   - asset_generate_screen_background : AI 기반 (gpt-image-2) — 화면 배경
 *   - asset_generate_popup_set     : AI 기반 — 팝업/다이얼로그 세트
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, DEFAULT_CONCEPT_FILE, DEFAULT_GAME_DESIGN_FILE, NO_TEXT_IN_IMAGE, NO_SHADOW_IN_IMAGE } from "../constants.js";
import { generateImageOpenAI, editImageOpenAI } from "../services/openai.js";
import { refineImagePrompt } from "../services/gpt5-prompt.js";
import { startLatencyTracker, buildCostTelemetry, buildEditCostTelemetry } from "../utils/cost-tracking.js";
import {
  buildAssetPath,
  saveBase64File,
  saveAssetToRegistry,
  generateAssetId,
  ensureDir,
} from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import { saveBase64Optimized } from "../utils/image-output.js";
import type { GameConcept, GeneratedAsset, GameDesign } from "../types.js";

// ─── 색상 유틸리티 ────────────────────────────────────────────────────────────

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace("#", "");
  return [
    parseInt(clean.slice(0, 2), 16) || 0,
    parseInt(clean.slice(2, 4), 16) || 0,
    parseInt(clean.slice(4, 6), 16) || 0,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  return `#${Math.max(0, Math.min(255, r)).toString(16).padStart(2, "0")}${Math.max(0, Math.min(255, g)).toString(16).padStart(2, "0")}${Math.max(0, Math.min(255, b)).toString(16).padStart(2, "0")}`;
}

function darken(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(Math.round(r * factor), Math.round(g * factor), Math.round(b * factor));
}

function lighten(hex: string, factor: number): string {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHex(
    Math.min(255, Math.round(r + (255 - r) * factor)),
    Math.min(255, Math.round(g + (255 - g) * factor)),
    Math.min(255, Math.round(b + (255 - b) * factor))
  );
}

function desaturate(hex: string): string {
  const [r, g, b] = hexToRgb(hex);
  const gray = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  return rgbToHex(gray, gray, gray);
}

// ─── SVG 생성 함수 ─────────────────────────────────────────────────────────────

interface ComponentSpec {
  type: "button" | "panel" | "progress_bar" | "slot";
  width: number;
  height: number;
  fill_color: string;
  bg_color: string;
  border_color: string;
  border_width: number;
  border_radius: number;
  opacity: number;
}

function buildButtonSvg(spec: ComponentSpec, state: string): string {
  const { width: W, height: H, border_width: BW, border_radius: RX } = spec;
  let fill = spec.fill_color;
  let border = spec.border_color;
  let opacity = spec.opacity;

  if (state === "pressed") {
    fill = darken(spec.fill_color, 0.72);
    border = darken(spec.border_color, 0.8);
  } else if (state === "disabled") {
    fill = desaturate(spec.fill_color);
    border = desaturate(spec.border_color);
    opacity *= 0.55;
  } else if (state === "hover") {
    fill = lighten(spec.fill_color, 0.18);
    border = lighten(spec.border_color, 0.12);
  }

  const x = BW / 2;
  const y = state === "pressed" ? BW : BW / 2;
  const w = W - BW;
  const h = H - BW;
  // pressed 상태: 상단 하이라이트 제거, 하단 그림자 추가
  const highlightY = BW * 1.5;
  const highlightH = Math.max(1, Math.round(H * 0.08));
  const shadow = state === "pressed" ? "" :
    `<rect x="${BW * 2}" y="${H - BW * 2 - 2}" width="${W - BW * 4}" height="3" rx="2" fill="${darken(fill, 0.5)}" opacity="0.4"/>`;
  const highlight = (state === "normal" || state === "hover") ?
    `<rect x="${BW * 3}" y="${highlightY}" width="${W - BW * 6}" height="${highlightH}" rx="${Math.min(highlightH, RX)}" fill="white" opacity="0.25"/>` : "";

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${RX}" ry="${RX}"
    fill="${fill}" stroke="${border}" stroke-width="${BW}"/>
  ${shadow}
  ${highlight}
</svg>`;
}

function buildPanelSvg(spec: ComponentSpec, state: string): string {
  const { width: W, height: H, border_width: BW, border_radius: RX } = spec;
  let fill = spec.fill_color;
  let border = spec.border_color;
  const opacity = spec.opacity * (state === "disabled" ? 0.5 : 1.0);

  if (state === "hover") { fill = lighten(fill, 0.05); }
  else if (state === "pressed") { fill = darken(fill, 0.85); }

  const x = BW / 2;
  const y = BW / 2;
  const w = W - BW;
  const h = H - BW;
  // 내부 하이라이트 라인
  const innerX = BW * 2;
  const innerY = BW * 2;
  const innerW = W - BW * 4;
  const innerH = H - BW * 4;
  const innerRX = Math.max(0, RX - BW);

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
  <rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${RX}" ry="${RX}"
    fill="${fill}" stroke="${border}" stroke-width="${BW}"/>
  <rect x="${innerX}" y="${innerY}" width="${innerW}" height="${innerH}" rx="${innerRX}" ry="${innerRX}"
    fill="none" stroke="white" stroke-width="1" opacity="0.15"/>
</svg>`;
}

function buildProgressBarSvg(spec: ComponentSpec, state: string): string {
  const { width: W, height: H, border_width: BW, border_radius: RX } = spec;
  const fillPercent = state === "empty" ? 0 : state === "half" ? 50 : 100;
  const fillW = Math.round((W - BW * 2) * fillPercent / 100);
  const opacity = spec.opacity;

  // Track (배경)
  const trackFill = spec.bg_color;
  // Fill (채움)
  const barFill = fillPercent === 0 ? spec.bg_color :
    fillPercent < 30 ? darken(spec.fill_color, 0.7) :
    fillPercent < 70 ? spec.fill_color :
    lighten(spec.fill_color, 0.1);

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
  <!-- Track -->
  <rect x="${BW / 2}" y="${BW / 2}" width="${W - BW}" height="${H - BW}" rx="${RX}" ry="${RX}"
    fill="${trackFill}" stroke="${spec.border_color}" stroke-width="${BW}"/>
  ${fillW > 0 ? `<!-- Fill -->
  <clipPath id="bar_clip">
    <rect x="${BW}" y="${BW}" width="${W - BW * 2}" height="${H - BW * 2}" rx="${Math.max(0, RX - BW)}" ry="${Math.max(0, RX - BW)}"/>
  </clipPath>
  <rect x="${BW}" y="${BW}" width="${fillW}" height="${H - BW * 2}" rx="${Math.max(0, RX - BW)}" ry="${Math.max(0, RX - BW)}"
    fill="${barFill}" clip-path="url(#bar_clip)"/>
  <!-- Shine -->
  <rect x="${BW}" y="${BW}" width="${fillW}" height="${Math.round((H - BW * 2) * 0.35)}" rx="${Math.max(0, RX - BW)}" ry="${Math.max(0, RX - BW)}"
    fill="white" opacity="0.2" clip-path="url(#bar_clip)"/>` : ""}
</svg>`;
}

function buildSlotSvg(spec: ComponentSpec, state: string): string {
  const { width: W, height: H, border_width: BW, border_radius: RX } = spec;
  let fill = spec.bg_color + "99"; // 60% opacity hex
  let border = spec.border_color;
  const opacity = spec.opacity * (state === "disabled" ? 0.5 : 1.0);

  if (state === "hover") { border = lighten(spec.border_color, 0.3); }
  else if (state === "pressed") { fill = spec.fill_color + "88"; }

  // 내부 십자/플러스 힌트
  const cx = W / 2;
  const cy = H / 2;
  const armLen = Math.round(Math.min(W, H) * 0.12);
  const armW = Math.max(1, Math.round(Math.min(W, H) * 0.04));

  return `<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg" style="opacity:${opacity}">
  <rect x="${BW / 2}" y="${BW / 2}" width="${W - BW}" height="${H - BW}" rx="${RX}" ry="${RX}"
    fill="${fill}" stroke="${border}" stroke-width="${BW}"/>
  <!-- 내부 플러스 힌트 -->
  <rect x="${cx - armW / 2}" y="${cy - armLen}" width="${armW}" height="${armLen * 2}"
    fill="${border}" opacity="0.3"/>
  <rect x="${cx - armLen}" y="${cy - armW / 2}" width="${armLen * 2}" height="${armW}"
    fill="${border}" opacity="0.3"/>
</svg>`;
}

function generateComponentSvg(spec: ComponentSpec, state: string): string {
  switch (spec.type) {
    case "button":       return buildButtonSvg(spec, state);
    case "panel":        return buildPanelSvg(spec, state);
    case "progress_bar": return buildProgressBarSvg(spec, state);
    case "slot":         return buildSlotSvg(spec, state);
    default:             return buildPanelSvg(spec, state);
  }
}

function calculateNineSlice(spec: ComponentSpec): {
  top: number; right: number; bottom: number; left: number;
  note: string;
} {
  const bw = Math.max(spec.border_width, 1);
  const margin = bw + spec.border_radius;
  return {
    top: margin,
    right: margin,
    bottom: margin,
    left: margin,
    note: `border_width=${bw} border_radius=${spec.border_radius}. Adjust if visual border extends beyond this.`,
  };
}

// ─── 스타일 힌트 로더 ────────────────────────────────────────────────────────

function loadStyleHint(conceptFile?: string, designFile?: string): string {
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
      } catch { /* ignore */ }
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

// ─── AI 이미지 생성 헬퍼 ─────────────────────────────────────────────────────

interface GenerateResult {
  base64: string;
  mimeType: string;
}

async function generateImage(
  prompt: string,
  size: string,
  openaiModel?: "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
  background?: "transparent" | "opaque" | "auto",
): Promise<GenerateResult> {
  const validSizes = ["1024x1024", "1792x1024", "1024x1792", "1536x1024", "1024x1536"];
  const safeSize = validSizes.includes(size) ? size : "1024x1024";
  return generateImageOpenAI({
    prompt,
    model: openaiModel,
    size: safeSize as "1024x1024",
    quality: "high",
    background: background ?? "transparent",
  });
}

// ─── 도구 등록 ────────────────────────────────────────────────────────────────

export function registerUITools(server: McpServer): void {

  // ── 1. UI 구조적 요소 생성 (코드 기반 - NO AI) ───────────────────────────
  server.registerTool(
    "asset_generate_ui_structural",
    {
      title: "Generate Structural UI Elements (Code-Based, NO AI)",
      description: `Generate structural UI elements using Sharp/SVG code generation — NO AI required.
Creates pixel-perfect, game-ready UI components from pure code.

IMPORTANT: This tool uses code generation (Sharp + SVG), not AI.
Use asset_generate_ui_decorative for AI-generated decorative elements.

Supported component types:
  - "button":       Rounded rectangle with state color variants
  - "panel":        Large container panel with inner highlight (nine-slice compatible)
  - "progress_bar": Track + fill with empty/half/full states
  - "slot":         Item slot / icon frame with transparent center and plus hint

State variants:
  - button: "normal" | "pressed" | "disabled" | "hover"
  - panel:  "normal" | "pressed" | "disabled" | "hover"
  - progress_bar: "empty" | "half" | "full"
  - slot:   "normal" | "hover" | "pressed" | "disabled"

Args:
  - components (array): Components to generate. Each:
      - type: "button" | "panel" | "progress_bar" | "slot"
      - id (string, optional): File name prefix
      - width (number): Width in pixels
      - height (number): Height in pixels
      - fill_color (string): Main fill hex color (default: "#6B48FF")
      - bg_color (string): Background/track color (default: "#1A1A2E")
      - border_color (string): Border hex color (default: "#FFFFFF")
      - border_width (number): Border thickness px (default: 2)
      - border_radius (number): Corner radius px (default: 8)
      - states (string[]): Variants to generate (default: ["normal"])
      - nine_slice (boolean): Output nine_slice.json guide (default: false)
      - opacity (number): Overall opacity 0.0-1.0 (default: 1.0)
  - output_dir (string, optional): Output directory

Returns:
  List of generated file paths with optional nine_slice data`,
      inputSchema: z.object({
        components: z.array(z.object({
          type: z.enum(["button", "panel", "progress_bar", "slot"]).describe("Component type"),
          id: z.string().max(100).optional().describe("File name prefix"),
          width: z.number().int().min(1).max(4096).describe("Width in pixels"),
          height: z.number().int().min(1).max(4096).describe("Height in pixels"),
          fill_color: z.string().default("#6B48FF").describe("Main fill hex color"),
          bg_color: z.string().default("#1A1A2E").describe("Background/track color"),
          border_color: z.string().default("#FFFFFF").describe("Border hex color"),
          border_width: z.number().int().min(0).max(32).default(2).describe("Border thickness px"),
          border_radius: z.number().int().min(0).max(512).default(8).describe("Corner radius px"),
          states: z.array(z.enum(["normal", "pressed", "disabled", "hover", "empty", "half", "full"]))
            .default(["normal"]).describe("State variants to generate"),
          nine_slice: z.boolean().default(false).describe("Generate nine_slice.json guide"),
          opacity: z.number().min(0).max(1).default(1.0).describe("Overall opacity 0.0-1.0"),
        })).min(1).max(20).describe("Components to generate"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      try {
        const sharpLib = (await import("sharp")).default;
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;

        const results: Array<{
          component: string;
          state: string;
          file_path: string;
          nine_slice_path?: string;
          nine_slice?: object;
          success: boolean;
          error?: string;
        }> = [];

        for (const comp of params.components) {
          const spec: ComponentSpec = {
            type: comp.type,
            width: comp.width,
            height: comp.height,
            fill_color: comp.fill_color,
            bg_color: comp.bg_color,
            border_color: comp.border_color,
            border_width: comp.border_width,
            border_radius: comp.border_radius,
            opacity: comp.opacity,
          };

          const componentId = comp.id || comp.type;

          for (const state of comp.states) {
            try {
              const svgText = generateComponentSvg(spec, state);
              const svgBuf = Buffer.from(svgText);

              let fileName =`${componentId}_${state}.png`;
              let filePath = buildAssetPath(outputDir, "ui/structural", fileName);
              ensureDir(path.dirname(filePath));

              await sharpLib(svgBuf)
                .png()
                .toFile(filePath);

              const resultEntry: (typeof results)[number] = {
                component: componentId,
                state,
                file_path: filePath,
                success: true,
              };

              // nine_slice.json 생성
              if (comp.nine_slice) {
                const nineSlice = calculateNineSlice(spec);
                const nsPath = filePath.replace(".png", "_nine_slice.json");
                fs.writeFileSync(nsPath, JSON.stringify({
                  image: fileName,
                  ...nineSlice,
                }, null, 2), "utf-8");
                resultEntry.nine_slice_path = nsPath;
                resultEntry.nine_slice = nineSlice;
              }

              results.push(resultEntry);
            } catch (err) {
              results.push({
                component: componentId,
                state,
                file_path: "",
                success: false,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0,
          method: "code_generation",
          ai_used: false,
          total: results.length,
          succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "ui/structural"),
          results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "UI Structural") }],
          isError: true,
        };
      }
    }
  );

  // ── 2. UI 장식적 요소 생성 (AI 기반) ─────────────────────────────────────
  server.registerTool(
    "asset_generate_ui_decorative",
    {
      title: "Generate Decorative UI Elements (AI-Based)",
      description: `Generate decorative UI elements using AI (gpt-image-1 for transparent PNG).
Decorative elements include: icons, badges, emblems, decorations, ornate frames, seals, medals.

Contrast with asset_generate_ui_structural which is code-generated.
This tool handles elements that require artistic/decorative AI generation.

Args:
  - elements (array): Decorative elements to generate. Each:
      - id (string): File name identifier (e.g., "crown_badge", "fire_emblem")
      - description (string): What the element depicts
      - element_type (string): "icon" | "badge" | "emblem" | "decoration" | "frame" | "seal" | "medal"
  - style_description (string): Overall decorative style (e.g., "Fantasy RPG, gold and purple, ornate")
  - concept_file (string, optional): Path to game concept
  - design_file (string, optional): Path to GAME_DESIGN.json
  - output_dir (string, optional): Output directory

Returns:
  List of generated decorative element files`,
      inputSchema: z.object({
        elements: z.array(z.object({
          id: z.string().min(1).max(100).describe("File name ID"),
          description: z.string().min(3).max(500).describe("What this decorative element depicts"),
          element_type: z.enum(["icon", "badge", "emblem", "decoration", "frame", "seal", "medal"])
            .default("icon").describe("Type of decorative element"),
        })).min(1).max(20).describe("Decorative elements to generate"),
        style_description: z.string().min(5).max(1000).describe("Overall decorative style"),
        concept_file: z.string().optional().describe("Path to game concept JSON"),
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);

        const TYPE_MODIFIERS: Record<string, string> = {
          icon:        "icon, small square design, clean edges",
          badge:       "badge shape, circular or shield-shaped, award style",
          emblem:      "emblem, heraldic design, ornate and detailed",
          decoration:  "decorative element, ornamental, intricate",
          frame:       "decorative frame/border, hollow center, ornate edges",
          seal:        "seal or stamp design, circular, official-looking",
          medal:       "medal or award, hanging ribbon optional, prestigious look",
        };

        const results: Array<{ id: string; file_path: string; success: boolean; error?: string }> = [];

        for (const element of params.elements) {
          const typeMod = TYPE_MODIFIERS[element.element_type] || "";
          const prompt = [
            `Game UI decorative element: ${element.description}.`,
            `Style: ${params.style_description}.`,
            typeMod + ".",
            styleHint ? `Game style context: ${styleHint}.` : "",
            "Transparent background. Single element centered. Clean game-ready art, high detail.",
            NO_SHADOW_IN_IMAGE,
            NO_TEXT_IN_IMAGE,
          ].filter(Boolean).join(" ");

          try {
            const result = await generateImage(prompt, "1024x1024");
            const safeId = element.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            let fileName =`deco_${safeId}.png`;
            let filePath = buildAssetPath(outputDir, "ui/decorative", fileName);
            ensureDir(path.dirname(filePath));
            const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "ui_decorative",
              provider: "openai",
              prompt,
              file_path: filePath,
              file_name: fileName,
              mime_type: _saved.mimeType,
              created_at: new Date().toISOString(),
              metadata: { element_id: element.id, element_type: element.element_type },
            };
            saveAssetToRegistry(asset, outputDir);
            results.push({ id: element.id, file_path: filePath, success: true });
          } catch (err) {
            results.push({ id: element.id, file_path: "", success: false, error: handleApiError(err, "Decorative") });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0,
          total: results.length,
          succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "ui/decorative"),
          results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "UI Decorative") }],
          isError: true,
        };
      }
    }
  );

  // ── 3. 버튼 세트 생성 (AI) ────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_button_set",
    {
      title: "Generate UI Button Set (AI)",
      description: `Generate a complete UI button set with multiple states using AI (gpt-image-1).
For code-generated buttons (precise pixel art), use asset_generate_ui_structural instead.

Args:
  - style_description (string): Visual style of the button
  - button_types (string[], optional): ["normal", "pressed", "disabled", "hover"] (default: ["normal","pressed","disabled"])
  - sizes (string[], optional): ["small", "normal", "wide"] (default: ["normal"])
  - concept_file (string, optional): Path to game concept
  - output_dir (string, optional): Output directory

Returns:
  List of generated button files grouped by type and size`,
      inputSchema: z.object({
        style_description: z.string().min(10).max(2000).describe("Visual style of the button"),
        button_types: z.array(z.enum(["normal", "pressed", "disabled", "hover"]))
          .default(["normal", "pressed", "disabled"]).describe("Button state variants"),
        sizes: z.array(z.enum(["small", "normal", "wide"])).default(["normal"]).describe("Button size variants"),
        concept_file: z.string().optional().describe("Path to game concept JSON"),
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);

        const STATE_MODIFIERS: Record<string, string> = {
          normal:   "default idle state, bright and inviting, clearly readable",
          pressed:  "pressed/active state, slightly darker and indented, sunken effect",
          disabled: "disabled/inactive state, desaturated gray tone, low contrast",
          hover:    "hover state, slightly brightened and glowing, subtle highlight",
        };

        const SIZE_SUFFIX: Record<string, string> = {
          small:  ", compact small button, narrow width",
          normal: ", standard medium button size",
          wide:   ", wide full-width button, longer horizontal",
        };

        const results: Array<{ type: string; size: string; file_path: string; success: boolean; error?: string }> = [];

        for (const state of params.button_types) {
          for (const size of params.sizes) {
            const prompt = [
              `Game UI button: ${params.style_description}.`,
              `State: ${STATE_MODIFIERS[state] || ""}${SIZE_SUFFIX[size] || ""}.`,
              styleHint ? `Game style: ${styleHint}.` : "",
              "Transparent background. Single button element only, centered. Clean game UI.",
              NO_SHADOW_IN_IMAGE,
              NO_TEXT_IN_IMAGE,
            ].filter(Boolean).join(" ");

            try {
              const result = await generateImage(prompt, "1024x1024");
              let fileName =`btn_${size}_${state}.png`;
              let filePath = buildAssetPath(outputDir, "ui/buttons", fileName);
              ensureDir(path.dirname(filePath));
              const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;
              saveAssetToRegistry({
                id: generateAssetId(), type: "image", asset_type: "ui_element",
                provider: "openai", prompt, file_path: filePath,
                file_name: fileName, mime_type: _saved.mimeType,
                created_at: new Date().toISOString(),
                metadata: { button_state: state, button_size: size },
              }, outputDir);
              results.push({ type: state, size, file_path: filePath, success: true });
            } catch (err) {
              results.push({ type: state, size, file_path: "", success: false, error: handleApiError(err, "Button") });
            }
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0, total: results.length, succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "ui/buttons"), results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Button Set") }],
          isError: true,
        };
      }
    }
  );

  // ── 4. HUD 요소 세트 생성 ──────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_hud_set",
    {
      title: "Generate HUD Element Set",
      description: `Generate a complete set of HUD (Heads-Up Display) elements for a game.

Args:
  - game_type (string): "rpg" | "platformer" | "shooter" | "puzzle" | "strategy" | "general"
  - style_description (string): HUD visual style
  - elements (string[], optional): Elements to generate (default: all)
  - concept_file (string, optional): Path to game concept
  - output_dir (string, optional): Output directory

Returns:
  List of generated HUD element files`,
      inputSchema: z.object({
        game_type: z.enum(["rpg", "platformer", "shooter", "puzzle", "strategy", "general"])
          .default("general").describe("Game genre for HUD style guidance"),
        style_description: z.string().min(10).max(2000).describe("HUD visual style description"),
        elements: z.array(z.enum([
          "health_bar_fill", "health_bar_bg",
          "energy_bar_fill", "energy_bar_bg",
          "score_frame", "minimap_frame", "ability_icon_bg",
        ])).default([
          "health_bar_fill", "health_bar_bg",
          "energy_bar_fill", "energy_bar_bg",
          "score_frame", "minimap_frame", "ability_icon_bg",
        ]).describe("HUD elements to generate"),
        concept_file: z.string().optional().describe("Path to game concept JSON"),
        design_file: z.string().optional().describe("Path to GAME_DESIGN.json"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);

        const ELEMENT_PROMPTS: Record<string, string> = {
          health_bar_fill: `HUD health bar FILL element: ${params.style_description}. Horizontal bar fill, red/green gradient. Transparent background.`,
          health_bar_bg:   `HUD health bar BACKGROUND FRAME: ${params.style_description}. Horizontal bar container, hollow inside. Transparent background.`,
          energy_bar_fill: `HUD energy/mana bar FILL: ${params.style_description}. Horizontal bar fill, blue/purple. Transparent background.`,
          energy_bar_bg:   `HUD energy bar BACKGROUND FRAME: ${params.style_description}. Horizontal bar frame, hollow. Transparent background.`,
          score_frame:     `HUD score DISPLAY FRAME: ${params.style_description}. Small rectangular panel for numbers. Transparent background.`,
          minimap_frame:   `HUD mini-map BORDER FRAME: ${params.style_description}. Square/circular frame for mini-map. Transparent background.`,
          ability_icon_bg: `HUD ability ICON SLOT: ${params.style_description}. Small square icon slot frame. Transparent background.`,
        };

        const results: Array<{ element: string; file_path: string; success: boolean; error?: string }> = [];

        for (const element of params.elements) {
          const basePrompt = ELEMENT_PROMPTS[element] || `HUD element ${element}: ${params.style_description}. Transparent background.`;
          const prompt = (styleHint ? `${basePrompt} Game style: ${styleHint}.` : basePrompt) + ` ${NO_SHADOW_IN_IMAGE} ${NO_TEXT_IN_IMAGE}`;

          try {
            const result = await generateImage(prompt, "1024x1024");
            let fileName =`hud_${element}.png`;
            let filePath = buildAssetPath(outputDir, "ui/hud", fileName);
            ensureDir(path.dirname(filePath));
            const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;
            saveAssetToRegistry({
              id: generateAssetId(), type: "image", asset_type: "ui_element",
              provider: "openai", prompt, file_path: filePath,
              file_name: fileName, mime_type: _saved.mimeType,
              created_at: new Date().toISOString(),
              metadata: { hud_element: element, game_type: params.game_type },
            }, outputDir);
            results.push({ element, file_path: filePath, success: true });
          } catch (err) {
            results.push({ element, file_path: "", success: false, error: handleApiError(err, "HUD") });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0, game_type: params.game_type,
          total: results.length, succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "ui/hud"), results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "HUD Set") }],
          isError: true,
        };
      }
    }
  );

  // ── 5. 아이콘 세트 생성 ────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_icon_set",
    {
      title: "Generate UI Icon Set",
      description: `Generate a set of UI icons with consistent visual style.

Args:
  - icons (array): Icons to generate. Each: id (string), description (string)
  - icon_style (string): "flat" | "illustrated" | "pixel" | "3d"
  - background_shape (string): "none" | "circle" | "rounded_square" | "diamond"
  - background_color (string, optional): Hex or "transparent"
  - style_description (string): Overall icon set style
  - output_dir (string, optional): Output directory

Returns:
  List of generated icon files`,
      inputSchema: z.object({
        icons: z.array(z.object({
          id: z.string().min(1).max(100).describe("Icon ID"),
          description: z.string().min(3).max(500).describe("What the icon depicts"),
        })).min(1).max(20).describe("Icons to generate"),
        icon_style: z.enum(["flat", "illustrated", "pixel", "3d"]).default("illustrated"),
        background_shape: z.enum(["none", "circle", "rounded_square", "diamond"]).default("rounded_square"),
        background_color: z.string().default("transparent"),
        style_description: z.string().min(5).max(1000).describe("Overall icon set style"),
        concept_file: z.string().optional(),
        design_file: z.string().optional(),
        output_dir: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);

        const STYLE_MODS: Record<string, string> = {
          flat:        "flat design icon, minimal, solid colors, no gradients, crisp",
          illustrated: "illustrated icon, detailed rendering, soft shading, hand-crafted",
          pixel:       "pixel art icon, 16x16 or 32x32 grid, retro style, limited palette",
          "3d":        "3D rendered icon, slight perspective, depth, highlights and shadows",
        };
        const BG_MODS: Record<string, string> = {
          none:          "no background, fully transparent",
          circle:        "circular background plate",
          rounded_square:"rounded square badge/plate",
          diamond:       "diamond/rhombus background plate",
        };

        const results: Array<{ id: string; file_path: string; success: boolean; error?: string }> = [];

        for (const icon of params.icons) {
          const bgColor = params.background_color !== "transparent"
            ? `, background color: ${params.background_color}` : "";
          const prompt = [
            `Game UI icon: ${icon.description}.`,
            `Style: ${params.style_description}.`,
            `${STYLE_MODS[params.icon_style] || ""}.`,
            `${BG_MODS[params.background_shape] || ""}${bgColor}.`,
            styleHint ? `Game style: ${styleHint}.` : "",
            "Single icon centered, square composition, clean and game-ready.",
            NO_SHADOW_IN_IMAGE,
            NO_TEXT_IN_IMAGE,
          ].filter(Boolean).join(" ");

          try {
            const result = await generateImage(prompt, "1024x1024");
            const safeId = icon.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            let fileName =`icon_${safeId}.png`;
            let filePath = buildAssetPath(outputDir, "ui/icons", fileName);
            ensureDir(path.dirname(filePath));
            const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;
            saveAssetToRegistry({
              id: generateAssetId(), type: "image", asset_type: "icon",
              provider: "openai", prompt, file_path: filePath,
              file_name: fileName, mime_type: _saved.mimeType,
              created_at: new Date().toISOString(),
              metadata: { icon_id: icon.id, icon_style: params.icon_style },
            }, outputDir);
            results.push({ id: icon.id, file_path: filePath, success: true });
          } catch (err) {
            results.push({ id: icon.id, file_path: "", success: false, error: handleApiError(err, "Icon") });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0, total: results.length, succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "ui/icons"), results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Icon Set") }],
          isError: true,
        };
      }
    }
  );

  // ── 6. 화면 배경 생성 ──────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_screen_background",
    {
      title: "Generate Screen Background",
      description: `Generate a full-screen background for a specific game screen (기본: OpenAI gpt-image-2).

**Target Layer**: GameScene **Layer 0 (배경)** — \`style: parallax\` 시 sub-depth 0.0/0.1/0.2로 배치. 자세한 레이어 시스템은 \`templates/docs/layer-system.md\` 참조.

Supports:
- "static": Single background image — **openai/gpt-image-2 권장** (불투명 PNG, 디테일 우수)
- "parallax": 3 layers (far/mid/near) for parallax scrolling
  - far  = SW×2.5 width (sky, distant horizon) — openai/gpt-image-2 가능 (불투명)
  - mid  = SW×3.5 width (midground elements, 투명 PNG)
  - near = SW×5.0 width (foreground elements, 투명 PNG)

**주의**: gpt-image-2는 네이티브 투명 배경을 지원하지 않습니다.
- static 배경 (불투명): openai/gpt-image-2가 최적

Args:
  - screen_name (string): Name of the screen
  - description (string): Detailed background description
  - style (string, optional): "static" | "parallax" (default: "static")
  - model (string, optional): OpenAI 모델. 기본: gpt-image-2
  - aspect_ratio (string, optional): "9:16" | "16:9" | "1:1" (default: "9:16")
  - concept_file (string, optional): Path to game concept
  - output_dir (string, optional): Output directory

Returns:
  File path(s) of generated background(s)`,
      inputSchema: z.object({
        screen_name: z.string().min(1).max(200).describe("Screen name for this background"),
        description: z.string().min(10).max(3000).describe("Detailed background description"),
        style: z.enum(["static", "parallax"]).default("static").describe("Background type"),
        model: z.string().optional().describe("OpenAI 모델 override. 기본: gpt-image-2"),
        aspect_ratio: z.enum(["9:16", "16:9", "1:1", "3:4", "4:3"]).default("9:16"),
        concept_file: z.string().optional(),
        design_file: z.string().optional(),
        output_dir: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);
        const safeScreenName = params.screen_name.replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase();

        const BASE_PROMPT = [
          `2D game background for "${params.screen_name}": ${params.description}.`,
          styleHint ? `Art style: ${styleHint}.` : "",
          "NO characters, NO UI elements, NO text. Fill entire canvas edge to edge.",
          "Rich detailed environment art. Game-quality illustration.",
        ].filter(Boolean).join(" ");

        const results: Array<{ layer: string; file_path: string; success: boolean; error?: string }> = [];

        const openaiModel = (params.model ?? "gpt-image-2") as
          | "gpt-image-2"
          | "gpt-image-1.5"
          | "gpt-image-1"
          | "gpt-image-1-mini";

        if (params.style === "static") {
          try {
            // static 배경은 불투명 PNG가 표준. gpt-image-2는 투명 미지원이라 "opaque" 명시.
            const result = await generateImage(
              BASE_PROMPT + " Complete scene with full foreground, midground, and background.",
              "1024x1024",
              openaiModel,
              "opaque",
            );
            let fileName =`bg_${safeScreenName}.png`;
            let filePath = buildAssetPath(outputDir, "backgrounds", fileName);
            ensureDir(path.dirname(filePath));
            const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;
            saveAssetToRegistry({
              id: generateAssetId(), type: "image", asset_type: "background",
              provider: "openai", prompt: BASE_PROMPT, file_path: filePath,
              file_name: fileName, mime_type: _saved.mimeType,
              created_at: new Date().toISOString(),
              metadata: { screen_name: params.screen_name, style: "static" },
            }, outputDir);
            results.push({ layer: "static", file_path: filePath, success: true });
          } catch (err) {
            results.push({ layer: "static", file_path: "", success: false, error: handleApiError(err, "Background") });
          }
        } else {
          const LAYERS: Array<{ id: string; suffix: string; promptExtra: string; aspectRatio: string }> = [
            { id: "far",  suffix: "_bg_far",  promptExtra: "FAR LAYER: Only sky, distant mountains/horizon, very distant elements. No foreground.",  aspectRatio: "16:9" },
            { id: "mid",  suffix: "_bg_mid",  promptExtra: "MID LAYER: Only midground — trees, buildings at medium distance. Transparent PNG, no sky.", aspectRatio: "16:9" },
            { id: "near", suffix: "_bg_near", promptExtra: "NEAR LAYER: Only foreground elements — ground, rocks, plants at bottom. Transparent PNG.", aspectRatio: "16:9" },
          ];

          for (const layer of LAYERS) {
            try {
              const prompt = `${BASE_PROMPT} ${layer.promptExtra}`;
              const layerBackground = layer.id === "far" ? "opaque" as const : "transparent" as const;
              const result = await generateImage(
                prompt,
                "1792x1024",
                openaiModel,
                layerBackground,
              );
              let fileName =`bg_${safeScreenName}${layer.suffix}.png`;
              let filePath = buildAssetPath(outputDir, "backgrounds", fileName);
              ensureDir(path.dirname(filePath));
              const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;
              saveAssetToRegistry({
                id: generateAssetId(), type: "image", asset_type: "background",
                provider: "openai", prompt, file_path: filePath,
                file_name: fileName, mime_type: _saved.mimeType,
                created_at: new Date().toISOString(),
                metadata: { screen_name: params.screen_name, style: "parallax", layer: layer.id },
              }, outputDir);
              results.push({ layer: layer.id, file_path: filePath, success: true });
            } catch (err) {
              results.push({ layer: layer.id, file_path: "", success: false, error: handleApiError(err, `Background ${layer.id}`) });
            }
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0, screen_name: params.screen_name,
          style: params.style, total: results.length, succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "backgrounds"), results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Screen Background") }],
          isError: true,
        };
      }
    }
  );

  // ── 7. 팝업 세트 생성 (AI) ────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_popup_set",
    {
      title: "Generate Popup/Dialog Set (AI)",
      description: `Generate a set of popup and dialog UI panels using AI.
Generates decorated popup windows with art style matching the game theme.

Popup types:
  - "dialog":     Standard message/dialog popup
  - "reward":     Reward/chest popup with celebratory style
  - "confirm":    Yes/No confirmation dialog
  - "settings":   Settings/options panel
  - "inventory":  Item inventory grid popup
  - "shop":       In-game store/shop popup
  - "gameover":   Game over / result screen panel

Args:
  - popup_types (string[]): Popup types to generate (default: ["dialog", "reward", "confirm"])
  - style_description (string): Visual style of the popups
  - concept_file (string, optional): Path to game concept
  - output_dir (string, optional): Output directory

Returns:
  List of generated popup panel files`,
      inputSchema: z.object({
        popup_types: z.array(z.enum(["dialog", "reward", "confirm", "settings", "inventory", "shop", "gameover"]))
          .default(["dialog", "reward", "confirm"]).describe("Popup types to generate"),
        style_description: z.string().min(10).max(2000).describe("Visual style of the popups"),
        concept_file: z.string().optional(),
        design_file: z.string().optional(),
        output_dir: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);

        const TYPE_DESCS: Record<string, string> = {
          dialog:    "Standard message/dialog popup. Centered panel with title area at top and content area below. Decorative border and background.",
          reward:    "Reward popup with celebratory design. Gold/sparkle accents, treasure chest visual. Exciting and festive style.",
          confirm:   "Yes/No confirmation dialog. Clean centered panel with two button areas at bottom (confirm and cancel).",
          settings:  "Settings/options panel. Organized list layout with toggle/slider areas. Clean structured design.",
          inventory: "Inventory grid popup. Multiple equal-sized slots arranged in rows and columns. Grid-based layout.",
          shop:      "In-game shop popup. Item display areas with price tags. Commercial/storefront aesthetic.",
          gameover:  "Game over/result panel. Dramatic presentation with score display area. Victory or defeat variants.",
        };

        const results: Array<{ type: string; file_path: string; success: boolean; error?: string }> = [];

        for (const popupType of params.popup_types) {
          const desc = TYPE_DESCS[popupType] || `${popupType} popup panel`;
          const prompt = [
            `Game UI popup: ${params.style_description}.`,
            `Popup type: ${desc}`,
            styleHint ? `Game art style: ${styleHint}.` : "",
            "Transparent background. No text or icons inside popup. Clean hollow interior. High quality 2D game UI art.",
            NO_SHADOW_IN_IMAGE,
            NO_TEXT_IN_IMAGE,
          ].filter(Boolean).join(" ");

          try {
            const result = await generateImage(prompt, "1024x1024");
            let fileName =`popup_${popupType}.png`;
            let filePath = buildAssetPath(outputDir, "ui/popups", fileName);
            ensureDir(path.dirname(filePath));
            const _saved = await saveBase64Optimized(result.base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;
            saveAssetToRegistry({
              id: generateAssetId(), type: "image", asset_type: "ui_popup",
              provider: "openai", prompt, file_path: filePath,
              file_name: fileName, mime_type: _saved.mimeType,
              created_at: new Date().toISOString(),
              metadata: { popup_type: popupType },
            }, outputDir);
            results.push({ type: popupType, file_path: filePath, success: true });
          } catch (err) {
            results.push({ type: popupType, file_path: "", success: false, error: handleApiError(err, "Popup") });
          }
        }

        const succeeded = results.filter((r) => r.success).length;
        const output = {
          success: succeeded > 0, total: results.length, succeeded,
          failed: results.length - succeeded,
          output_dir: path.resolve(outputDir, "ui/popups"), results,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Popup Set") }],
          isError: true,
        };
      }
    }
  );

  // ── 7. 로딩 화면 ────────────────────────────────────────────────────────────
  registerLoadingScreenTool(server);

  // ── 8. 로비/메인 화면 ───────────────────────────────────────────────────────
  registerLobbyScreenTool(server);
}

// ─── 로딩 화면 구현 ──────────────────────────────────────────────────────────

function registerLoadingScreenTool(server: McpServer): void {
  server.registerTool(
    "asset_generate_loading_screen",
    {
      title: "Generate Game Loading Screen",
      description: `게임 로딩 화면을 1장 생성합니다 (기본: OpenAI gpt-image-2, 불투명 풀스크린).

**Target Scene**: **LoadingScene** (풀스크린 배경) — depth/layer 체계 밖의 Scene 레벨 에셋. GameScene과 다른 별도 씬으로 사용. 자세한 Scene vs Layer 구분은 \`templates/docs/layer-system.md\` 참조.

**특징**:
- 중앙 하단에 로딩 인디케이터 / 프로그레스 바가 놓일 공간 확보 (하단 20% 여백)
- 몰입감 있는 분위기 아트, 게임 스타일·팔레트 반영
- 레퍼런스 이미지(hero_image_path / background_image_path) 제공 시 gpt-image-2 edit API로 합성 → 일관성·디테일 우수

**사용 팁**:
- 히어로 캐릭터 PNG 1장을 hero_image_path로 넘기면 그 캐릭터를 중앙/한 쪽에 실루엣이나 포즈로 배치하는 로딩 아트 생성
- CONCEPT.md에서 자동으로 아트 스타일·팔레트 힌트를 읽어옴

Args:
  - game_name (string): 게임 이름
  - description (string, optional): 로딩 화면 아트 방향 (예: "어두운 던전 입구, 횃불 빛, 긴장감")
  - hero_image_path (string, optional): 히어로 캐릭터 레퍼런스 PNG
  - background_image_path (string, optional): 배경 레퍼런스 PNG
  - aspect_ratio (string, optional): "16:9" (기본), "9:16", "1:1"
  - model (string, optional): OpenAI 모델. 기본: gpt-image-2
  - refine_prompt (boolean, optional): GPT-5로 프롬프트 확장 (기본: false)
  - concept_file (string, optional): CONCEPT.md 경로
  - design_file (string, optional): GAME_DESIGN.json 경로
  - output_dir (string, optional): 출력 디렉토리

Returns:
  생성된 로딩 화면 PNG 파일 경로 + 메타데이터.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름"),
        description: z.string().max(2000).optional().describe("아트 방향 설명"),
        hero_image_path: z.string().optional().describe("히어로 레퍼런스 이미지 경로"),
        background_image_path: z.string().optional().describe("배경 레퍼런스 이미지 경로"),
        aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9").describe("종횡비"),
        model: z.string().optional().describe("OpenAI 모델 override. 기본: gpt-image-2"),
        refine_prompt: z.boolean().default(false).describe("GPT-5로 프롬프트 확장 후 생성"),
        concept_file: z.string().optional(),
        design_file: z.string().optional(),
        output_dir: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const latency = startLatencyTracker();
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);
        const safeName = params.game_name.toLowerCase().replace(/\s+/g, "_").replace(/[^\w가-힣-]/g, "");

        const basePrompt = [
          `2D game LOADING SCREEN artwork for "${params.game_name}".`,
          params.description ? `Scene: ${params.description}.` : "",
          styleHint ? `Art style: ${styleHint}.` : "",
          `COMPOSITION: atmospheric full-screen illustration. Focal subject in upper 60% of frame. ` +
          `Leave the BOTTOM 20-25% visually quieter (no busy details) — this area will hold a loading indicator/progress bar. ` +
          `No UI elements, no buttons, no text rendered in the image.`,
          `Cinematic lighting, immersive mood, rich environmental detail.`,
          `${NO_TEXT_IN_IMAGE}`,
        ].filter(Boolean).join(" ");

        // GPT-5 refine (opt-in)
        let prompt = basePrompt;
        let refinedByGPT5 = false;
        if (params.refine_prompt) {
          try {
            prompt = await refineImagePrompt({
              userDescription: basePrompt,
              targetModel: (params.model ?? "gpt-image-2") as "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
              assetType: "background",
              conceptHint: styleHint,
            });
            refinedByGPT5 = true;
          } catch (e) {
            console.warn(`[refine_prompt] loading_screen refinement failed: ${e instanceof Error ? e.message : e}`);
          }
        }

        // 레퍼런스 수집
        const refPaths: string[] = [];
        if (params.background_image_path) {
          if (!fs.existsSync(params.background_image_path)) throw new Error(`background_image_path 파일 없음: ${params.background_image_path}`);
          refPaths.push(params.background_image_path);
        }
        if (params.hero_image_path) {
          if (!fs.existsSync(params.hero_image_path)) throw new Error(`hero_image_path 파일 없음: ${params.hero_image_path}`);
          refPaths.push(params.hero_image_path);
        }

        const effectiveModel = (params.model ?? "gpt-image-2") as
          | "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini";

        const size = params.aspect_ratio === "9:16" ? "1024x1536"
          : params.aspect_ratio === "1:1" ? "1024x1024"
          : "1536x1024";

        let base64: string;
        let generationMethod: string;

        if (refPaths.length > 0) {
          const r = await editImageOpenAI({
            imagePaths: refPaths,
            prompt,
            model: effectiveModel,
            size: size as "1024x1024" | "1536x1024" | "1024x1536",
          });
          base64 = r.base64;
          generationMethod = `openai_${effectiveModel}_edit (${refPaths.length} refs)`;
        } else {
          const r = await generateImageOpenAI({
            prompt,
            model: effectiveModel,
            size: size as "1024x1024" | "1536x1024" | "1024x1536",
            quality: "high",
            background: "opaque",
          });
          base64 = r.base64;
          generationMethod = `openai_${effectiveModel}_${size}`;
        }

        let fileName =`loading_${safeName}.png`;
        let filePath = buildAssetPath(outputDir, "screens/loading", fileName);
        ensureDir(path.dirname(filePath));
        const _saved = await saveBase64Optimized(base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;

        const asset: GeneratedAsset = {
          id: generateAssetId(), type: "image", asset_type: "background",
          provider: "openai", prompt, file_path: filePath,
          file_name: fileName, mime_type: _saved.mimeType,
          created_at: new Date().toISOString(),
          metadata: {
            screen_type: "loading",
            game_name: params.game_name,
            aspect_ratio: params.aspect_ratio,
            generation_method: generationMethod,
            reference_images: refPaths,
            refined_by_gpt5: refinedByGPT5,
            ...(refPaths.length > 0
              ? buildEditCostTelemetry(effectiveModel, size, latency.elapsed(), refPaths.length)
              : buildCostTelemetry(effectiveModel, "high", size, latency.elapsed())),
          },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              screen_type: "loading",
              file_path: filePath,
              asset_id: asset.id,
              aspect_ratio: params.aspect_ratio,
              generation_method: generationMethod,
              reference_images_used: refPaths.length,
              refined_by_gpt5: refinedByGPT5,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Loading Screen") }], isError: true };
      }
    }
  );
}

// ─── 로비/메인 메뉴 화면 구현 ────────────────────────────────────────────────

function registerLobbyScreenTool(server: McpServer): void {
  server.registerTool(
    "asset_generate_lobby_screen",
    {
      title: "Generate Game Lobby / Main Menu Screen",
      description: `게임 로비/메인 메뉴 화면을 생성합니다 (기본: OpenAI gpt-image-2, 불투명 풀스크린).

**Target Scene**: **LobbyScene / MainMenuScene** (풀스크린 배경) — depth/layer 체계 밖의 Scene 레벨. 메뉴 UI는 \`menu_side\` 영역 위에 별도로 렌더링.

**특징**:
- 히어로 쇼케이스 구도 (히어로 이미지 제공 시 중앙~한쪽에 포즈로 배치)
- 메뉴 UI가 올라갈 공간 확보 (menu_side 파라미터로 지정: left/right/center/bottom)
- CONCEPT.md 스타일 힌트 자동 적용
- 레퍼런스 이미지(hero/background) 다중 합성 가능

Args:
  - game_name (string): 게임 이름
  - description (string, optional): 아트 방향 설명
  - hero_image_path (string, optional): 히어로 레퍼런스
  - background_image_path (string, optional): 배경 레퍼런스
  - menu_side (string, optional): 메뉴 UI가 놓일 영역 — "left" / "right" / "center" / "bottom" (기본: "right")
  - aspect_ratio (string, optional): "16:9" (기본), "9:16", "1:1"
  - model (string, optional): OpenAI 모델. 기본: gpt-image-2
  - refine_prompt (boolean, optional): GPT-5 리파인 (기본: false)
  - concept_file, design_file, output_dir

Returns:
  생성된 로비 화면 PNG 경로.`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100),
        description: z.string().max(2000).optional(),
        hero_image_path: z.string().optional(),
        background_image_path: z.string().optional(),
        menu_side: z.enum(["left", "right", "center", "bottom"]).default("right")
          .describe("메뉴 UI 영역. 해당 영역은 시각적으로 덜 복잡하게 생성됨"),
        aspect_ratio: z.enum(["16:9", "9:16", "1:1"]).default("16:9"),
        model: z.string().optional(),
        refine_prompt: z.boolean().default(false),
        concept_file: z.string().optional(),
        design_file: z.string().optional(),
        output_dir: z.string().optional(),
      }).strict(),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (params) => {
      const latency = startLatencyTracker();
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const styleHint = loadStyleHint(params.concept_file, params.design_file);
        const safeName = params.game_name.toLowerCase().replace(/\s+/g, "_").replace(/[^\w가-힣-]/g, "");

        const sideInstruction: Record<string, string> = {
          left: "LEFT HALF should be visually quieter (simpler background, fewer details) — menu UI will be placed there. Hero subject in RIGHT HALF.",
          right: "RIGHT HALF should be visually quieter (simpler background, fewer details) — menu UI will be placed there. Hero subject in LEFT HALF.",
          center: "Upper 60% contains the focal hero/scene. Lower 40% is visually quieter — menu UI will be placed there.",
          bottom: "Upper 70% contains the full scene with hero. BOTTOM 30% is visually quieter — bottom menu bar will be placed there.",
        };

        const basePrompt = [
          `2D game LOBBY / MAIN MENU screen artwork for "${params.game_name}".`,
          params.description ? `Scene description: ${params.description}.` : "",
          styleHint ? `Art style: ${styleHint}.` : "",
          `HERO SHOWCASE composition — the player's hero character should be the visual focal point, confident pose, cinematic lighting.`,
          `LAYOUT: ${sideInstruction[params.menu_side]}`,
          `High-quality marketing-grade illustration. Rich environmental detail but NOT busy where UI will be placed.`,
          `No UI elements, no buttons, no text rendered in the image.`,
          `${NO_TEXT_IN_IMAGE}`,
        ].filter(Boolean).join(" ");

        let prompt = basePrompt;
        let refinedByGPT5 = false;
        if (params.refine_prompt) {
          try {
            prompt = await refineImagePrompt({
              userDescription: basePrompt,
              targetModel: (params.model ?? "gpt-image-2") as "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini",
              assetType: "thumbnail",
              conceptHint: styleHint,
            });
            refinedByGPT5 = true;
          } catch (e) {
            console.warn(`[refine_prompt] lobby_screen refinement failed: ${e instanceof Error ? e.message : e}`);
          }
        }

        const refPaths: string[] = [];
        if (params.background_image_path) {
          if (!fs.existsSync(params.background_image_path)) throw new Error(`background_image_path 파일 없음: ${params.background_image_path}`);
          refPaths.push(params.background_image_path);
        }
        if (params.hero_image_path) {
          if (!fs.existsSync(params.hero_image_path)) throw new Error(`hero_image_path 파일 없음: ${params.hero_image_path}`);
          refPaths.push(params.hero_image_path);
        }

        const effectiveModel = (params.model ?? "gpt-image-2") as
          | "gpt-image-2" | "gpt-image-1.5" | "gpt-image-1" | "gpt-image-1-mini";

        const size = params.aspect_ratio === "9:16" ? "1024x1536"
          : params.aspect_ratio === "1:1" ? "1024x1024"
          : "1536x1024";

        let base64: string;
        let generationMethod: string;

        if (refPaths.length > 0) {
          const r = await editImageOpenAI({
            imagePaths: refPaths,
            prompt,
            model: effectiveModel,
            size: size as "1024x1024" | "1536x1024" | "1024x1536",
          });
          base64 = r.base64;
          generationMethod = `openai_${effectiveModel}_edit (${refPaths.length} refs)`;
        } else {
          const r = await generateImageOpenAI({
            prompt,
            model: effectiveModel,
            size: size as "1024x1024" | "1536x1024" | "1024x1536",
            quality: "high",
            background: "opaque",
          });
          base64 = r.base64;
          generationMethod = `openai_${effectiveModel}_${size}`;
        }

        let fileName =`lobby_${safeName}.png`;
        let filePath = buildAssetPath(outputDir, "screens/lobby", fileName);
        ensureDir(path.dirname(filePath));
        const _saved = await saveBase64Optimized(base64, filePath); filePath = _saved.filePath; fileName = _saved.fileName;

        const asset: GeneratedAsset = {
          id: generateAssetId(), type: "image", asset_type: "background",
          provider: "openai", prompt, file_path: filePath,
          file_name: fileName, mime_type: _saved.mimeType,
          created_at: new Date().toISOString(),
          metadata: {
            screen_type: "lobby",
            game_name: params.game_name,
            menu_side: params.menu_side,
            aspect_ratio: params.aspect_ratio,
            generation_method: generationMethod,
            reference_images: refPaths,
            refined_by_gpt5: refinedByGPT5,
            ...(refPaths.length > 0
              ? buildEditCostTelemetry(effectiveModel, size, latency.elapsed(), refPaths.length)
              : buildCostTelemetry(effectiveModel, "high", size, latency.elapsed())),
          },
        };
        saveAssetToRegistry(asset, outputDir);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              screen_type: "lobby",
              file_path: filePath,
              asset_id: asset.id,
              menu_side: params.menu_side,
              aspect_ratio: params.aspect_ratio,
              generation_method: generationMethod,
              reference_images_used: refPaths.length,
              refined_by_gpt5: refinedByGPT5,
            }, null, 2),
          }],
        };
      } catch (error) {
        return { content: [{ type: "text" as const, text: handleApiError(error, "Lobby Screen") }], isError: true };
      }
    }
  );
}
