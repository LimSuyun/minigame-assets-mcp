# minigame-assets (Claude Code Plugin)

AI 기반 게임 에셋 생성 워크플로를 Claude Code 에 원클릭으로 설치합니다.

포함된 것:

- **MCP 서버**: [`minigame-assets-mcp`](https://www.npmjs.com/package/minigame-assets-mcp) — 40+ `asset_*` 도구 (캐릭터·스프라이트·무기·배경·UI·로고·썸네일·음악·영상 생성, 품질 검토)
- **슬래시 커맨드 3종**:
  - `/create-minigame-assets` — 새 프로젝트용 전체 에셋 생성
  - `/setup-minigame-assets-concept` — 기존 게임 프로젝트 분석 + 누락 에셋 생성
  - `/minigame-assets-help` — 현재 상태 대시보드
- **자동 발동 스킬** `minigame-assets-workflow` — 에셋 생성 요청 감지 시 **CONCEPT.md 먼저** 만들도록 워크플로 강제

## 설치

```
/plugin marketplace add LimSuyun/minigame-assets-mcp
/plugin install minigame-assets@minigame-assets-mcp
```

설치 후 Claude Code 를 재시작하면 MCP 서버가 자동으로 연결됩니다 (`.mcp.json` → `npx -y minigame-assets-mcp`).

## 사전 환경변수

이미지 생성에 필요합니다.

```bash
export OPENAI_API_KEY="sk-..."       # 필수 (gpt-image-1, gpt-image-2)
export GEMINI_API_KEY="..."          # 선택 (parallax 레이어, 영상)
export ASSETS_OUTPUT_DIR="./generated-assets"   # 선택 (기본값 동일)
export CONCEPT_FILE="./game-concept.json"       # 선택
export CONCEPT_MD_FILE="./CONCEPT.md"           # 선택
```

## 사용 예시

```
(새 프로젝트) /create-minigame-assets
(기존 프로젝트) /setup-minigame-assets-concept
(상태 확인) /minigame-assets-help
```

슬래시 커맨드를 명시적으로 안 써도, "이 게임 에셋 만들어줘" 같은 요청이 오면 스킬이 자동 발동해 CONCEPT.md 를 먼저 생성한 뒤 생성 단계로 진행합니다.

## 업데이트

```
/plugin marketplace update minigame-assets-mcp
/plugin update minigame-assets
```

## 문제 해결

- **MCP 가 연결 안 됨**: `npx -y minigame-assets-mcp` 를 터미널에서 직접 실행해 에러 메시지 확인
- **이미지 생성 실패**: `OPENAI_API_KEY` 환경변수가 설정됐는지 확인
- **CONCEPT.md 가 안 만들어짐**: 스킬이 로드됐는지 `/plugin` 으로 확인하고, `asset_create_concept_md` (레거시 `_concept` 아님) 가 호출되는지 로그 확인

## 라이선스

MIT
