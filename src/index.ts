#!/usr/bin/env node
/**
 * Minigame Assets MCP Server
 *
 * Generates game assets using AI:
 * - Images: OpenAI gpt-image-2 / gpt-image-1.5 / gpt-image-1 / gpt-image-1-mini,
 *           Google Gemini Imagen 4 (generate / fast / ultra)
 * - Prompt refine: OpenAI GPT-5.4-nano (opt-in per tool via `refine_prompt`)
 * - Vision QC: Gemini 2.5 Flash (sprite frame quality checks, asset_review visual pass)
 * - Music:  Local AudioCraft / MusicGen / Stable Audio server (REST or Gradio)
 * - Video:  Google Gemini Veo 3 / Veo 2, OpenAI Sora
 *
 * Game concept management (CONCEPT.md + game-concept.json) for consistent
 * asset style across all generators.
 */


import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import express from "express";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";

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
import { registerCanonTools } from "./tools/canon.js";
import { registerDesignDocTools } from "./tools/design-doc.js";
import { registerUITools } from "./tools/ui.js";
import { registerEffectTools } from "./tools/effects.js";
import { registerCharacterExtTools } from "./tools/characters-ext.js";
import { registerEnvironmentTools } from "./tools/environment.js";
import { registerSoundExtTools } from "./tools/sound-ext.js";
import { registerMarketingExtTools } from "./tools/marketing-ext.js";
import { registerTutorialTools } from "./tools/tutorial.js";
import { registerFontTools } from "./tools/font.js";
import { registerReviewTools } from "./tools/review.js";

// ─── Server Setup ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolvePath(__dirname, "../package.json"), "utf-8")
) as { version: string };
const SERVER_VERSION = pkg.version;

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "minigame-assets-mcp-server",
    version: SERVER_VERSION,
  });

  registerConceptTools(server);
  registerWorkflowTools(server);
  registerProjectDetectorTools(server);
  registerDesignDocTools(server);
  registerCanonTools(server);
  registerImageTools(server);
  registerSpriteTools(server);
  registerUITools(server);
  registerEditTools(server);
  registerLogoTools(server);
  registerMusicTools(server);
  registerVideoTools(server);
  registerAssetUtilTools(server);
  registerThumbnailTools(server);
  registerEffectTools(server);
  registerCharacterExtTools(server);
  registerEnvironmentTools(server);
  registerSoundExtTools(server);
  registerMarketingExtTools(server);
  registerTutorialTools(server);
  registerFontTools(server);
  registerReviewTools(server);

  return server;
}

// ─── Transport ────────────────────────────────────────────────────────────────

async function runStdio(): Promise<void> {
  const transport = new StdioServerTransport();
  const server = createMcpServer();
  await server.connect(transport);
  console.error(`[minigame-assets-mcp v${SERVER_VERSION}] Running via stdio`);
}

async function runHTTP(): Promise<void> {
  const app = express();
  app.use(express.json({ limit: "50mb" }));

  // Stateful 세션 관리: 세션 ID → transport. initialize 요청이 오면 새 세션을
  // 만들고, 후속 요청은 mcp-session-id 헤더로 같은 transport에 라우팅한다.
  // 각 세션은 독립된 McpServer 인스턴스를 가지며 세션 종료 시 함께 정리된다.
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  async function routeRequest(req: express.Request, res: express.Response): Promise<void> {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    let transport = sessionId ? sessions.get(sessionId) : undefined;

    if (!transport) {
      if (req.method !== "POST") {
        res.status(400).json({
          jsonrpc: "2.0",
          error: { code: -32000, message: "Missing or unknown mcp-session-id" },
          id: null,
        });
        return;
      }

      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (id: string) => {
          sessions.set(id, transport!);
        },
      });
      transport.onclose = () => {
        const id = transport!.sessionId;
        if (id) sessions.delete(id);
      };
      const server = createMcpServer();
      await server.connect(transport);
    }

    await transport.handleRequest(req, res, req.body);
  }

  app.post("/mcp", routeRequest);
  app.get("/mcp", routeRequest);     // SSE stream resume
  app.delete("/mcp", routeRequest);  // session termination

  app.get("/health", (_req, res) => {
    res.json({
      status: "ok",
      server: "minigame-assets-mcp-server",
      version: SERVER_VERSION,
      active_sessions: sessions.size,
    });
  });

  const port = parseInt(process.env.PORT || "3456");
  app.listen(port, () => {
    console.error(`[minigame-assets-mcp v${SERVER_VERSION}] Running on http://localhost:${port}/mcp`);
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
