import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import sharp from "sharp";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { generateImageOpenAI } from "../services/openai.js";
import { buildAssetPath, saveAssetToRegistry, generateAssetId, ensureDir } from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GeneratedAsset } from "../types.js";

// ─── SVG generators ───────────────────────────────────────────────────────────

function svgSpotlight(w: number, h: number, color: string): string {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.28;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <mask id="hole">
        <rect width="${w}" height="${h}" fill="white"/>
        <circle cx="${cx}" cy="${cy}" r="${r}" fill="black"/>
      </mask>
    </defs>
    <rect width="${w}" height="${h}" fill="rgba(0,0,0,0.70)" mask="url(#hole)"/>
  </svg>`;
  void color;
}

function svgArrowPointer(w: number, h: number, direction: string, color: string): string {
  const cx = w / 2;
  const cy = h / 2;
  const size = Math.min(w, h) * 0.35;
  let points = "";
  switch (direction) {
    case "up":
      points = `${cx},${cy - size} ${cx - size * 0.6},${cy + size * 0.5} ${cx + size * 0.6},${cy + size * 0.5}`;
      break;
    case "down":
      points = `${cx},${cy + size} ${cx - size * 0.6},${cy - size * 0.5} ${cx + size * 0.6},${cy - size * 0.5}`;
      break;
    case "left":
      points = `${cx - size},${cy} ${cx + size * 0.5},${cy - size * 0.6} ${cx + size * 0.5},${cy + size * 0.6}`;
      break;
    case "right":
    default:
      points = `${cx + size},${cy} ${cx - size * 0.5},${cy - size * 0.6} ${cx - size * 0.5},${cy + size * 0.6}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <polygon points="${points}" fill="${color}" stroke="#000000" stroke-width="3"/>
  </svg>`;
}

function svgGestureTap(w: number, h: number, color: string): string {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.3;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" fill-opacity="0.85" stroke="#000000" stroke-width="4"/>
    <circle cx="${cx}" cy="${cy}" r="${r * 0.4}" fill="#000000" fill-opacity="0.4"/>
  </svg>`;
}

function svgGestureSwipe(w: number, h: number, direction: string, color: string): string {
  const cx = w / 2;
  const cy = h / 2;
  const len = Math.min(w, h) * 0.38;
  let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
  switch (direction) {
    case "up":    y1 = cy + len; y2 = cy - len; break;
    case "down":  y1 = cy - len; y2 = cy + len; break;
    case "left":  x1 = cx + len; x2 = cx - len; break;
    case "right":
    default:      x1 = cx - len; x2 = cx + len;
  }
  const arrowSize = len * 0.25;
  let arrowHead = "";
  switch (direction) {
    case "up":    arrowHead = `M${x2},${y2} l${-arrowSize * 0.6},${arrowSize} l${arrowSize * 1.2},0`; break;
    case "down":  arrowHead = `M${x2},${y2} l${-arrowSize * 0.6},${-arrowSize} l${arrowSize * 1.2},0`; break;
    case "left":  arrowHead = `M${x2},${y2} l${arrowSize},${-arrowSize * 0.6} l0,${arrowSize * 1.2}`; break;
    case "right":
    default:      arrowHead = `M${x2},${y2} l${-arrowSize},${-arrowSize * 0.6} l0,${arrowSize * 1.2}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="8" stroke-linecap="round"/>
    <path d="${arrowHead}" fill="${color}" stroke="#000000" stroke-width="2"/>
  </svg>`;
}

function svgDialogBubble(w: number, h: number, tailDir: string, color: string): string {
  const pad = Math.min(w, h) * 0.08;
  const bw = w - pad * 2;
  const bh = h * 0.65;
  const bx = pad;
  const by = pad;
  const r = 18;
  const tailSize = h * 0.18;
  const cx = w / 2;
  let tailPath = "";
  switch (tailDir) {
    case "bottom":
      tailPath = `M${cx - tailSize * 0.6},${by + bh} L${cx},${by + bh + tailSize} L${cx + tailSize * 0.6},${by + bh}`;
      break;
    case "left":
      tailPath = `M${bx},${by + bh * 0.5 - tailSize * 0.6} L${bx - tailSize},${by + bh * 0.5} L${bx},${by + bh * 0.5 + tailSize * 0.6}`;
      break;
    case "right":
      tailPath = `M${bx + bw},${by + bh * 0.5 - tailSize * 0.6} L${bx + bw + tailSize},${by + bh * 0.5} L${bx + bw},${by + bh * 0.5 + tailSize * 0.6}`;
      break;
    case "top":
    default:
      tailPath = `M${cx - tailSize * 0.6},${by} L${cx},${by - tailSize} L${cx + tailSize * 0.6},${by}`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${r}" ry="${r}" fill="${color}" stroke="#000000" stroke-width="3"/>
    <path d="${tailPath}" fill="${color}" stroke="#000000" stroke-width="3" stroke-linejoin="round"/>
  </svg>`;
}

function svgStepIndicator(w: number, h: number, color: string): string {
  const fontSize = Math.round(Math.min(w, h) * 0.28);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect x="0" y="0" width="${w}" height="${h}" rx="12" fill="rgba(0,0,0,0.6)"/>
    <text
      x="${w / 2}" y="${h / 2 + fontSize * 0.36}"
      font-family="Arial, sans-serif"
      font-size="${fontSize}"
      font-weight="bold"
      fill="${color}"
      text-anchor="middle"
    >1/5</text>
  </svg>`;
}

function svgHighlightRing(w: number, h: number, color: string): string {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.42;
  const strokeW = Math.min(w, h) * 0.06;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="${strokeW}" stroke-dasharray="12 6"/>
  </svg>`;
}

// ─── Element render map ───────────────────────────────────────────────────────

type ElementId =
  | "spotlight"
  | "arrow_pointer"
  | "gesture_tap"
  | "gesture_swipe"
  | "dialog_bubble"
  | "step_indicator"
  | "highlight_ring";

function buildElementSvgs(
  element: ElementId,
  w: number,
  h: number,
  color: string
): Array<{ variant: string; svg: string }> {
  switch (element) {
    case "spotlight":
      return [{ variant: "spotlight", svg: svgSpotlight(w, h, color) }];
    case "arrow_pointer":
      return ["up", "down", "left", "right"].map((dir) => ({
        variant: `arrow_pointer_${dir}`,
        svg: svgArrowPointer(w, h, dir, color),
      }));
    case "gesture_tap":
      return [{ variant: "gesture_tap", svg: svgGestureTap(w, h, color) }];
    case "gesture_swipe":
      return ["up", "down", "left", "right"].map((dir) => ({
        variant: `gesture_swipe_${dir}`,
        svg: svgGestureSwipe(w, h, dir, color),
      }));
    case "dialog_bubble":
      return ["top", "bottom", "left", "right"].map((dir) => ({
        variant: `dialog_bubble_${dir}`,
        svg: svgDialogBubble(w, h, dir, color),
      }));
    case "step_indicator":
      return [{ variant: "step_indicator", svg: svgStepIndicator(w, h, color) }];
    case "highlight_ring":
      return [{ variant: "highlight_ring", svg: svgHighlightRing(w, h, color) }];
  }
}

export function registerTutorialTools(server: McpServer): void {
  // ── asset_generate_tutorial_overlays ──────────────────────────────────────
  server.registerTool(
    "asset_generate_tutorial_overlays",
    {
      title: "Generate Tutorial Overlay Elements",
      description: `Generate tutorial overlay UI elements as transparent-background PNGs using Sharp SVG rendering.
No AI image generation is used — all elements are created from SVG code.

Available elements:
  - spotlight:       Dark overlay with a circular transparent "hole" in the center
  - arrow_pointer:   Arrow indicators in 4 directions (up/down/left/right)
  - gesture_tap:     Circular finger-tap gesture icon
  - gesture_swipe:   Directional swipe gesture icons (4 directions)
  - dialog_bubble:   Speech/dialog bubbles with tail in 4 directions
  - step_indicator:  "1/5" style progress indicator
  - highlight_ring:  Dashed circular ring for highlighting buttons

Args:
  - elements: List of overlay element types to generate
  - canvas_width: Canvas width in pixels (default 390)
  - canvas_height: Canvas height in pixels (default 844)
  - primary_color: Primary color for icons (default "#FFFFFF")
  - output_dir: Output directory`,
      inputSchema: z.object({
        elements: z.array(z.enum([
          "spotlight",
          "arrow_pointer",
          "gesture_tap",
          "gesture_swipe",
          "dialog_bubble",
          "step_indicator",
          "highlight_ring",
        ])).min(1).describe("List of overlay element types to generate"),
        canvas_width: z.number().int().positive().default(390)
          .describe("Canvas width in pixels"),
        canvas_height: z.number().int().positive().default(844)
          .describe("Canvas height in pixels"),
        primary_color: z.string().default("#FFFFFF")
          .describe("Primary color for overlay elements (hex)"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const overlayDir = path.resolve(outputDir, "tutorial", "overlays");
        ensureDir(overlayDir);

        const w = params.canvas_width;
        const h = params.canvas_height;
        const color = params.primary_color;

        const generatedFiles: Array<{ element: string; variant: string; file_path: string }> = [];

        for (const element of params.elements) {
          const variants = buildElementSvgs(element as ElementId, w, h, color);

          for (const { variant, svg } of variants) {
            const svgBuffer = Buffer.from(svg);
            const pngBuffer = await sharp(svgBuffer)
              .png()
              .toBuffer();

            const fileName = `${variant}.png`;
            const filePath = path.join(overlayDir, fileName);
            fs.writeFileSync(filePath, pngBuffer);

            const asset: GeneratedAsset = {
              id: generateAssetId(),
              type: "image",
              asset_type: "tutorial_overlay",
              provider: "sharp_svg",
              prompt: `tutorial overlay: ${variant}`,
              file_path: filePath,
              file_name: fileName,
              mime_type: "image/png",
              created_at: new Date().toISOString(),
              metadata: {
                element,
                variant,
                canvas_width: w,
                canvas_height: h,
                primary_color: color,
              },
            };
            saveAssetToRegistry(asset, outputDir);
            generatedFiles.push({ element, variant, file_path: filePath });
          }
        }

        const output = {
          success: true,
          total_files: generatedFiles.length,
          files: generatedFiles,
          output_dir: overlayDir,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Tutorial Overlays") }],
          isError: true,
        };
      }
    }
  );

  // ── asset_generate_guide_npc ──────────────────────────────────────────────
  server.registerTool(
    "asset_generate_guide_npc",
    {
      title: "Generate Tutorial Guide NPC",
      description: `Generate a tutorial guide NPC character with multiple facial expression variants using gpt-image-1.

Processing:
  1. Generate the "idle" base expression first to establish the NPC's appearance
  2. Generate each remaining expression as a separate image
  3. Save all images and a manifest JSON listing all variants

Each image: transparent background, full-body 2D game sprite, cute cartoon style.

Args:
  - npc_description: Visual description of the NPC (appearance, clothing, personality)
  - expressions: List of expression variants to generate
  - output_dir: Output directory

Returns:
  Paths to each expression PNG and the npc_manifest.json.`,
      inputSchema: z.object({
        npc_description: z.string().min(1)
          .describe("NPC appearance description (e.g., 'a young wizard with blue robes and a pointy hat')"),
        expressions: z.array(z.enum(["idle", "happy", "thinking", "pointing", "surprised", "sad"]))
          .min(1)
          .describe("List of expression variants to generate"),
        output_dir: z.string().optional().describe("Output directory"),
      }).strict(),
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (params) => {
      try {
        const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
        const npcDir = path.resolve(outputDir, "tutorial", "npc");
        ensureDir(npcDir);

        // Ensure "idle" is generated first if it exists in the list
        const orderedExpressions = [
          ...params.expressions.filter((e) => e === "idle"),
          ...params.expressions.filter((e) => e !== "idle"),
        ];

        const generatedFiles: Array<{ expression: string; file_path: string }> = [];

        for (const expression of orderedExpressions) {
          const prompt = `${params.npc_description}, ${expression} expression, full body, transparent background, 2D game guide NPC sprite, cute cartoon style, game asset`;

          const result = await generateImageOpenAI({
            prompt,
            model: "gpt-image-1",
            size: "1024x1024",
            quality: "medium",
            background: "transparent",
          });

          const imgBuffer = Buffer.from(result.base64, "base64");
          const pngBuffer = await sharp(imgBuffer).png().toBuffer();

          const fileName = `npc_${expression}.png`;
          const filePath = path.join(npcDir, fileName);
          fs.writeFileSync(filePath, pngBuffer);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "image",
            asset_type: "tutorial_npc",
            provider: "openai",
            prompt,
            file_path: filePath,
            file_name: fileName,
            mime_type: "image/png",
            created_at: new Date().toISOString(),
            metadata: {
              expression,
              npc_description: params.npc_description,
            },
          };
          saveAssetToRegistry(asset, outputDir);
          generatedFiles.push({ expression, file_path: filePath });
        }

        const manifestPath = path.join(npcDir, "npc_manifest.json");
        const manifest = {
          npc_description: params.npc_description,
          expressions: generatedFiles,
          generated_at: new Date().toISOString(),
        };
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        const output = {
          success: true,
          npc_description: params.npc_description,
          total_expressions: generatedFiles.length,
          files: generatedFiles,
          manifest_path: manifestPath,
          output_dir: npcDir,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: handleApiError(error, "Guide NPC") }],
          isError: true,
        };
      }
    }
  );
}

// Re-export buildAssetPath to avoid "imported but never used" — it is part of
// the shared import pattern declared in the module spec.
void (buildAssetPath as unknown);
