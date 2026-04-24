# minigame-assets (Claude Code Plugin)

AI 기반 게임 에셋 생성 워크플로를 Claude Code 에 원클릭으로 설치합니다.

포함된 것:

- **MCP 서버**: [`minigame-assets-mcp`](https://www.npmjs.com/package/minigame-assets-mcp) — 40+ `asset_*` 도구 (캐릭터·스프라이트·무기·배경·UI·로고·썸네일·음악·영상 생성, 품질 검토)
- **슬래시 커맨드 3종**:
  - `/create-minigame-assets` — 새 프로젝트용 전체 에셋 생성
  - `/setup-minigame-assets-concept` — 기존 게임 프로젝트 분석 + 누락 에셋 생성
  - `/minigame-assets-help` — 현재 상태 대시보드
- **자동 발동 스킬 7종** — 상황별로 독립 트리거, 필요할 때만 컨텍스트에 로드되어 효율적:
  - `minigame-assets-workflow` — 에셋 생성 전체 파이프라인 (CONCEPT-first 강제)
  - `minigame-assets-status` — "지금 뭐 해야 해?" 같은 진행 상황 질문에 대시보드 응답
  - `minigame-assets-optimize` — 용량·포맷·디스플레이 크기 최적화
  - `minigame-assets-review` — 품질 검토 + 크로마 잔류 + 스펙 검증
  - `minigame-assets-style-consistency` — Canon 시스템 + 스타일 드리프트 방지
  - `minigame-assets-engine-load` — Phaser/Unity/Cocos/Godot 로딩 코드
  - `minigame-assets-cost` — 모델별 단가 + 비용 절감 전략

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
export ASSETS_OUTPUT_DIR="./.minigame-assets"                     # 선택 (기본값 동일)
export CONCEPT_FILE="./.minigame-assets/game-concept.json"        # 선택
export CONCEPT_MD_FILE="./.minigame-assets/CONCEPT.md"            # 선택
```

> **보안 강화** — 셸 rc 파일에 키를 평문으로 두는 대신 macOS Keychain / Linux libsecret 같은 OS 시크릿 저장소에 두고 주입하는 방식이 가능합니다. 설정 방법은 루트 README의 [방법 3 — OS 시크릿 저장소](../../README.md#방법-3--os-시크릿-저장소-보안-강화) 참고. 플러그인 설치와 병행 가능.

## 사용 예시

```
(새 프로젝트) /create-minigame-assets
(기존 프로젝트) /setup-minigame-assets-concept
(상태 확인) /minigame-assets-help
```

슬래시 커맨드를 명시적으로 안 써도, "이 게임 에셋 만들어줘" 같은 요청이 오면 스킬이 자동 발동해 CONCEPT.md 를 먼저 생성한 뒤 생성 단계로 진행합니다.

## 업데이트 (자동)

한 번 설치해 두면 두 경로 모두 자동으로 최신을 따라갑니다.

- **MCP 서버 코드** — `.mcp.json` 이 `npx -y minigame-assets-mcp@latest` 로 `@latest` 고정이므로, 새 npm 버전이 올라오면 **다음 Claude Code 재시작 때 자동 반영**됩니다.
- **슬래시 커맨드 / 스킬 / manifest** — SessionStart 훅이 6시간에 한 번 백그라운드로 `claude plugin marketplace update` + `claude plugin update` 를 실행해 git 의 최신 커밋을 가져옵니다. 업데이트 자체는 조용히 적용되고, 다음 세션부터 새 버전이 활성화됩니다.

### 수동 업데이트

즉시 반영하고 싶으면:

```
/plugin marketplace update minigame-assets-mcp
/plugin update minigame-assets
```

### 자동 업데이트 끄기

쉘 환경변수로 opt-out:

```bash
export MINIGAME_ASSETS_AUTO_UPDATE=0
```

## 문제 해결

- **MCP 가 연결 안 됨**: `npx -y minigame-assets-mcp` 를 터미널에서 직접 실행해 에러 메시지 확인
- **이미지 생성 실패**: `OPENAI_API_KEY` 환경변수가 설정됐는지 확인
- **CONCEPT.md 가 안 만들어짐**: 스킬이 로드됐는지 `/plugin` 으로 확인하고, `asset_create_concept_md` (레거시 `_concept` 아님) 가 호출되는지 로그 확인

## 라이선스

MIT
