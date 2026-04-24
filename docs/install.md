# 설치

세 가지 방식 중 **하나**를 선택하세요. 대부분의 경우 **방법 1**이 가장 단순합니다.

| 방식 | 장점 | 단점 |
|---|---|---|
| **방법 1 — MCP 서버 수동 등록** | 키가 `~/.claude.json`에 저장되어 Claude Code를 어떻게 띄워도 작동. 한 줄로 끝 | 슬래시 커맨드·스킬·자동 업데이트 없음 |
| **방법 2 — Claude Code 플러그인** | MCP + 슬래시 커맨드 3종 + CONCEPT-first 스킬 + 자동 업데이트 | API 키를 셸 env로 관리. macOS GUI 실행 시 `launchctl setenv` 별도 필요 |
| **방법 3 — OS 시크릿 저장소** | 키를 평문으로 두지 않음 (macOS Keychain / Linux libsecret) | 설정 한 단계 추가. Windows는 별도 툴 필요 |

방법 3은 방법 1·2와 병행 가능 — 키 주입 경로만 대체합니다.

---

## 방법 1 — MCP 서버 수동 등록

```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -- npx -y minigame-assets-mcp@latest
```

- `--scope user`: 모든 프로젝트에서 사용 가능
- `-e KEY=VALUE`: API 키를 MCP 서버 프로세스 env로 주입

확인:
```bash
claude mcp list
# minigame-assets: npx -y minigame-assets-mcp@latest - ✓ Connected
```

재설치/키 갱신:
```bash
claude mcp remove minigame-assets
# 위 add 명령 다시 실행
```

---

## 방법 2 — Claude Code 플러그인

**① 플러그인 설치**

```
/plugin marketplace add LimSuyun/minigame-assets-mcp
/plugin install minigame-assets@minigame-assets-mcp
```

설치되는 것:
- **MCP 서버** `minigame-assets` — `npx -y minigame-assets-mcp@latest` 자동 실행
- **슬래시 커맨드**: `/create-minigame-assets`, `/setup-minigame-assets-concept`, `/minigame-assets-help`
- **자동 발동 스킬** `minigame-assets-workflow` — 에셋 생성 요청 감지 시 CONCEPT.md 먼저 생성
- **SessionStart 훅** — 6시간마다 백그라운드로 플러그인 최신 커밋 동기화

**② API 키를 셸 환경변수로**

zsh (macOS 기본):
```bash
# ~/.zshrc 에 추가
export OPENAI_API_KEY="sk-..."
```
적용: `source ~/.zshrc`

bash: 위 내용을 `~/.bashrc` 또는 `~/.bash_profile` 에.

**③ 확인**

Claude Code 재시작 후:
```bash
claude mcp list     # minigame-assets: ✓ Connected
```

**⚠️ macOS GUI 실행 시** — Finder/Dock 아이콘으로 Claude Code를 띄우면 `~/.zshrc`의 export가 상속되지 않습니다:
```bash
launchctl setenv OPENAI_API_KEY "sk-..."
```
재부팅마다 재설정. 영구 유지하려면 `~/Library/LaunchAgents/`에 plist 배치.

---

## 방법 3 — OS 시크릿 저장소

### macOS — Keychain

**① 키를 Keychain에 등록**
```bash
security add-generic-password -a "$USER" -s claude-code-openai-api-key -w "sk-..." -U
```

**② MCP 엔트리를 Keychain 주입 래퍼로**

```bash
claude mcp remove minigame-assets --scope user
```

`~/.claude.json`에서 `mcpServers.minigame-assets`를 직접 이렇게 작성:
```json
{
  "mcpServers": {
    "minigame-assets": {
      "type": "stdio",
      "command": "sh",
      "args": [
        "-c",
        "exec env OPENAI_API_KEY=\"$(security find-generic-password -a \"$USER\" -s claude-code-openai-api-key -w 2>/dev/null)\" npx -y minigame-assets-mcp@latest"
      ]
    }
  }
}
```

첫 실행 시 Keychain 접근 승인 프롬프트가 뜹니다. "항상 허용" 선택 시 이후 무프롬프트.

### Linux — libsecret

```bash
# secret-tool 설치 (Debian/Ubuntu)
sudo apt install libsecret-tools

# 키 저장
secret-tool store --label="Claude Code OpenAI" service claude-code-openai-api-key

# MCP 등록
claude mcp add minigame-assets --scope user -- \
  sh -c 'exec env OPENAI_API_KEY="$(secret-tool lookup service claude-code-openai-api-key)" npx -y minigame-assets-mcp@latest'
```

### Windows

네이티브 Credential Manager는 셸 래핑이 복잡해, 다음 중 하나를 권장합니다:
- **1Password CLI** — `op run --env-file=claude-env.tpl -- npx -y minigame-assets-mcp@latest`
- **Doppler** / **Infisical** 같은 클라우드 시크릿 매니저

---

## 환경변수

| 변수 | 필수 | 설명 |
|---|---|---|
| `OPENAI_API_KEY` | 필수 | OpenAI API 키 (이미지·영상·비전 전부) |
| `ASSETS_OUTPUT_DIR` | 선택 | 마스터 에셋 디렉토리 (기본 `./.minigame-assets`) |
| `CONCEPT_FILE` | 선택 | 컨셉 JSON 경로 (기본 `./.minigame-assets/game-concept.json`) |
| `CONCEPT_MD_FILE` | 선택 | CONCEPT.md 경로 (기본 `./.minigame-assets/CONCEPT.md`) |
| `GAME_DESIGN_FILE` | 선택 | GAME_DESIGN.json 경로 (기본 `./.minigame-assets/GAME_DESIGN.json`) |
| `ASSET_SIZE_SPEC_FILE` | 선택 | 에셋 크기 스펙 경로 (기본 `./.minigame-assets/asset_size_spec.json`) |
| `LOCAL_MUSIC_SERVER_URL` | 음악 생성 시 | 로컬 AudioCraft 서버 주소 |
| `ASSET_OUTPUT_FORMAT` | 선택 | `png` 또는 `webp` — 엔진 자동 감지 무시 |
| `MINIGAME_ASSETS_AUTO_UPDATE` | 선택(플러그인) | `0` 설정 시 자동 업데이트 비활성화 |
