/**
 * title-text.ts (tools) — 게임 타이틀 워드마크 PNG 단독 생성 도구
 *
 * `ensureTitleTextImage` 공통 유틸을 MCP 도구로 노출한다.
 * 한 번 만들어 두면 로고/썸네일/로딩 화면 등 여러 도구에서 `title_text_image_path`
 * 로 참조 재사용할 수 있다 — 비용 절감 + 워드마크 일관성 보장.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as path from "path";
import { DEFAULT_OUTPUT_DIR } from "../constants.js";
import { ensureTitleTextImage, TITLE_TEXT_SUBDIR } from "../utils/title-text.js";
import { resolveRegistryRoot } from "../utils/registry-root.js";
import { handleApiError } from "../utils/errors.js";

export function registerTitleTextTools(server: McpServer): void {
  server.registerTool(
    "asset_generate_title_text",
    {
      title: "Generate Title Wordmark PNG (transparent)",
      description: `게임 타이틀(워드마크) 만 담긴 투명 배경 PNG 1장을 생성합니다 (gpt-image-2 + 마젠타 크로마키).

**용도**:
- 로고(\`asset_generate_app_logo\`), 썸네일(\`asset_generate_thumbnail\`), 그리고 로딩/로비/스토어 마케팅 도구의 합성 입력으로 재사용
- 한 번 만들어 두고 \`title_text_image_path\` 로 모든 마케팅 산출물에 같은 워드마크를 사용 → 일관성 + 비용 절감

**파이프라인**:
1. gpt-image-2 generation: 마젠타(#FF00FF) 단색 배경 + 게임명 워드마크
2. \`removeBackground\` 크로마키 제거 → 투명 1024×1024 PNG
3. \`.minigame-assets/title_text/<safe_name>_title_text_<date>.png\` 저장
4. registry 에 \`asset_type: "title_text", reusable: true\` 로 등록

Args:
  - game_name: 게임 이름 (텍스트 정확히 렌더)
  - art_style: 아트 스타일 (타이포 톤 추론용)
  - theme: 게임 테마 (브랜드 색 추론용)
  - brand_color: 워드마크 색상 (hex 또는 색명, 미지정 시 자동 추론)
  - custom_prompt: 추가 프롬프트 지시 (선택)
  - output_dir: 프로젝트 루트 또는 임의 sub-dir (기본 \`.minigame-assets/\`). registry 는 항상 프로젝트 루트에 통합.

Returns:
  생성된 워드마크 PNG 경로 (\`title_text_path\`).`,
      inputSchema: z.object({
        game_name: z.string().min(1).max(100).describe("게임 이름"),
        name_slug: z.string().min(1).max(60).optional()
          .describe("ASCII 영문 슬러그 (파일명용). 한글 게임명일 때 권장"),
        art_style: z.string().min(1).max(200).describe("아트 스타일"),
        theme: z.string().min(1).max(200).describe("게임 테마"),
        brand_color: z.string().max(80).optional()
          .describe("워드마크 색상 (hex 또는 색명). 미지정 시 theme/art_style로부터 자동 추론"),
        custom_prompt: z.string().max(500).optional()
          .describe("추가 프롬프트 지시"),
        output_dir: z.string().optional()
          .describe("출력 루트. 기본 .minigame-assets/. 워드마크는 형제 폴더 title_text/에 저장"),
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
        const root = resolveRegistryRoot(params.output_dir || DEFAULT_OUTPUT_DIR);
        const titleTextDir = path.resolve(root, TITLE_TEXT_SUBDIR);

        const result = await ensureTitleTextImage({
          game_name: params.game_name,
          name_slug: params.name_slug,
          brand_color: params.brand_color,
          art_style: params.art_style,
          theme: params.theme,
          custom_prompt: params.custom_prompt,
          titleTextDir,
          registryDir: root,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              success: true,
              title_text_path: result.path,
              reused: result.reused,
              brand_color: params.brand_color ?? "inferred",
              size: "1024x1024",
              registry_root: root,
              hint: "title_text_path를 다른 마케팅 도구의 title_text_image_path 입력으로 전달해 재사용하세요.",
            }, null, 2),
          }],
        };
      } catch (err) {
        return {
          content: [{
            type: "text" as const,
            text: handleApiError(err, "title text"),
          }],
        };
      }
    },
  );
}
