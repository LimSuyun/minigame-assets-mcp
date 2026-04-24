# Minigame Assets MCP Server

AI를 활용해 게임 에셋을 자동 생성하는 **MCP(Model Context Protocol) 서버**입니다.  
Claude와 대화하면서 캐릭터·스프라이트·배경·무기·로고·썸네일·음악·영상을 바로 만들 수 있습니다.

---

## 주요 기능

| 카테고리 | 도구 | AI |
|---------|------|----|
| **게임 컨셉** | `asset_create_concept_md` — CONCEPT.md 생성 | - |
| **실행 계획** | `asset_generate_execution_plan` — 엔진 감지 + 단계별 계획 | - |
| **캐릭터 베이스** | `asset_generate_character_base` — 정면 서 있는 캐릭터 (role: player/enemy/monster/npc) | OpenAI **gpt-image-2** (마젠타 크로마키 → 투명) |
| **장비 결합 베이스** | `asset_generate_character_equipped` — 베이스 + 무기/방어구 다중 레퍼런스 합성 | OpenAI **gpt-image-2 edit** (스프라이트 재사용 가능) |
| **스프라이트** | `asset_generate_sprite_sheet` — idle/walk/run/attack/death 등, **기본 1행 가로 스트립** | OpenAI **gpt-image-2 edit** (마젠타 크로마키) |
| **무기 아이콘** | `asset_generate_weapons` — 아이콘 일괄 생성 | OpenAI gpt-image-1 (투명 배경, 네이티브) |
| **배경** | `asset_generate_screen_background` — 게임 씬 배경 | **gpt-image-2** (static) / Gemini (parallax 투명 레이어) |
| **로딩 화면** | `asset_generate_loading_screen` — 하단 20% 프로그레스바 영역 확보 | OpenAI **gpt-image-2** (히어로·배경 레퍼런스 지원) |
| **로비 화면** | `asset_generate_lobby_screen` — menu_side로 UI 영역 지정 | OpenAI **gpt-image-2** (히어로 쇼케이스) |
| **앱 로고** | `asset_generate_app_logo` — 600×600px | OpenAI / Gemini |
| **썸네일** | `asset_generate_thumbnail` — 1932×828px | OpenAI **gpt-image-2 edit** (캐릭터·배경 레퍼런스 합성) |
| **편집** | `asset_edit_character_design`, `asset_remove_background` 등 | OpenAI / Gemini |
| **음악** | `asset_generate_music_local` | 로컬 AudioCraft/MusicGen |
| **영상** | `asset_generate_video_gemini`, `asset_generate_video_openai` | Gemini Veo / OpenAI Sora |
| **프롬프트 확장** | 대부분 이미지 도구에 `refine_prompt: true` opt-in | OpenAI **GPT-5.4-nano** (한국어/짧은 입력 상세화) |
| **품질 검토** | `asset_review` — 구조·크로마 잔류·비주얼 AI 체크 | Gemini Vision (비주얼) + 비 AI (구조) |
| **검증** | `asset_validate`, `asset_list_missing`, `asset_generate_atlas_json` | - |
| **배포** (v2.3) | `asset_scan_display_sizes` + `asset_approve` / `asset_deploy` / `asset_revoke` — `deploy-map.json` 매니페스트 기반 **마스터 → 코드 경로 리사이즈 복사** | - (sharp 리사이즈, idempotent) |

> 전체 도구 목록은 아래 [도구 레퍼런스](#도구-레퍼런스) 참고

---

## 요구사항

- Node.js 18 이상
- [Claude Code](https://claude.ai/code) CLI
- [OpenAI API Key](https://platform.openai.com/api-keys) — 이미지(gpt-image-2 기본 / gpt-image-1 계열 호환), 영상(Sora)

---

## 설치

세 가지 방식 중 **하나**를 선택하세요. 특성이 다르고, 방법 1·2 는 병용 시 같은 이름 `minigame-assets` 로 충돌합니다 (`settings.json` 엔트리가 플러그인의 `.mcp.json` 을 이기므로 플러그인 측 MCP 정의는 무시됨; 슬래시 커맨드·스킬은 정상 작동). 방법 3 은 방법 1·2 의 키 주입 경로만 대체하는 보안 강화 옵션이라 플러그인(방법 2)과 병행 가능.

| 방식 | 장점 | 단점 | 추천 |
|------|------|------|------|
| **방법 1 — MCP 서버 수동 등록** | 키가 `~/.claude.json` 에 박혀 Claude Code 를 GUI·터미널 어느 쪽으로 띄워도 작동 / 셸 rc 수정 불필요 / 단 하나의 커맨드로 끝 | 슬래시 커맨드·스킬·자동 업데이트 없음 (MCP 도구만 제공) | **대부분의 사용자 — 가장 간단** |
| **방법 2 — Claude Code 플러그인** | MCP + 슬래시 커맨드 3종 + CONCEPT-first 스킬 + 자동 업데이트 한 번에 | API 키를 셸 env 로 옮겨야 함 / macOS GUI 실행 시 `launchctl setenv` 별도 필요 | 슬래시 커맨드·자동 워크플로가 필요할 때 |
| **방법 3 — OS 시크릿 저장소** | API 키를 디스크에 평문으로 두지 않음 (macOS Keychain / Linux libsecret) — 백업·dotfiles 유출 경로 차단 | 설정 한 단계 더 / Windows 는 별도 셋업 | 키 유출 위험을 최소화하고 싶을 때 (방법 1·2 와 조합) |

---

### 방법 1 — MCP 서버 수동 등록

터미널에서 한 줄로:

```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -- npx -y minigame-assets-mcp@latest
```

- `--scope user`: 모든 프로젝트에서 사용 가능 (`~/.claude/settings.json`)
- `-e KEY=VALUE`: API 키를 MCP 서버 프로세스 env 로 주입 — Claude Code 실행 경로(GUI/터미널) 무관

선택 환경변수까지 포함:
```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -e ASSETS_OUTPUT_DIR=./.minigame-assets \
  -e LOCAL_MUSIC_SERVER_URL=http://localhost:7860 \
  -- npx -y minigame-assets-mcp@latest
```

확인:
```bash
claude mcp list
# minigame-assets: npx -y minigame-assets-mcp@latest - ✓ Connected
```

**재설치 / 키 갱신:**
```bash
claude mcp remove minigame-assets
# 위 add 명령 다시 실행 (새 키로)
```

---

### 방법 2 — Claude Code 플러그인

**① 플러그인 설치**

```
/plugin marketplace add LimSuyun/minigame-assets-mcp
/plugin install minigame-assets@minigame-assets-mcp
```

설치되는 것:
- **MCP 서버** `minigame-assets` — `npx -y minigame-assets-mcp@latest` 자동 실행
- **슬래시 커맨드**: `/create-minigame-assets`, `/setup-minigame-assets-concept`, `/minigame-assets-help`
- **자동 발동 스킬** `minigame-assets-workflow` — 에셋 생성 요청 감지 시 CONCEPT.md 를 먼저 생성하도록 워크플로 강제
- **SessionStart 훅** — 6시간마다 백그라운드로 플러그인 최신 커밋 동기화

**② API 키를 셸 환경변수로**

zsh (macOS 기본):
```bash
# ~/.zshrc 에 추가
export OPENAI_API_KEY="sk-..."
```
적용: `source ~/.zshrc`

bash: 위 내용을 `~/.bashrc` 또는 `~/.bash_profile` 에.

> **보안 강화 팁** — dotfiles 를 git 으로 관리한다면 `~/.config/secrets.env` 에 키를 `chmod 600` 으로 분리하고 `~/.zshrc` 에서 `[ -f ~/.config/secrets.env ] && source ~/.config/secrets.env` 로 로드.

**③ 확인**

Claude Code 재시작 후:
```bash
claude mcp list     # minigame-assets: ✓ Connected
```

**⚠️ macOS GUI 실행 시 주의** — Finder/Dock 아이콘으로 Claude Code 를 띄우면 `~/.zshrc` 의 `export` 가 상속되지 않습니다. 해결:
```bash
launchctl setenv OPENAI_API_KEY "sk-..."
```
(재부팅마다 재설정. 영구 유지하려면 `~/Library/LaunchAgents/` 에 plist 배치.) 터미널에서 `claude` 명령으로 실행하는 패턴이면 이 이슈 없음.

**업데이트** — 자동 (상세: [`plugins/minigame-assets/README.md`](./plugins/minigame-assets/README.md)).

---

### 방법 3 — OS 시크릿 저장소 (보안 강화)

방법 1·2 모두 API 키를 **평문 파일**(`~/.claude.json` 또는 `~/.zshrc`) 에 저장합니다. Time Machine·iCloud Drive·dotfiles git repo 같은 경로로 유출될 여지가 있어, OS 네이티브 시크릿 저장소에 키를 두고 **MCP 실행 시점에만 주입**하는 방식을 권장합니다.

플러그인(방법 2) 과 병행 가능 — 플러그인은 설치해두고, 키 주입 경로만 이 방식으로 대체합니다.

#### macOS — Keychain

**① 키를 Keychain 에 등록**
```bash
security add-generic-password -a "$USER" -s claude-code-openai-api-key -w "sk-..." -U
```
`-U` 플래그는 기존 항목이 있으면 덮어쓰기. 키 갱신 시에도 같은 명령 재실행.

**② MCP 엔트리를 Keychain 주입 래퍼로 교체**

기존 등록이 있으면 먼저 제거:
```bash
claude mcp remove minigame-assets --scope user
```

`~/.claude.json` 을 직접 열어 `mcpServers.minigame-assets` 를 이렇게 작성:
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

첫 실행 시 Keychain 접근 승인 프롬프트가 뜹니다. "항상 허용" 으로 저장하면 이후 무프롬프트로 작동합니다. `~/.zshrc` 에 `export OPENAI_API_KEY=...` 가 남아있다면 삭제.

#### Linux — libsecret (GNOME Keyring / KWallet)

`secret-tool` 이 없으면 먼저 설치: Debian/Ubuntu `sudo apt install libsecret-tools`, Fedora `sudo dnf install libsecret`.

```bash
# ① 키 저장 (프롬프트가 뜨면 키 붙여넣기)
secret-tool store --label="Claude Code OpenAI" service claude-code-openai-api-key

# ② MCP 등록 — 래퍼 커맨드로
claude mcp remove minigame-assets --scope user 2>/dev/null
claude mcp add minigame-assets --scope user -- \
  sh -c 'exec env OPENAI_API_KEY="$(secret-tool lookup service claude-code-openai-api-key)" npx -y minigame-assets-mcp@latest'
```

#### Windows

네이티브 Credential Manager (`cmdkey`) 는 셸에서 값 조회가 복잡해 래핑이 까다롭습니다. 대안:
- **1Password CLI** — `op run --env-file=claude-env.tpl -- npx -y minigame-assets-mcp@latest` 패턴
- **Doppler / Infisical** 같은 클라우드 시크릿 매니저

설정 후 `~/.claude.json` 의 `command` / `args` 를 해당 래퍼로 교체하면 됩니다.

---

### 방법 전환 (이주)

**방법 1 → 방법 2**
```bash
claude mcp remove minigame-assets --scope user
```
그다음 방법 2 전체 진행 (셸 env 설정 + 플러그인 설치).

**방법 2 → 방법 1**
```
/plugin uninstall minigame-assets@minigame-assets-mcp
/plugin marketplace remove minigame-assets-mcp
```
그다음 방법 1 의 `claude mcp add` 실행.

**방법 1·2 → 방법 3 (보안 강화)**

방법 3 섹션의 "① 키를 Keychain 에 등록" + "② MCP 엔트리 교체" 순서 그대로. 방법 2(플러그인) 를 이미 쓰고 있었다면 플러그인은 그대로 두고 `~/.zshrc` 의 `export OPENAI_API_KEY=...` 만 제거 — 키 주입 경로가 Keychain 으로 옮겨집니다. macOS `launchctl setenv` 도 썼다면 `launchctl unsetenv OPENAI_API_KEY` 로 정리.

**방법 3 → 방법 1**

```bash
# Keychain 항목 정리 (선택)
security delete-generic-password -a "$USER" -s claude-code-openai-api-key
# MCP 엔트리 재등록
claude mcp remove minigame-assets --scope user
# → 방법 1 의 claude mcp add 재실행
```
평문으로 돌아가는 셈이므로, 이 전환을 할 때는 **OpenAI 대시보드에서 키를 회전**(기존 키 revoke + 신규 발급) 한 뒤 새 키로 등록하는 걸 권장. Keychain 에 남아있던 구 키가 다른 경로로 이미 복제됐을 가능성 방어.

---

### 환경변수 전체 표

| 변수 | 필수 여부 | 설명 |
|------|----------|------|
| `OPENAI_API_KEY` | 이미지·영상(OpenAI) 사용 시 | OpenAI API 키 |
| `ASSETS_OUTPUT_DIR` | 선택 | 마스터 에셋 저장 디렉터리 (기본: `./.minigame-assets` — 원본 고해상도, gitignore 권장) |
| `CONCEPT_FILE` | 선택 | 컨셉 JSON 경로 (기본: `./game-concept.json`) |
| `CONCEPT_MD_FILE` | 선택 | CONCEPT.md 경로 (기본: `./CONCEPT.md`) |
| `LOCAL_MUSIC_SERVER_URL` | 음악 생성 사용 시 | 로컬 AudioCraft 서버 주소 |
| `MINIGAME_ASSETS_AUTO_UPDATE` | 선택 (플러그인 전용) | `0` 설정 시 플러그인 자동 업데이트 비활성화 |
| `ASSET_OUTPUT_FORMAT` | 선택 | `png` 또는 `webp` — 엔진 자동 감지를 무시하고 전역 고정 |

---

## 권장 워크플로우

```
1단계: 컨셉 정의
  └─ asset_create_concept_md
       → CONCEPT.md + game-concept.json 생성

2단계: 실행 계획
  └─ asset_generate_execution_plan
       → 게임 엔진 감지 (Phaser / Unity / Cocos / Godot)
       → EXECUTION-PLAN.md 생성

3단계: 캐릭터 생성 (role: player/enemy/monster/npc)
  ├─ asset_generate_character_base      ← 정면 베이스 (gpt-image-2, 마젠타 크로마키 → 투명)
  └─ (선택) asset_generate_character_equipped
                                        ← 베이스 + 무기/방어구 합성 (스프라이트 시트에 재사용 가능)

4단계: 무기 생성
  └─ asset_generate_weapons             ← 아이콘 일괄 생성 (gpt-image-1, 투명 배경)

5단계: 스프라이트 시트 (1행 가로 스트립 기본)
  └─ asset_generate_sprite_sheet        ← 액션 스프라이트 (gpt-image-2 edit, 마젠타 크로마키)
                                          base 또는 equipped 이미지를 레퍼런스로 받음

6단계: 배경 + 화면 생성
  ├─ asset_generate_screen_background   ← 게임 씬 배경 (gpt-image-2 static / Gemini parallax)
  ├─ asset_generate_loading_screen      ← 로딩 화면 (하단 20% 프로그레스바 영역 확보)
  └─ asset_generate_lobby_screen        ← 로비/메인 메뉴 (menu_side로 UI 자리 지정)

7단계: 마케팅 에셋
  ├─ asset_generate_app_logo            ← 앱 로고 600×600px
  └─ asset_generate_thumbnail           ← 썸네일 1932×828px (캐릭터·배경 레퍼런스 합성)

8단계: 검토 + 검증
  ├─ asset_review                       ← 구조·크로마 잔류·비주얼 AI 종합 검토
  ├─ asset_validate                     ← 네이밍 규칙 + 파일 스펙 검사
  ├─ asset_list_missing                 ← 누락 에셋 확인
  └─ asset_generate_atlas_json          ← Phaser/Unity/Cocos Atlas JSON 생성

9단계: 배포 (마스터 → 코드 경로 리사이즈 복사) ⬅ v2.3
  ├─ asset_scan_display_sizes           ← 코드에서 display 크기 + 참조 경로(asset_urls) 스캔
  ├─ deploy-map.json 의 deploy_targets  ← 스캔 결과를 힌트로 수동/스크립트 채움
  ├─ asset_approve { entries: "all" }   ← 현재 master_hash 를 approved_hash 로 고정
  └─ asset_deploy                       ← 승인된 마스터를 sharp 로 리사이즈해
                                          코드 경로(예: public/assets/...)로 복사
                                          마스터 재생성 시 hash 불일치 → 재승인 유도

> 💡 디테일이 필요한 생성 호출엔 `refine_prompt: true` 옵션 사용 가능
>   → GPT-5.4-nano가 짧은/한국어 입력을 상세 영문 프롬프트로 확장 후 이미지 생성
>   → 지원: asset_generate_character_base, asset_generate_character_equipped,
>            asset_generate_thumbnail, asset_generate_image_openai,
>            asset_generate_loading_screen, asset_generate_lobby_screen
```

---

## 출력 구조

생성되는 모든 원본(마스터)은 `./.minigame-assets/` 한 곳에 모입니다. 이는 **고해상도 원본**이므로 배포본에 그대로 올리지 않습니다 — 실제 게임 코드가 쓰는 리사이즈된 사본은 `asset_deploy` 도구가 `deploy-map.json` 의 `approved` 엔트리만 골라 코드 경로로 복사합니다.

**배포 워크플로:**
```
1. asset_generate_* 로 생성 → .minigame-assets/<type>/*.png (자동으로 deploy-map.json 에 approved:false 로 등록)
2. asset_scan_display_sizes 로 코드에서 기대되는 사이즈·경로 스캔
3. deploy-map.json 의 deploy_targets 필드 채우기 (스캔 결과 기반)
4. 검토 후 asset_approve { entries: [...] } 또는 { entries: "all" }
5. asset_deploy → 승인된 마스터만 리사이즈해 public/assets/... 등 코드 경로로 복사
   - 마스터가 재생성되면 master_hash 가 바뀌어 needs_reapproval 로 스킵 (재확정 필요)
```

```
.minigame-assets/                ← 마스터 (gitignore 권장, deploy-map/*.md 만 git 포함)
├── assets-registry.json        ← 생성된 모든 에셋 메타데이터
├── deploy-map.json             ← 배포 매니페스트 (approved/targets/hashes, git 포함)
├── images/                     ← 일반 이미지
├── sprites/                    ← 캐릭터 스프라이트 시트
├── characters/                 ← 캐릭터 베이스 이미지
├── weapons/                    ← 무기 아이콘
├── backgrounds/                ← 배경 이미지
├── logos/                      ← 앱 로고
├── thumbnails/                 ← 썸네일
├── music/                      ← 음악
└── videos/                     ← 영상

CONCEPT.md                      ← 게임 컨셉 (아트 스타일, 에셋 목록)
EXECUTION-PLAN.md               ← 에셋 생성 실행 계획
game-concept.json               ← 게임 컨셉 JSON (도구 내부 참조용)
```

### 코드 기반 크기 조정 (display-size scanner)

이미 게임 코드가 있는 프로젝트는 **실제 런타임 표시 크기**에 맞춰 생성할 수 있습니다.

```
asset_scan_display_sizes  project_path: "."
```

감지 패턴:
- **Phaser**: `add.sprite(x, y, 'key').setDisplaySize(w, h)`, `.setScale(n)` + `load.image/spritesheet/atlas(key, path)`
- **Cocos Creator**: `.setContentSize(w, h)` + `resources.load(path)`
- **Godot**: `$Sprite.scale = Vector2(n, n)` + `preload/load("res://...")`

출력 예:
```json
{
  "detections": [
    {
      "asset_key": "hero",
      "display_width": 64,
      "display_height": 64,
      "suggested_generation_size": 128,
      "asset_urls": ["assets/characters/hero.png"]
    },
    {
      "asset_key": "forest_bg",
      "display_width": 800,
      "display_height": 600,
      "suggested_generation_size": 1024,
      "asset_urls": ["assets/backgrounds/forest.webp"]
    }
  ]
}
```

- `suggested_generation_size` 를 `asset_generate_*` 도구의 `size` 파라미터로 전달하면 1024 기본값 대신 딱 맞는 크기로 생성 → 추가 용량 절감. 2× 헤드룸·multiple-of-64 스냅 룰 적용.
- `asset_urls[]` 는 코드에서 load 함수로 참조되는 경로 목록 — **v2.3** 에서 `asset_deploy` 의 `deploy_targets[].path` 힌트로 그대로 재사용 가능.

---

### 출력 포맷 (PNG vs WebP)

생성된 이미지는 **작업 디렉터리의 게임 엔진**을 자동 감지해 포맷이 결정됩니다.

| 엔진 | 기본 포맷 | 용량 비교 (캐릭터 베이스 실측) |
|------|----------|--------------------------------|
| Phaser 3 | **WebP** | 2.03 MB → 250 KB (**-87.7%**) |
| Cocos Creator 3 | **WebP** | 동일 수준 |
| Godot 3+ | **WebP** | 동일 수준 |
| Unity | PNG | 변화 없음 (런타임 WebP 미지원) |
| 엔진 미감지 | PNG | 안전한 기본값 |

결정 우선순위:
1. 각 도구 호출 시 `output_format` 파라미터 (명시 지정)
2. `ASSET_OUTPUT_FORMAT=png|webp` 환경변수 (전역 override)
3. 자동 감지된 엔진 → WebP 지원 여부
4. fallback: PNG

**PNG 유지하고 싶을 때:**
```bash
export ASSET_OUTPUT_FORMAT=png   # 영구 고정
```

**파일이 이미 PNG 이고 PNG 으로 저장되는 경우**는 sharp 재인코딩을 건너뛰고 원본 바이트를 그대로 보존합니다 (재인코딩 시 오히려 15% 커지는 현상 회피).

Atlas JSON / Phaser Loader 등 엔진별 export 는 파일명의 실제 확장자로 자동 참조되므로 별도 설정 불필요.

---

## 도구 레퍼런스

### 컨셉 & 계획

| 도구 | 설명 |
|------|------|
| `asset_create_concept_md` | 게임 컨셉·에셋 목록·스타일 가이드를 CONCEPT.md로 생성 |
| `asset_get_concept` | 현재 게임 컨셉 조회 |
| `asset_generate_execution_plan` | CONCEPT.md + 엔진 감지 → EXECUTION-PLAN.md 생성 |
| `asset_generate_asset_plan` | 프로젝트 코드 분석 → 누락 에셋 계획 수립 |
| `asset_list_assets` | 생성된 에셋 목록 조회 |

### 이미지 생성

| 도구 | 설명 |
|------|------|
| `asset_generate_image` | 에셋 타입 기반 자동 AI 선택 |
| `asset_generate_image_openai` | OpenAI gpt-image-2 / gpt-image-1 계열 (기본 gpt-image-1-mini 저비용) |
| `asset_generate_image_gemini` | Gemini Imagen 4 (generate / fast / ultra) |
| `asset_generate_image_responses` | OpenAI Responses API (텍스트 모델 + 이미지 조합) |
| `asset_batch_generate_images` | 최대 10개 일괄 생성 |
| `asset_compare_models` | 여러 OpenAI 모델 A/B 비교 결과물 |
| `asset_generate_with_reference` | 레퍼런스 이미지 기반 생성 |

### 캐릭터 & 스프라이트

| 도구 | 설명 |
|------|------|
| `asset_generate_character_base` | 정면 캐릭터 베이스 (gpt-image-2, 마젠타 크로마키 → 투명). **role**: player/enemy/monster/npc/generic |
| `asset_generate_character_equipped` | 베이스 + 장비 다중 레퍼런스 합성 → 새 투명 PNG 베이스 |
| `asset_generate_character_views` | 정면·측면·후면 등 멀티뷰 세트 생성 |
| `asset_generate_character_pose` | 단일 포즈 이미지 생성 |
| `asset_generate_character_portrait` | 초상화 3사이즈 (full / bust / thumb) |
| `asset_generate_character_card` | 카드 UI 합성 (Sharp, AI 미사용) |
| `asset_generate_sprite_sheet` | 액션 스프라이트 시트 (gpt-image-2 edit). **기본: 1행 가로 스트립** (`sheet_cols`로 grid 전환) |
| `asset_generate_action_sprite` | 단일 액션 프레임 (Gemini edit) |
| `asset_generate_character_weapon_sprites` | 무기 장착 상태 스프라이트 일괄 |
| `asset_generate_avatar_parts` | 아바타 커스터마이즈 파츠 (헤어·의상 등) |
| `asset_generate_weapons` | 무기 아이콘 일괄 (gpt-image-1, 투명 배경) |

### 편집

| 도구 | 설명 |
|------|------|
| `asset_edit_image` | 이미지 스타일/색상 편집 |
| `asset_edit_sprite` | 특정 액션 프레임 수정 |
| `asset_edit_character_design` | 캐릭터 디자인 변경 + 스프라이트 자동 재생성 |
| `asset_remove_background` | 배경 제거 (투명 PNG) |
| `asset_remove_background_batch` | 배경 일괄 제거 |

### 화면 (로딩·로비·배경)

| 도구 | 설명 |
|------|------|
| `asset_generate_loading_screen` | 로딩 화면 풀스크린 (gpt-image-2, 하단 20-25% 프로그레스바 영역 확보) |
| `asset_generate_lobby_screen` | 로비/메인 메뉴 화면 (gpt-image-2, menu_side: left/right/center/bottom으로 UI 영역 지정) |
| `asset_generate_screen_background` | 게임 씬 배경 (static/parallax, gpt-image-2 기본) |

### 환경 & 맵

| 도구 | 설명 |
|------|------|
| `asset_generate_parallax_set` | 다층 배경 (레이어별 speed factor) |
| `asset_generate_tileset` | 16타일 시트 + 설정 JSON (seamless tileable) |
| `asset_generate_props_set` | 맵 오브젝트/소품 세트 (투명 배경) |
| `asset_generate_interactive_objects` | 상태별 스프라이트 (open/closed 등) + Atlas |

### UI 세트

| 도구 | 설명 |
|------|------|
| `asset_generate_hud_set` | 게임 내 HUD 일괄 (체력바·미니맵 등) |
| `asset_generate_button_set` | 버튼 세트 (primary/secondary 등) |
| `asset_generate_popup_set` | 팝업·다이얼로그 프레임 |
| `asset_generate_icon_set` | 아이콘 세트 |
| `asset_generate_ui_structural` | 구조적 UI 요소 |
| `asset_generate_ui_decorative` | 장식용 UI 요소 |

### 이펙트 & 튜토리얼

| 도구 | 설명 |
|------|------|
| `asset_generate_effect_sheet` | 이펙트 애니메이션 시트 + Atlas JSON |
| `asset_generate_status_effect_icons` | 상태이상 아이콘 세트 |
| `asset_generate_floating_text` | 플로팅 텍스트 스타일 PNG (Sharp SVG, AI 미사용) |
| `asset_generate_tutorial_overlays` | 스포트라이트·화살표 오버레이 |
| `asset_generate_guide_npc` | 가이드 NPC 표정 세트 (idle/happy/thinking 등) |

### 마케팅 에셋

| 도구 | 설명 |
|------|------|
| `asset_generate_app_logo` | 앱 로고 600×600px PNG |
| `asset_plan_thumbnail` | 썸네일 구성 계획 + 프롬프트 작성 (생성 없음) |
| `asset_generate_thumbnail` | 썸네일 1932×828px (gpt-image-2 edit, 캐릭터·배경 레퍼런스 다중 합성) |
| `asset_generate_store_banner` | 플랫폼별 배너 (Google Play / App Store) |
| `asset_generate_store_screenshots` | 씬별 스크린샷 + 플랫폼별 크기 + 캡션 오버레이 |
| `asset_generate_social_media_pack` | Instagram/Twitter/Facebook 게시물 세트 |
| `asset_generate_style_reference_sheet` | 스타일 레퍼런스 시트 (아트 가이드용) |

### 음악 · 영상

| 도구 | 설명 |
|------|------|
| `asset_generate_music_local` | 로컬 AudioCraft/MusicGen 또는 Gradio |
| `asset_generate_bgm` | 카테고리별 BGM 일괄 |
| `asset_generate_sfx` | 카테고리별 SFX 일괄 (AudioGen) |
| `asset_edit_music` | 음악 파라미터 수정 |
| `asset_generate_video_gemini` | Gemini Veo 3/2 (5~8초) |
| `asset_generate_video_openai` | OpenAI Sora (5~20초) |

### Canon (마스터 레퍼런스)

| 도구 | 설명 |
|------|------|
| `asset_register_canon` | 마스터 레퍼런스 에셋을 canon registry에 등록 |
| `asset_get_canon` / `asset_list_canon` | canon 조회 |
| `asset_validate_consistency` | canon 대비 생성 결과물 일관성 검사 |

### 계획 & 디자인 문서

| 도구 | 설명 |
|------|------|
| `asset_create_concept` | game-concept.json 생성 |
| `asset_parse_design_doc` | 외부 디자인 문서(GDD) 파싱 |
| `asset_plan_requirements` | 필수 에셋 요구사항 도출 |
| `asset_plan_by_screen` | 화면 단위 에셋 계획 |
| `asset_generate_full_plan` | FULL_ASSET_PLAN.md 생성 |
| `asset_generate_size_spec` | asset_size_spec.json 생성 |

### 검토·검증·유틸

| 도구 | 설명 |
|------|------|
| `asset_review` | 생성된 에셋 품질 종합 검토 (구조 + 크로마 잔류 + 비주얼 AI). mode: quick/standard/deep |
| `asset_validate` | 네이밍 규칙 + PNG 크기 스펙 검사 |
| `asset_list_missing` | 필수 에셋 누락 목록 (직접 지정 / spec_file / CONCEPT.md) |
| `asset_generate_atlas_json` | 스프라이트 시트 Atlas JSON (Phaser / Unity / Cocos / Generic) |
| `asset_analyze_project` | 게임 엔진 자동 감지 + 에셋 디렉토리 분석 |
| `asset_plan_from_project` | 코드에서 참조된 미싱 에셋 계획 수립 |
| `asset_scan_display_sizes` | 게임 코드 스캔 → `asset_key` 별 `display_width/height`, `suggested_generation_size`, `asset_urls[]`(참조 경로) 추출 |
| `asset_composite` | 다중 이미지 합성 |
| `asset_extract_palette` | 이미지에서 컬러 팔레트 추출 |
| `asset_refine_transparency` | 크로마 잔류 후처리 재실행 |
| `asset_convert_font_to_bitmap` | 폰트 파일 → 비트맵 스프라이트 시트 |
| `asset_get_job_result` | 비동기 job 결과 조회 |

### 배포 (매니페스트 기반 approve → deploy, v2.3)

`.minigame-assets/deploy-map.json` 을 source of truth 로 두고, 마스터(원본) 를 코드 경로에 리사이즈 복사하는 파이프라인. 생성된 모든 에셋은 `approved: false` 로 매니페스트에 자동 등록됩니다.

| 도구 | 설명 |
|------|------|
| `asset_approve` | `entries: string[] \| "all"` — 현재 `master_hash` 를 `approved_hash` 로 고정해 배포 승인. 마스터가 재생성되면 hash 불일치로 `needs_reapproval` 상태가 되어 재호출 필요 |
| `asset_revoke` | 승인 해제 (엔트리는 이력 보존 차원에서 유지) |
| `asset_deploy` | 승인된 마스터를 sharp 로 `width × height × fit × format` 리사이즈해 `deploy_targets[].path` 로 복사. 바이트 동일하면 재작성 스킵(idempotent). `dry_run`·`force`·`entries` 필터 지원 |

### 프롬프트 확장 (opt-in)

대부분의 이미지 생성 도구에 `refine_prompt: true` 옵션 지원 — **OpenAI GPT-5.4-nano**가 짧은 한국어/영어 입력을 상세 영문 프롬프트로 확장한 후 이미지 모델에 전달합니다. 짧은 설명이나 한국어 입력, 브랜드 일관성이 중요한 에셋에 유용.

```
기본:   "검을 든 전사"                     → 이미지 생성
refine: "A heroic warrior holding an        → 이미지 생성 (디테일 ↑)
        ornate long sword, polished silver
        plate armor with gold trim..."
```

지원 도구: `asset_generate_character_base`, `asset_generate_character_equipped`, `asset_generate_image_openai`, `asset_generate_thumbnail`, `asset_generate_loading_screen`, `asset_generate_lobby_screen`

비용·지연: 호출당 ~$0.001 + ~2-4초. 디테일이 중요한 때만 선택적으로 사용 권장.

---

## 비용·성능 추적

v2.1부터 AI를 호출하는 모든 이미지/스프라이트/UI/환경/마케팅/튜토리얼 도구는
`assets-registry.json`의 각 에셋 `metadata`에 다음 필드를 기록합니다:

```json
"metadata": {
  "model": "gpt-image-2",
  "latency_ms": 12843,
  "est_cost_usd": 0.04,
  "cost_formula": "gpt-image-2 × high × size-mult 1 = $0.04 × 1"
}
```

- 합성 도구(tileset, effect sheet 등)는 단가를 타일/프레임 수만큼 곱해 집계합니다.
- 이 값은 **참고용 추정치**입니다. 실제 청구는 OpenAI / Google 공식 대시보드 기준.
- `asset_list_assets`로 누적 비용을 빠르게 훑어볼 수 있습니다.

---

## HTTP 모드 (stateful 세션)

```bash
TRANSPORT=http PORT=3456 node dist/index.js
```

- `POST /mcp` — MCP JSON-RPC. initialize 요청에 응답할 때 `mcp-session-id` 헤더가 반환되며,
  후속 요청은 같은 세션에 라우팅됩니다.
- `GET /mcp` — SSE 스트림 재개
- `DELETE /mcp` — 세션 종료
- `GET /health` — `{ status, server, version, active_sessions }`

각 세션은 독립된 `McpServer` 인스턴스를 가지므로 동시 다중 클라이언트가 안전합니다.

---

## 로컬 음악 서버 설정 (선택)

AudioCraft/MusicGen을 로컬에서 실행하는 경우:

```bash
pip install audiocraft
python music_server.py --port 7860
```

Gradio Space를 로컬 실행하는 경우 도구 파라미터에 `use_gradio: true`를 사용하세요.

---

## 템플릿 파일

`templates/` 폴더에 새 게임 프로젝트 시작 시 참고할 수 있는 기준 파일들이 포함되어 있습니다:

| 파일 | 설명 |
|------|------|
| `templates/CONCEPT.md` | 게임 컨셉 마크다운 템플릿 |
| `templates/EXECUTION-PLAN.md` | 실행 계획 마크다운 템플릿 |
| `templates/docs/asset-spec.md` | 에셋 제작 스펙 (크기·포맷·프레임 수) |
| `templates/docs/naming-convention.md` | 파일 네이밍 규칙 |
| `templates/docs/layer-system.md` | Phaser 3 레이어 설계 예시 |
| `templates/docs/game-design.md` | 게임 디자인 문서 예시 |

---

## 개발 (소스 직접 수정)

```bash
git clone https://github.com/LimSuyun/minigame-assets-mcp.git
cd minigame-assets-mcp
npm install
npm run build

# 로컬 빌드를 MCP로 등록
claude mcp add minigame-assets \
  -e OPENAI_API_KEY=sk-... \
  -- node /절대경로/minigame-assets-mcp/dist/index.js
```

```bash
npm run dev    # tsx watch 모드 (핫리로드)
npm run build  # TypeScript 컴파일
npm start      # 빌드된 서버 실행
```

HTTP 모드 실행 (포트 3456):

```bash
TRANSPORT=http node dist/index.js
```

---

## 라이선스

MIT
