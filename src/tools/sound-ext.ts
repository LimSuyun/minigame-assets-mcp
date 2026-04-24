import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR, LOCAL_MUSIC_URL } from "../constants.js";
import { buildAssetPath, saveAssetToRegistry, generateAssetId, ensureDir } from "../utils/files.js";
import { handleApiError } from "../utils/errors.js";
import type { GeneratedAsset } from "../types.js";

// ─── Default SFX lists per category ──────────────────────────────────────────

const DEFAULT_SFX: Record<string, Array<{ id: string; description: string; duration_ms: number }>> = {
  ui: [
    { id: "btn_click",    description: "button click sound, short crisp click",               duration_ms: 200  },
    { id: "btn_hover",    description: "button hover sound, soft swoosh",                     duration_ms: 150  },
    { id: "popup_open",   description: "popup window open sound, soft whoosh up",             duration_ms: 300  },
    { id: "popup_close",  description: "popup window close sound, soft whoosh down",          duration_ms: 300  },
    { id: "success",      description: "success confirmation sound, cheerful ding",            duration_ms: 500  },
    { id: "error",        description: "error sound, low buzz or wrong-answer tone",          duration_ms: 400  },
  ],
  character: [
    { id: "jump",         description: "character jump sound, springy bounce",                duration_ms: 350  },
    { id: "land",         description: "character landing sound, soft thud",                  duration_ms: 300  },
    { id: "attack_swing", description: "attack swing sound, whoosh slash",                   duration_ms: 400  },
    { id: "hurt",         description: "character hurt sound, short grunt",                   duration_ms: 400  },
    { id: "die",          description: "character death sound, descending tone",              duration_ms: 700  },
  ],
  environment: [
    { id: "coin_collect", description: "coin collect sound, bright ding ping",               duration_ms: 400  },
    { id: "chest_open",   description: "treasure chest opening sound, creak and sparkle",    duration_ms: 600  },
    { id: "checkpoint",   description: "checkpoint activation sound, ascending chime",       duration_ms: 500  },
  ],
  combat: [
    { id: "sword_clash",  description: "sword clashing sound, metallic clang",               duration_ms: 500  },
    { id: "explosion_sm", description: "small explosion sound, short boom",                  duration_ms: 600  },
    { id: "magic_cast",   description: "magic spell casting sound, mystical shimmer",        duration_ms: 700  },
  ],
  reward: [
    { id: "level_up",     description: "level up fanfare sound, ascending triumphant tones", duration_ms: 1500 },
    { id: "achievement",  description: "achievement unlocked sound, bright sparkle fanfare", duration_ms: 1200 },
    { id: "stage_clear",  description: "stage clear jingle, short victorious melody",        duration_ms: 2000 },
  ],
};

export function registerSoundExtTools(server: McpServer): void {
  // ── asset_generate_bgm ────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_bgm",
    {
      title: "Generate Game BGM",
      description: `Generate background music for a specific game screen using a local MusicGen server.

Calls POST {LOCAL_MUSIC_SERVER_URL}/generate with a descriptive prompt derived from
screen_type and mood. Saves the resulting audio file and a companion metadata JSON.

Args:
  - track_id: Unique identifier for the track (used as file basename)
  - screen_type: Game screen this track belongs to
  - mood: Emotional tone of the music
  - duration_sec: Length of the track in seconds (30-120, default 60)
  - loop_point_sec: Optional loop start point in seconds
  - style_description: Optional additional style description for the prompt
  - output_dir: Output directory (default: ASSETS_OUTPUT_DIR env or ./.minigame-assets)

Returns:
  Paths to the generated audio file and its metadata JSON.`,
      inputSchema: z.object({
        track_id: z.string().min(1).describe("Unique track identifier (used as filename base)"),
        screen_type: z.union([
          z.enum(["main_menu", "gameplay", "boss", "victory", "defeat", "shop", "cutscene"]),
          z.string(),
        ]).describe("Game screen this track is for"),
        mood: z.enum(["cheerful", "tense", "peaceful", "epic", "sad", "mysterious"])
          .describe("Emotional mood of the music"),
        duration_sec: z.number().int().min(30).max(120).default(60)
          .describe("Duration in seconds (30-120)"),
        loop_point_sec: z.number().optional().describe("Loop start point in seconds"),
        style_description: z.string().optional().describe("Additional style description"),
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
        const audioDir = path.resolve(outputDir, "music");
        ensureDir(audioDir);

        const prompt = `${params.style_description || params.mood} background music for ${params.screen_type}, ${params.duration_sec} seconds`;

        let audioBuffer: Buffer;
        let ext = "mp3";

        const resp = await fetch(`${LOCAL_MUSIC_URL}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            prompt,
            duration: params.duration_sec,
          }),
        });

        if (!resp.ok) {
          const errText = await resp.text().catch(() => resp.statusText);
          throw new Error(`MusicGen server returned ${resp.status}: ${errText}\n로컬 MusicGen 서버가 실행 중인지 확인하세요: ${LOCAL_MUSIC_URL}`);
        }

        const data = await resp.json() as {
          audio_url?: string;
          audio_data?: string;
          mime_type?: string;
          duration?: number;
          error?: string;
        };

        if (data.error) {
          throw new Error(`MusicGen server error: ${data.error}\n로컬 MusicGen 서버가 실행 중인지 확인하세요: ${LOCAL_MUSIC_URL}`);
        }

        if (data.mime_type) {
          ext = data.mime_type.includes("mp3") ? "mp3" : "wav";
        }

        if (data.audio_data) {
          audioBuffer = Buffer.from(data.audio_data, "base64");
        } else if (data.audio_url) {
          const audioResp = await fetch(data.audio_url);
          if (!audioResp.ok) throw new Error(`Failed to download audio from ${data.audio_url}`);
          audioBuffer = Buffer.from(await audioResp.arrayBuffer());
          const ct = audioResp.headers.get("content-type") || "";
          ext = ct.includes("mp3") ? "mp3" : "wav";
        } else {
          throw new Error("MusicGen server returned no audio data or URL");
        }

        const audioFileName = `${params.track_id}.${ext}`;
        const metaFileName = `${params.track_id}_metadata.json`;
        const audioFilePath = path.join(audioDir, audioFileName);
        const metaFilePath = path.join(audioDir, metaFileName);

        fs.writeFileSync(audioFilePath, audioBuffer);

        const bpmHints: Record<string, number> = {
          cheerful: 128, tense: 140, peaceful: 80, epic: 100, sad: 70, mysterious: 90,
        };

        const metadata = {
          track_id: params.track_id,
          screen_type: params.screen_type,
          mood: params.mood,
          duration_sec: params.duration_sec,
          loop_point_sec: params.loop_point_sec ?? null,
          bpm_hint: bpmHints[params.mood] ?? 100,
        };

        fs.writeFileSync(metaFilePath, JSON.stringify(metadata, null, 2));

        const asset: GeneratedAsset = {
          id: generateAssetId(),
          type: "music",
          asset_type: "bgm",
          provider: "local_musicgen",
          prompt,
          file_path: audioFilePath,
          file_name: audioFileName,
          mime_type: `audio/${ext}`,
          created_at: new Date().toISOString(),
          metadata: {
            track_id: params.track_id,
            screen_type: params.screen_type,
            mood: params.mood,
            duration_sec: params.duration_sec,
            loop_point_sec: params.loop_point_sec ?? null,
            meta_file_path: metaFilePath,
          },
        };

        saveAssetToRegistry(asset, outputDir);

        const output = {
          success: true,
          track_id: params.track_id,
          audio_file_path: audioFilePath,
          metadata_file_path: metaFilePath,
          asset_id: asset.id,
          duration_sec: params.duration_sec,
          mood: params.mood,
          screen_type: params.screen_type,
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) }],
          structuredContent: output,
        };
      } catch (error) {
        const errMsg = error instanceof Error && error.message.includes("로컬 MusicGen")
          ? error.message
          : `${handleApiError(error, "Local MusicGen Server")}\n로컬 MusicGen 서버가 실행 중인지 확인하세요: ${LOCAL_MUSIC_URL}`;
        return {
          content: [{ type: "text" as const, text: errMsg }],
          isError: true,
        };
      }
    }
  );

  // ── asset_generate_sfx ────────────────────────────────────────────────────
  server.registerTool(
    "asset_generate_sfx",
    {
      title: "Generate Game SFX Set",
      description: `Generate a set of sound effects for a specific game category using a local AudioGen server.

Calls POST {LOCAL_MUSIC_SERVER_URL}/generate_sfx for each sound effect.
If sfx_list is omitted, uses a built-in default set for the given category.
Saves each SFX file and a manifest JSON listing all generated files.

Built-in categories and their default SFX:
  - ui: btn_click, btn_hover, popup_open, popup_close, success, error
  - character: jump, land, attack_swing, hurt, die
  - environment: coin_collect, chest_open, checkpoint
  - combat: sword_clash, explosion_sm, magic_cast
  - reward: level_up, achievement, stage_clear

Args:
  - sfx_category: Category of sound effects
  - sfx_list: Optional custom list of SFX to generate (overrides defaults)
  - output_dir: Output directory

Returns:
  Paths to each generated SFX file and the manifest JSON.`,
      inputSchema: z.object({
        sfx_category: z.enum(["ui", "character", "environment", "combat", "reward"])
          .describe("Category of sound effects"),
        sfx_list: z.array(z.object({
          id: z.string().describe("SFX identifier"),
          description: z.string().describe("Description of the sound"),
          duration_ms: z.number().int().optional().describe("Duration in milliseconds"),
        })).optional().describe("Custom SFX list (uses category defaults if omitted)"),
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
      const outputDir = params.output_dir || DEFAULT_OUTPUT_DIR;
      const sfxDir = path.resolve(outputDir, "sfx", params.sfx_category);
      ensureDir(sfxDir);

      const sfxList = params.sfx_list ?? DEFAULT_SFX[params.sfx_category] ?? [];

      const results: Array<{ id: string; file_path: string | null; duration_ms: number; error?: string }> = [];
      let serverAvailable = true;

      for (const sfx of sfxList) {
        if (!serverAvailable) {
          results.push({ id: sfx.id, file_path: null, duration_ms: sfx.duration_ms ?? 500, error: "Server unavailable" });
          continue;
        }

        try {
          const resp = await fetch(`${LOCAL_MUSIC_URL}/generate_sfx`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              prompt: sfx.description,
              duration_ms: sfx.duration_ms ?? 500,
            }),
          });

          if (!resp.ok) {
            serverAvailable = false;
            results.push({ id: sfx.id, file_path: null, duration_ms: sfx.duration_ms ?? 500, error: `Server ${resp.status}` });
            continue;
          }

          const data = await resp.json() as {
            audio_url?: string;
            audio_data?: string;
            mime_type?: string;
            error?: string;
          };

          if (data.error) {
            results.push({ id: sfx.id, file_path: null, duration_ms: sfx.duration_ms ?? 500, error: data.error });
            continue;
          }

          let audioBuffer: Buffer;
          let ext = "wav";

          if (data.mime_type) ext = data.mime_type.includes("mp3") ? "mp3" : "wav";

          if (data.audio_data) {
            audioBuffer = Buffer.from(data.audio_data, "base64");
          } else if (data.audio_url) {
            const audioResp = await fetch(data.audio_url);
            audioBuffer = Buffer.from(await audioResp.arrayBuffer());
          } else {
            results.push({ id: sfx.id, file_path: null, duration_ms: sfx.duration_ms ?? 500, error: "No audio data returned" });
            continue;
          }

          const fileName = `${sfx.id}.${ext}`;
          const filePath = path.join(sfxDir, fileName);
          fs.writeFileSync(filePath, audioBuffer);

          const asset: GeneratedAsset = {
            id: generateAssetId(),
            type: "music",
            asset_type: "sfx",
            provider: "local_audiogen",
            prompt: sfx.description,
            file_path: filePath,
            file_name: fileName,
            mime_type: `audio/${ext}`,
            created_at: new Date().toISOString(),
            metadata: {
              sfx_id: sfx.id,
              category: params.sfx_category,
              duration_ms: sfx.duration_ms ?? 500,
            },
          };

          saveAssetToRegistry(asset, outputDir);
          results.push({ id: sfx.id, file_path: filePath, duration_ms: sfx.duration_ms ?? 500 });
        } catch (err) {
          serverAvailable = false;
          results.push({ id: sfx.id, file_path: null, duration_ms: sfx.duration_ms ?? 500, error: String(err) });
        }
      }

      const manifestPath = path.join(sfxDir, "sfx_manifest.json");
      const manifest = {
        category: params.sfx_category,
        sfx: results.map((r) => ({
          id: r.id,
          file_path: r.file_path,
          duration_ms: r.duration_ms,
          ...(r.error ? { error: r.error } : {}),
        })),
        generated_at: new Date().toISOString(),
      };
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      const successCount = results.filter((r) => r.file_path !== null).length;
      const serverNote = !serverAvailable
        ? `\n\n로컬 AudioGen 서버가 실행 중인지 확인하세요: ${LOCAL_MUSIC_URL}`
        : "";

      const output = {
        success: successCount > 0 || sfxList.length === 0,
        category: params.sfx_category,
        total: sfxList.length,
        generated: successCount,
        failed: sfxList.length - successCount,
        manifest_path: manifestPath,
        sfx_list: results,
        server_available: serverAvailable,
        note: serverAvailable ? undefined : `로컬 AudioGen 서버가 실행 중인지 확인하세요: ${LOCAL_MUSIC_URL}`,
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(output, null, 2) + serverNote }],
        structuredContent: output,
      };
    }
  );
}
