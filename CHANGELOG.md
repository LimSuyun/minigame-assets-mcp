# Changelog

모든 주요 변경사항을 기록합니다.

포맷은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르고,
버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 준수합니다.

## [Unreleased]

## [2.0.0] - 2026-04-23

### 💥 BREAKING CHANGES

- **`asset_generate_sprite_sheet` provider 변경**: Gemini edit → **OpenAI gpt-image-2 edit**
  - 기존 `prompt_file`에 `settings.edit_model: "gemini-2.5-flash-image"` 저장해둔 사용자는 해당 필드 삭제 또는 `"gpt-image-2"`로 수정 필요
- **`asset_generate_character_base` 기본 모델 변경**: `gpt-image-1-mini` (네이티브 투명) → **`gpt-image-2`** (마젠타 크로마키 → 투명)
  - 네이티브 투명이 필요하면 `model: "gpt-image-1"` 명시
- **`asset_generate_sprite_sheet` 기본 레이아웃**: auto-sqrt 그리드 → **1행 가로 스트립** (cols = frames.length)
  - 이전 동작 원하면 `sheet_cols` 명시 (예: `sheet_cols: 3`)
- **`asset_generate_screen_background` 기본 provider**: Gemini → **OpenAI gpt-image-2** (static 배경)
  - parallax 투명 레이어는 `provider: "gemini"` 여전히 권장

### ✨ Added

#### 신규 도구 (4종)
- **`asset_generate_character_equipped`** — 베이스 캐릭터 + 장비(무기·방어구) 다중 레퍼런스를 gpt-image-2 edit로 합성, 장비 착용 상태 투명 PNG 베이스 생성. 스프라이트 시트에 그대로 재사용 가능
- **`asset_generate_loading_screen`** — 로딩 화면 풀스크린 (하단 20% 프로그레스 영역 자동 확보, 히어로 레퍼런스 지원)
- **`asset_generate_lobby_screen`** — 로비/메인 메뉴 화면 (`menu_side`로 UI 배치 영역 지정)
- **`asset_review`** — 생성 에셋 품질 종합 검토 (구조 · 크로마 잔류 · 비주얼 AI). mode: quick / standard / deep

#### 신규 파라미터
- **`role`** (character_base) — player / enemy / monster / npc / generic. 역할별 실루엣·컬러·디테일 가이던스 자동 주입
- **`sheet_cols`** (sprite_sheet) — 그리드 열 수 override (기본: frames.length로 1행)
- **`refine_prompt`** (대부분의 이미지 도구) — opt-in, OpenAI **GPT-5.4-nano**로 짧은 입력을 상세 영문 프롬프트로 확장 후 이미지 생성. 한국어·간단 설명에 유용. 지원: character_base, character_equipped, image_openai, thumbnail, loading_screen, lobby_screen

#### 이미지 모델 지원
- **OpenAI gpt-image-2** (2026-04-21 출시) 지원 — 4K 해상도, 다국어 텍스트, 고품질 일러스트. 투명 배경 미지원(shim이 auto로 자동 강등)

#### 유틸·서비스
- `src/services/gpt5-prompt.ts` — 프롬프트 리파인 서비스
- `src/tools/review.ts` — 에셋 품질 검토 도구
- `src/utils/image-process.ts`에 `scanChromaResidue()` 유틸 추가

#### 문서·템플릿
- `templates/docs/layer-system.md` "Screen vs Layer" 구분 섹션 + MCP 도구별 Layer/Scene 매핑 표
- `templates/CONCEPT.md` 에셋 테이블에 `layer` 컬럼
- `templates/EXECUTION-PLAN.md` Phaser Scene/Layer 매핑 표
- `CHANGELOG.md` (이 파일)

### 🔧 Changed

- **API 타임아웃 120초 → 300초** (gpt-image-2 high quality는 단건 2분 이상 소요 가능)
- **`background: "transparent"` 자동 처리** — `resolveBackground(model, requested)` shim이 gpt-image-2처럼 투명 미지원 모델 요청 시 `"auto"`로 자동 강등 (API 400 오류 방지)
- **`getDefaultProvider("background")`** → "openai" 반환 (기존 "gemini")
- `asset_generate_thumbnail` 기본 모델 gpt-image-2로, 레퍼런스 edit 워크플로우 권장
- 여러 도구의 description에 Layer/Scene 타깃 명시 + `layer-system.md` 링크

### 🐛 Fixed

- **크로마키 내부 포켓 잔류 버그** — 캐릭터 외곽선으로 닫힌 영역(겨드랑이·다리 사이 등)의 마젠타 픽셀이 투명화되지 않던 문제 해결. `floodFillRemove`에 크로마 모드 전용 residue 패스 추가 (엣지 BFS 이후 전수 글로벌 마킹). 정량 검증: 실제 gpt-image-2 베이스 이미지에서 418px → 0px

### 📚 Docs

- `README.md` — 주요 기능 표 확장, 8단계 워크플로우 다이어그램, 도구 레퍼런스 재편, GPT-5 리파인 섹션, 화면 섹션 분리
- `.claude/commands/create-minigame-assets.md` — 3.5단계(장비 결합), 6단계(로딩/로비), 8단계(asset_review) 추가
- `.claude/commands/setup-minigame-assets-concept.md` — 기존 프로젝트 워크플로우에 리뷰·화면·equipped 추가

### 🔒 Security / Privacy

- `scripts/.local/` 디렉토리를 `.gitignore`에 추가 — 개인 콘텐츠(프로필 아바타 생성 스크립트)·일회성 디버그 스크립트를 커밋·npm publish에서 원천 제외

---

## [1.1.2] - 2026-04-20

- 치비 스타일 기본값, 그림자 제거, 전신 가시성 수정
- gpt-image-1.5 / gpt-image-1-mini 모델 추가, Responses API 지원

## [1.1.1]

- 모든 이미지 프롬프트에 no-text 강제
- `asset_generate_character_views` 도구 추가

## [1.1.0]

- 새 도구 그룹 추가 + 기존 도구 확장

## [1.0.1]

- MCP stdio 전송에서 stdout 오염 수정 (dotenv 제거)

## [1.0.0]

- 초기 릴리스 — Minigame Assets MCP Server

---

## 마이그레이션 가이드 (1.1.x → 2.0.0)

### 1. `prompt_file`에서 Gemini 모델명 제거

```diff
  {
    "sprite": {
      "settings": {
-       "edit_model": "gemini-2.5-flash-image"
+       "edit_model": "gpt-image-2"
      }
    }
  }
```

### 2. 스프라이트 시트를 그리드로 원하면 `sheet_cols` 명시

```diff
  asset_generate_sprite_sheet({
    character_name: "hero",
    actions: ["idle", "walk", "run", "jump", "attack", "hurt", "die"],
+   sheet_cols: 3  // 3×ceil(N/3) 그리드
  })
```

### 3. 네이티브 투명 캐릭터 베이스 원하면 모델 명시

```diff
  asset_generate_character_base({
    character_name: "hero",
    description: "...",
+   model: "gpt-image-1"  // 또는 "gpt-image-1-mini" (저렴)
  })
```

### 4. 배경을 Gemini로 유지하려면 provider 명시

```diff
  asset_generate_screen_background({
    screen_name: "forest",
    style: "parallax",
+   provider: "gemini"  // parallax 투명 레이어 권장
  })
```
