---
name: minigame-assets-workflow
description: Use this skill whenever the user asks to generate game assets — sprites, characters, weapons, backgrounds, UI, logos, thumbnails, music, or any art/sound for a game — via the minigame-assets MCP (tools prefixed with `asset_`). Enforces the CONCEPT-first workflow so CONCEPT.md is created from planning docs before any generation tool fires. Triggers on phrases like "게임 에셋 만들어줘", "스프라이트 생성", "create game assets", "generate sprites", "make a character for my game".
version: 2.1.0
---

# Minigame Assets — CONCEPT-First Workflow

게임 에셋 생성은 **항상 컨셉부터** 시작합니다. `asset_*` 도구를 호출하기 전에 아래 체크를 수행하세요.

## Step 0: 컨셉 탐색 (필수)

생성 요청을 받으면, 어떤 도구를 호출하기 전에 다음 순서로 **반드시** 컨셉을 찾아보세요.

1. 현재 작업 디렉터리에 `CONCEPT.md` 또는 `game-concept.json` 존재 여부 확인 (Read/Glob)
2. `asset_get_concept` 도구로 저장된 컨셉 조회
3. 기획 문서 탐색: `README.md`, `GDD.md`, `GAME_DESIGN.md`, `game-design.md`, `design-doc.md`, `master-plan.md`, `docs/*.md`, `_bmad-output/**/*.md` 등
4. `package.json` / 소스 코드에서 엔진 힌트 (Phaser, Unity, Cocos, Godot) 수집

**컨셉이 이미 있으면**: 추가 질문 없이 바로 Step 0.5로 진행. 사용자가 `CONCEPT.md` 를 이미 작성해 뒀다면 그걸 신뢰하세요.

**없으면**: `asset_create_concept_md` 를 호출해 `CONCEPT.md` + `game-concept.json` 을 생성. 기획 문서에서 최대한 정보를 추출한 뒤 부족한 필드만 짧게 질문하세요. **절대 `asset_create_concept` (JSON-only 레거시) 는 쓰지 말 것** — `_md` 버전이 표준이며 `base_style_prompt`, `characters[]`, `weapons[]`, `backgrounds[]` 까지 구조화된 필드를 담습니다.

## Step 0.5: 코드 기반 크기 스캔 (권장)

게임 프로젝트에 **이미 코드가 있으면** 생성 전에 `asset_scan_display_sizes` 를 호출해 실제 런타임 표시 크기를 파악하세요. 예:

```
asset_scan_display_sizes
  project_path: "."
```

감지 예시:
- `add.sprite(x, y, 'hero').setDisplaySize(64, 64)` → `hero` 64×64 으로 표시됨 → 생성 크기 128×128 권장 (2× 헤드룸)
- `.setScale(0.5)` → 1024 소스가 512 로 축소 표시됨 → 1024 생성 적합
- Cocos `setContentSize`, Godot `Vector2(scale)` 도 지원

결과의 `suggested_generation_size` 를 각 `asset_generate_*` 호출의 `size` 파라미터로 전달:

```
asset_generate_character_base
  character_name: "hero"
  size: "128x128"   ← 스캔 결과 사용
  ...
```

코드가 없는 새 프로젝트이거나 크기 힌트가 없는 경우는 이 단계를 건너뛰고 기본값(1024×1024)으로 생성.

## Step 1~N: 표준 생성 순서

| # | 도구 | 기본 AI | 메모 |
|---|------|---------|------|
| 1 | `asset_create_concept_md` | — | CONCEPT.md + game-concept.json |
| 2 | `asset_generate_execution_plan` | — | 엔진 감지 + 체크리스트 |
| 3 | `asset_generate_character_base` | gpt-image-2 | 마젠타 크로마키 → 투명, `role` 파라미터 활용 |
| 3.5 | `asset_generate_character_equipped` | gpt-image-2 edit | 장비 착용 베이스 합성 (선택) |
| 4 | `asset_generate_weapons` | gpt-image-1 | 네이티브 투명 배경 |
| 5 | `asset_generate_sprite_sheet` | gpt-image-2 edit | **Sequential anchor+prev** 패턴 기본 (각 프레임이 anchor + 직전 프레임 두 reference 로 합성 → 디자인 동결 + 모션 연속성). 디폴트 `frames_per_action: 5`, 액션별 매트릭스 (idle:5, walk:6, run:6, jump:5, attack:5, hurt:5, die:6). 첫 프레임 자동 quality_check. `auto_compose_sheet: true` 기본 → `_sheet.{webp\|png}` 자동 생성. 옛 동작 원하면 `sequential_mode: "off"` |
| 6 | `asset_generate_screen_background` / `_loading_screen` / `_lobby_screen` | gpt-image-2 | **spec-aware** — `target_size` 또는 `asset_size_spec.json` 의 `backgrounds.full` 자동 적용. parallax 레이어는 gpt-image-1 (네이티브 투명) |
| 7 | `asset_generate_app_logo`, `asset_plan_thumbnail` → `asset_generate_thumbnail` | — | 마케팅 — **반드시 캐릭터·배경·타이틀 텍스트 PNG가 준비된 뒤** 호출. `character_image_paths` / `background_image_path` / `title_text_image_path` 를 함께 넘기면 재사용·일관성 보장 |
| 8 | `asset_review`, `asset_validate`, `asset_list_missing`, `asset_generate_atlas_json` | — | 품질 검토 + Atlas |
| 9 | `asset_approve` → `asset_deploy` | — | 승인된 마스터만 코드 경로로 리사이즈 복사 |

## Step 9: 승인 → 배포 (마스터 ↔ 배포본 분리)

생성된 모든 에셋은 `.minigame-assets/` 의 **마스터(원본)** 으로만 존재합니다. 실제 게임 코드가 쓰는 리사이즈본은 **명시적 승인 후** `asset_deploy` 가 코드 경로로 복사합니다. 배포본에 기초 디자인 파일이 그대로 올라가는 걸 방지하는 구조.

**모든 `asset_generate_*` 결과는 자동으로 `.minigame-assets/deploy-map.json` 에 `approved: false` 로 등록됩니다.** 사용자가 해야 할 것:

1. `asset_scan_display_sizes project_path: "."` — 코드에서 기대되는 크기·경로 스캔 (`asset_urls` 포함)
2. `deploy-map.json` 의 각 엔트리에 `deploy_targets: [{ path, width, height, fit, format }]` 채우기 (Read → Edit)
3. 품질 확인(`asset_review`) 후 승인:
   ```
   asset_approve  entries: ["characters/char_female.png", "weapons/sword.png"]
   # 또는
   asset_approve  entries: "all"
   ```
4. 배포:
   ```
   asset_deploy  project_root: "."   # dry_run: true 먼저 권장
   ```
   - 마스터가 이후 재생성되면 `master_hash ≠ approved_hash` 로 `needs_reapproval` 경고 → `asset_approve` 재호출 필요
   - 동일 바이트가 이미 있으면 재작성 스킵 (`unchanged`) — 빌드 친화적
   - `force: true` 로 승인 게이트를 무시할 수 있지만, 불안정한 중간본이 코드에 섞일 수 있어 테스트용으로만 사용

**배포 결과물은 git 포함, 마스터는 gitignore** — `.gitignore` 템플릿이 이미 이 구조를 따릅니다 (`.minigame-assets/` 제외 + `deploy-map.json`·`*.md` 는 예외로 포함).

## 명시적 진입 슬래시 커맨드

사용자가 전체 워크플로를 돌리고 싶다고 하면 아래 중 하나를 권장:

- **`/create-minigame-assets`** — 새 프로젝트용 (컨셉 생성부터 전체)
- **`/setup-minigame-assets-concept`** — 기존 게임 프로젝트 분석 + 누락 에셋 생성
- **`/minigame-assets-help`** — 현재 상태 대시보드

## 중요 규칙 (요약)

- CONCEPT.md 의 `base_style_prompt` 는 모든 이미지 생성의 접두사 — 스타일·색상·질감을 영문으로 구체적으로 작성
- 한국어/짧은 프롬프트만 있을 땐 각 도구의 `refine_prompt: true` 로 GPT-5.4-nano 확장 활성화
- 이미지 생성에는 `OPENAI_API_KEY` (필수) / `GEMINI_API_KEY` (parallax·video 시 필요) 환경변수가 있어야 함
- 컨셉 파일 경로는 `CONCEPT_FILE` (기본 `./.minigame-assets/game-concept.json`), `CONCEPT_MD_FILE` (기본 `./.minigame-assets/CONCEPT.md`) 환경변수로 오버라이드 가능

## 주제별 세부 스킬

이 워크플로 중 특정 주제가 나오면 해당 스킬이 자동으로 함께 트리거됩니다:

| 질문/상황 | 트리거되는 스킬 |
|----------|-------------|
| "어디까지 했지?", "지금 뭐 해야 해" | `minigame-assets-status` (현재 상태 대시보드) |
| "용량 줄이고 싶어", "WebP 쓸까?", "너무 커" | `minigame-assets-optimize` |
| "품질 확인", "검증", "마젠타 잔류" | `minigame-assets-review` |
| "스타일 일관성", "같은 캐릭터 유지" | `minigame-assets-style-consistency` |
| "Phaser 로딩 코드", "Unity import" | `minigame-assets-engine-load` |
| "비용 얼마야", "어떤 모델이 싸?" | `minigame-assets-cost` |
