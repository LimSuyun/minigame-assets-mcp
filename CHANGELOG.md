# Changelog

모든 주요 변경사항을 기록합니다.

포맷은 [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)를 따르고,
버전은 [Semantic Versioning](https://semver.org/spec/v2.0.0.html)을 준수합니다.

## [Unreleased]

### ✨ Added

- **엔진 기반 자동 WebP/PNG 포맷 선택** — 신규 `src/utils/image-output.ts` 헬퍼가
  `cwd` 에서 게임 엔진(Phaser / Cocos Creator / Godot / Unity / unknown)을 감지해
  WebP 를 지원하는 엔진이면 WebP, 아니면 PNG 로 저장. Phaser 프로젝트 기준 캐릭터
  베이스 2MB → 250KB (**-87.7%**) 용량 감소 실측.
- 환경변수 `ASSET_OUTPUT_FORMAT=png|webp` 로 전역 override, 각 도구 호출 시
  `options.format` 로 per-call override 가능.
- PNG pass-through 최적화 — 입력이 이미 PNG 이고 PNG 으로 저장할 때 sharp 재인코딩
  없이 원본 바이트 그대로 쓰기 (재인코딩 시 오히려 ~15% 커지는 현상 회피).

### 🔧 Changed

- `asset_generate_character_base`, `asset_generate_action_sprite`(Gemini),
  `asset_generate_sprite_sheet`, `asset_generate_character_weapon_sprites`
  — 4개 도구의 최종 쓰기가 `writeOptimized()` 로 전환됨. asset registry 의
  `file_path` / `file_name` / `mime_type` 이 실제 저장 포맷에 맞춰 자동 업데이트됨.

### 📝 Notes

- 나머지 이미지 생성 도구(logo, thumbnail, environment, characters-ext portraits,
  ui, effects, tutorial, marketing 등)는 후속 커밋에서 동일 헬퍼로 전환 예정.
- 스프라이트 시트 컴포저(`composeSpritSheet`) 는 현재 여전히 PNG 저장 — 컴포저
  리팩토링 후 엔진 감지 반영.

## [2.1.0] - 2026-04-23

### ✨ Added

- **비용·성능 텔레메트리 전체 도구로 확장** — v2.0에서 sprite/ui에만 기록되던
  `latency_ms` / `est_cost_usd` / `cost_formula` / `model` 필드를 모든 이미지·스프라이트·
  UI·환경·이펙트·캐릭터 확장·마케팅·튜토리얼 도구(30+ 호출 지점)의 registry metadata에
  기록. 합성 도구(`asset_generate_tileset`, `asset_generate_effect_sheet`)는 단가를
  타일/프레임 수만큼 곱해 집계하고 formula에 내역 표기.
- **HTTP 모드 stateful 세션** — `/mcp`가 initialize 요청에 응답할 때 `mcp-session-id`를
  반환하고, 후속 요청은 같은 세션·같은 `McpServer` 인스턴스로 라우팅됨. `GET /mcp`(SSE
  재개), `DELETE /mcp`(세션 종료), `GET /health`는 `active_sessions` 반환.
- README·PROCESS.md에 v2.0+ 도구 레퍼런스 20여 종 추가 (환경·UI·이펙트·마케팅 확장·
  canon·계획 섹션 신설).
- `scripts/experiments/README.md` — 실험 스크립트 용도 표.

### 🔧 Changed

- **MCP 서버 버전이 런타임에 `package.json`에서 로드** — 기존 `"1.0.0"` 하드코딩 제거.
  stdio 배너와 `/health` 응답 모두 실제 패키지 버전 반영.
- **Gemini 서비스가 실제 사용 모델을 반환** — `generateImageGemini` / `generateVideoGemini`
  반환 타입에 `model` 추가. 레지스트리 `provider`가 `gemini-imagen-4.0-generate-001` /
  `gemini-veo-3.0-generate-001` 처럼 정확해지고 `metadata.model`에 모델 ID 보존.
- `asset_generate_image_openai` description — 실제 기본 모델(`gpt-image-1-mini`)과 선택
  정책(저비용 vs 고품질 gpt-image-2) 문서화.
- `asset_generate_image_gemini` title/description — "Imagen 3" → "Imagen 4".
- `asset_batch_generate_images` / `asset_generate_image` auto-provider 규칙 — v2.0 실제
  동작에 맞춰 "모든 타입 기본 OpenAI" 문서화 (기존 description의 `background → Gemini`
  오기 제거).
- `src/services/claude-vision.ts` → **`src/services/vision-qc.ts`** 리네임. 파일명이
  실제 구현(Gemini 2.5 Flash Vision)과 불일치하던 점 해소. import 경로 일괄 업데이트.
- `scripts/` 최상위 실험 스크립트 7개를 `scripts/experiments/`로 이동. npm publish·CI
  양쪽에서 유틸 코드와 명확히 구분.

### 🐛 Fixed

- **stdio 모드 stdout 오염** — `src/tools/font.ts`의 `console.log` 4건을 `console.error`로
  교체. `asset_convert_font_to_bitmap` 실행 시 MCP JSON-RPC 프레임이 손상되던 회귀
  (v1.0.1 수정의 재발) 해결.

### 📦 Dependencies

- `@anthropic-ai/sdk` 제거 — 실사용 0건. `npx` 콜드스타트 / 설치 용량 감소.

### 📚 Docs

- `README.md` 비용·성능 추적 섹션, HTTP 모드 섹션 신설.
- `PROCESS.md` 디렉토리 구조·워크플로우·도구 테이블·AI 모델 분담·크로마키 전략을
  v2.1 현실에 맞춰 갱신.

---

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
