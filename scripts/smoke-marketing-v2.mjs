#!/usr/bin/env node
// Smoke test for marketing v2 + sora-2 video generation.
// Outputs land in test-output/smoke/<run-id>/

import * as fs from "node:fs";
import * as path from "node:path";
import sharp from "sharp";

import {
  extendPlateToAspect,
  compositeKeyVisualWithShadow,
  compositeLogoCorner,
  applyVignette,
} from "../dist/tools/marketing-ext.js";
import { generateImageOpenAI } from "../dist/services/openai.js";

const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const OUT = path.resolve("test-output/smoke", RUN_ID);
fs.mkdirSync(OUT, { recursive: true });
console.log(`[smoke] output dir: ${OUT}`);

// ─── helper: log lines ───────────────────────────────────────────────────────
function log(label, obj) {
  console.log(`\n── ${label} ──`);
  if (obj !== undefined) console.log(JSON.stringify(obj, null, 2));
}

// ─── make a dummy "key visual" — stylized portrait silhouette PNG ────────────
async function makeDummyKeyVisual(p) {
  const w = 600, h = 900;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <defs>
      <radialGradient id="g" cx="50%" cy="40%" r="40%"><stop offset="0%" stop-color="#fbbf24" stop-opacity="1"/><stop offset="100%" stop-color="#7c3aed" stop-opacity="1"/></radialGradient>
    </defs>
    <ellipse cx="${w/2}" cy="${h*0.3}" rx="120" ry="140" fill="url(#g)"/>
    <rect x="${w/2-150}" y="${h*0.45}" width="300" height="380" rx="40" fill="url(#g)"/>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(p);
}

// ─── make a dummy logo — small square mark with transparency ─────────────────
async function makeDummyLogo(p) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200">
    <circle cx="100" cy="100" r="90" fill="#0ea5e9" stroke="white" stroke-width="6"/>
    <text x="100" y="125" font-family="Arial" font-size="60" font-weight="bold" fill="white" text-anchor="middle">L</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(p);
}

// ─── make a dummy gameplay capture — 1080×1920 with grid ─────────────────────
async function makeDummyCapture(p) {
  const w = 1080, h = 1920;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">
    <rect width="100%" height="100%" fill="#1e3a8a"/>
    <g stroke="#3b82f6" stroke-width="2" opacity="0.6">
      ${Array.from({length: 20}, (_, i) => `<line x1="0" y1="${i*100}" x2="${w}" y2="${i*100}"/>`).join("")}
      ${Array.from({length: 12}, (_, i) => `<line x1="${i*100}" y1="0" x2="${i*100}" y2="${h}"/>`).join("")}
    </g>
    <text x="${w/2}" y="${h/2}" font-family="Arial" font-size="60" font-weight="bold" fill="white" text-anchor="middle">DUMMY GAMEPLAY</text>
    <rect x="40" y="40" width="200" height="60" rx="8" fill="rgba(0,0,0,0.5)"/>
    <text x="60" y="80" font-family="monospace" font-size="32" fill="#fbbf24">SCORE: 1234</text>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(p);
}

// ─── 1. social_media_pack v2 smoke ───────────────────────────────────────────
async function smokeSocial() {
  log("social_media_pack v2");

  const kvPath = path.join(OUT, "_input_keyvisual.png");
  const logoPath = path.join(OUT, "_input_logo.png");
  await makeDummyKeyVisual(kvPath);
  await makeDummyLogo(logoPath);

  // Step 1: AI plate (gpt-image-2, 1024x1024)
  console.log("[social] requesting gpt-image-2 plate ...");
  const t0 = Date.now();
  const plateRes = await generateImageOpenAI({
    prompt:
      "vibrant cinematic game art marketing atmosphere plate for Smoke Test mobile game, " +
      "game launch announcement atmosphere, painterly background with depth and lighting, " +
      "composition with breathing room in the center for a character to be composited later, " +
      "NO characters, NO mascots, NO logos, NO text, NO UI elements, high quality, opaque background",
    model: "gpt-image-2",
    size: "1024x1024",
    quality: "high",
    background: "opaque",
  });
  const plateMs = Date.now() - t0;
  console.log(`[social] plate received in ${plateMs}ms`);

  const plateBuffer = Buffer.from(plateRes.base64, "base64");
  await fs.promises.writeFile(path.join(OUT, "social_00_plate_raw.png"), plateBuffer);

  const kvBuffer = await fs.promises.readFile(kvPath);
  const logoBuffer = await fs.promises.readFile(logoPath);

  const specs = [
    { id: "instagram_post",  w: 1080, h: 1080, anchor: "center",     ratio: 0.75, corner: "br" },
    { id: "instagram_story", w: 1080, h: 1920, anchor: "center",     ratio: 0.62, corner: "br" },
    { id: "twitter_banner",  w: 1200, h: 675,  anchor: "left-third", ratio: 0.85, corner: "tl" },
    { id: "facebook_post",   w: 1200, h: 630,  anchor: "left-third", ratio: 0.85, corner: "tl" },
  ];

  for (const s of specs) {
    let canvas = await extendPlateToAspect(plateBuffer, s.w, s.h);
    canvas = await compositeKeyVisualWithShadow(canvas, kvBuffer, s.w, s.h, s.anchor, s.ratio);
    canvas = await compositeLogoCorner(canvas, logoBuffer, s.w, s.h, s.corner);
    canvas = await applyVignette(canvas, s.w, s.h);
    const outPath = path.join(OUT, `social_${s.id}.png`);
    await sharp(canvas).png().toFile(outPath);
    const stat = fs.statSync(outPath);
    console.log(`[social] wrote ${path.basename(outPath)} (${(stat.size/1024).toFixed(1)} KB)`);
  }
  console.log("[social] OK");
}

// ─── 2. store_screenshots smoke ──────────────────────────────────────────────
async function smokeScreenshots() {
  log("store_screenshots");

  const capPath = path.join(OUT, "_input_capture.png");
  await makeDummyCapture(capPath);

  // Mimic the tool body without going through MCP server.
  const platforms = [
    { key: "ios",     w: 1290, h: 2796 },
    { key: "android", w: 1080, h: 1920 },
  ];
  const caption = "보스 처치!";
  const fontSize = Math.round(1080 * 0.04);
  const padding = 30;
  const boxHeight = fontSize + padding * 2;
  const captionSvg = (w) => Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${boxHeight}">
       <rect x="0" y="0" width="${w}" height="${boxHeight}" fill="rgba(0,0,0,0.55)"/>
       <text x="${w/2}" y="${fontSize + padding - 8}" font-family="Arial, sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle">${caption}</text>
     </svg>`
  );

  for (const p of platforms) {
    const resized = await sharp(capPath).resize(p.w, p.h, { fit: "cover" }).toBuffer();
    const final = await sharp(resized)
      .composite([{ input: captionSvg(p.w), top: 0, left: 0 }])
      .png()
      .toBuffer();
    const outPath = path.join(OUT, `screenshot_${p.key}.png`);
    await fs.promises.writeFile(outPath, final);
    const stat = fs.statSync(outPath);
    console.log(`[screenshots] wrote ${path.basename(outPath)} (${(stat.size/1024).toFixed(1)} KB)`);
  }
  console.log("[screenshots] OK");
}

// ─── main ────────────────────────────────────────────────────────────────────
const STEP = process.argv[2] ?? "all";
try {
  if (STEP === "all" || STEP === "social")      await smokeSocial();
  if (STEP === "all" || STEP === "screenshots") await smokeScreenshots();
  console.log(`\n[smoke] DONE — check ${OUT}`);
} catch (e) {
  console.error(`\n[smoke] aborted: ${e?.message ?? e}`);
  process.exit(1);
}
