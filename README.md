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

터미널에서 아래 명령어 한 줄로 설치합니다:

```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=AIza... \
  -- npx -y minigame-assets-mcp@latest
```

> `--scope user`: 모든 프로젝트에서 사용 가능하도록 전역 등록 (`~/.claude/settings.json`)

설치 확인:

```bash
claude mcp list
```

`minigame-assets` 항목이 표시되면 완료입니다.

### 선택적 환경 변수

```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=AIza... \
  -e ASSETS_OUTPUT_DIR=./generated-assets \
  -e LOCAL_MUSIC_SERVER_URL=http://localhost:7860 \
  -- npx -y minigame-assets-mcp@latest
```

| 변수 | 필수 여부 | 설명 |
|------|----------|------|
| `OPENAI_API_KEY` | 이미지·영상(OpenAI) 사용 시 | OpenAI API 키 |
| `GEMINI_API_KEY` | 이미지·영상(Gemini) 사용 시 | Google AI Studio API 키 |
| `ASSETS_OUTPUT_DIR` | 선택 | 에셋 저장 디렉토리 (기본: `./generated-assets`) |
| `LOCAL_MUSIC_SERVER_URL` | 음악 생성 사용 시 | 로컬 AudioCraft 서버 주소 |

### 재설치 / 업데이트

```bash
claude mcp remove minigame-assets
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -e GEMINI_API_KEY=AIza... \
  -- npx -y minigame-assets-mcp@latest
```

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
| `asset_generate_image_openai` | OpenAI gpt-image-2 / gpt-image-1 계열 |
| `asset_generate_image_gemini` | Gemini Imagen 4 |
| `asset_batch_generate_images` | 최대 10개 일괄 생성 |

### 스프라이트

| 도구 | 설명 |
|------|------|
| `asset_generate_character_base` | 정면 캐릭터 베이스 (gpt-image-2, 마젠타 크로마키 → 투명). **role**: player/enemy/monster/npc/generic |
| `asset_generate_character_equipped` | 베이스 + 장비(무기/방어구/악세서리) 다중 레퍼런스 합성 → 새 투명 PNG 베이스 |
| `asset_generate_sprite_sheet` | 캐릭터 액션 스프라이트 시트 (gpt-image-2 edit). **기본: 1행 가로 스트립** (`sheet_cols`로 grid 전환 가능) |
| `asset_generate_action_sprite` | 단일 액션 프레임 생성 (Gemini edit) |
| `asset_generate_weapons` | 무기 아이콘 일괄 생성 (gpt-image-1, 투명 배경) |

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

### 마케팅 에셋

| 도구 | 설명 |
|------|------|
| `asset_generate_app_logo` | 앱 로고 600×600px PNG |
| `asset_plan_thumbnail` | 썸네일 구성 계획 + 프롬프트 작성 (생성 없음) |
| `asset_generate_thumbnail` | 썸네일 1932×828px PNG (gpt-image-2 edit, 캐릭터·배경 레퍼런스 다중 합성) |

### 음악 · 영상

| 도구 | 설명 |
|------|------|
| `asset_generate_music_local` | 로컬 AudioCraft/MusicGen 또는 Gradio |
| `asset_generate_video_gemini` | Gemini Veo 2/3 (5~8초) |
| `asset_generate_video_openai` | OpenAI Sora (5~20초) |

### 검토 & 검증 & 유틸

| 도구 | 설명 |
|------|------|
| `asset_review` | 생성된 에셋 품질 종합 검토 (구조 + 크로마 잔류 + 비주얼 AI). mode: quick/standard/deep |
| `asset_validate` | 네이밍 규칙 + PNG 크기 스펙 검사 |
| `asset_list_missing` | 필수 에셋 누락 목록 (직접 지정 / spec_file / CONCEPT.md) |
| `asset_generate_atlas_json` | 스프라이트 시트 Atlas JSON 생성 (Phaser / Unity / Cocos / Generic) |
| `asset_analyze_project` | 게임 엔진 자동 감지 + 에셋 디렉토리 분석 |
| `asset_plan_from_project` | 코드에서 참조된 미싱 에셋 계획 수립 |

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
