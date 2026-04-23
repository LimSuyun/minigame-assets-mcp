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

> 전체 도구 목록은 아래 [도구 레퍼런스](#도구-레퍼런스) 참고

---

## 요구사항

- Node.js 18 이상
- [Claude Code](https://claude.ai/code) CLI
- API 키 (사용할 기능에 따라 선택)
  - [OpenAI API Key](https://platform.openai.com/api-keys) — 이미지(gpt-image-2 기본 / gpt-image-1 계열 호환), 영상(Sora)
  - [Google Gemini API Key](https://aistudio.google.com/app/apikey) — 이미지(Imagen 4), 영상(Veo)

---

## 설치

두 가지 방식 중 **하나**를 선택하세요. 특성이 다르고, 병용하면 같은 이름 `minigame-assets` 로 충돌합니다 (`settings.json` 엔트리가 플러그인의 `.mcp.json` 을 이기므로 플러그인 측 MCP 정의는 무시됨; 슬래시 커맨드·스킬은 정상 작동).

| 방식 | 장점 | 단점 | 추천 |
|------|------|------|------|
| **방법 1 — MCP 서버 수동 등록** | 키가 `settings.json` 에 박혀 Claude Code 를 GUI·터미널 어느 쪽으로 띄워도 작동 / 셸 rc 수정 불필요 | 슬래시 커맨드·스킬·자동 업데이트 없음 / CONCEPT-first 워크플로는 Claude 가 알아서 지켜줘야 함 | 단순히 `asset_*` 도구만 필요할 때 |
| **방법 2 — Claude Code 플러그인** | MCP + 슬래시 커맨드 3종 + CONCEPT-first 스킬 + 자동 업데이트 한 번에 | API 키를 셸 env 로 옮겨야 함 / macOS GUI 실행 시 `launchctl setenv` 별도 필요 | 워크플로까지 자동화하고 싶을 때 (대부분의 사용자) |

---

### 방법 1 — MCP 서버 수동 등록

터미널에서 한 줄로:

```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=AIza... \
  -- npx -y minigame-assets-mcp@latest
```

- `--scope user`: 모든 프로젝트에서 사용 가능 (`~/.claude/settings.json`)
- `-e KEY=VALUE`: API 키를 MCP 서버 프로세스 env 로 주입 — Claude Code 실행 경로(GUI/터미널) 무관

선택 환경변수까지 포함:
```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=AIza... \
  -e ASSETS_OUTPUT_DIR=./generated-assets \
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
export GEMINI_API_KEY="AIza..."
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
launchctl setenv GEMINI_API_KEY "AIza..."
```
(재부팅마다 재설정. 영구 유지하려면 `~/Library/LaunchAgents/` 에 plist 배치.) 터미널에서 `claude` 명령으로 실행하는 패턴이면 이 이슈 없음.

**업데이트** — 자동 (상세: [`plugins/minigame-assets/README.md`](./plugins/minigame-assets/README.md)).

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

---

### 환경변수 전체 표

| 변수 | 필수 여부 | 설명 |
|------|----------|------|
| `OPENAI_API_KEY` | 이미지·영상(OpenAI) 사용 시 | OpenAI API 키 |
| `GEMINI_API_KEY` | 이미지·영상(Gemini) 사용 시 | Google AI Studio API 키 |
| `ASSETS_OUTPUT_DIR` | 선택 | 에셋 저장 디렉터리 (기본: `./generated-assets`) |
| `CONCEPT_FILE` | 선택 | 컨셉 JSON 경로 (기본: `./game-concept.json`) |
| `CONCEPT_MD_FILE` | 선택 | CONCEPT.md 경로 (기본: `./CONCEPT.md`) |
| `LOCAL_MUSIC_SERVER_URL` | 음악 생성 사용 시 | 로컬 AudioCraft 서버 주소 |
| `MINIGAME_ASSETS_AUTO_UPDATE` | 선택 (플러그인 전용) | `0` 설정 시 플러그인 자동 업데이트 비활성화 |

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

> 💡 디테일이 필요한 생성 호출엔 `refine_prompt: true` 옵션 사용 가능
>   → GPT-5.4-nano가 짧은/한국어 입력을 상세 영문 프롬프트로 확장 후 이미지 생성
>   → 지원: asset_generate_character_base, asset_generate_character_equipped,
>            asset_generate_thumbnail, asset_generate_image_openai,
>            asset_generate_loading_screen, asset_generate_lobby_screen
```

---

## 출력 구조

```
generated-assets/
├── assets-registry.json        ← 생성된 모든 에셋 메타데이터
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
| `asset_composite` | 다중 이미지 합성 |
| `asset_extract_palette` | 이미지에서 컬러 팔레트 추출 |
| `asset_refine_transparency` | 크로마 잔류 후처리 재실행 |
| `asset_convert_font_to_bitmap` | 폰트 파일 → 비트맵 스프라이트 시트 |
| `asset_get_job_result` | 비동기 job 결과 조회 |

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
  -e GEMINI_API_KEY=AIza... \
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
