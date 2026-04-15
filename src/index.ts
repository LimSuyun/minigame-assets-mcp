#!/usr/bin/env node
/**
 * Minigame Assets MCP Server
 *
 * Generates game assets using AI:
 * - Images: OpenAI DALL-E 3, Google Gemini Imagen 3
 * - Music:  Local model server (AudioCraft/MusicGen), Google Gemini Lyria
 * - Video:  Google Gemini Veo 2, OpenAI Sora
 *
 * Game concept management for consistent asset style across all generators.
 */


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";

import { registerConceptTools } from "./tools/concept.js";
import { registerImageTools } from "./tools/image.js";
import { registerMusicTools } from "./tools/music.js";
import { registerVideoTools } from "./tools/video.js";
import { registerSpriteTools } from "./tools/sprite.js";
import { registerProjectDetectorTools } from "./tools/project-detector.js";
import { registerEditTools } from "./tools/edit.js";
import { registerLogoTools } from "./tools/logo.js";
import { registerWorkflowTools } from "./tools/workflow.js";
import { registerAssetUtilTools } from "./tools/asset-utils.js";
import { registerThumbnailTools } from "./tools/thumbnail.js";

// ─── Server Setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "minigame-assets-mcp-server",
  version: "1.0.0",
});

// Register all tool groups
registerConceptTools(server);
registerWorkflowTools(server);
registerProjectDetectorTools(server);
registerImageTools(server);
registerSpriteTools(server);
registerEditTools(server);
registerLogoTools(server);
registerMusicTools(server);
registerVideoTools(server);
registerAssetUtilTools(server);
registerThumbnailTools(server);

// ─── Transport ────────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[minigame-assets-mcp] Running via stdio");
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  app.post("/mcp", async (req, res) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on("close", () => transport.close());
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/health", (_req, res) => {
    res.json({ status: "ok", server: "minigame-assets-mcp-server", version: "1.0.0" });
  });

  const port = parseInt(process.env.PORT || "3456");
  app.listen(port, () => {
    console.error(`[minigame-assets-mcp] Running on http://localhost:${port}/mcp`);
  });
}

// ─── Entry Point ──────────────────────────────────────────────────────────────

const transport = process.env.TRANSPORT || "stdio";

if (transport === "http") {
  runHTTP().catch((error: unknown) => {
    console.error("[minigame-assets-mcp] Server error:", error);
    process.exit(1);
  });
} else {
  runStdio().catch((error: unknown) => {
    console.error("[minigame-assets-mcp] Server error:", error);
    process.exit(1);
  });
}
