---
name: minigame-assets-status
description: Use this skill when the user asks about current progress, project status, what to do next, or is lost/confused in the asset generation workflow. Triggers on phrases like "지금 뭐 해야 해", "어디까지 했지", "현재 상태", "다음 할 일", "진행 상황", "도와줘", "뭐부터 시작", "status", "what's next", "progress", "where am I", "help me continue", "lost".
version: 2.1.0
---

# Minigame Assets — 현재 상태 & 다음 할 일

사용자가 "어디까지 했지?" / "지금 뭐 해야 해?" / "진행 상황" 류 질문을 하면 이 스킬의 절차를 따라 **대시보드를 구성**해 답하세요.

## 절차 (4단계 순차 실행)

### Step 1: 프로젝트 스캔
```
asset_analyze_project
  project_path: "."        # 또는 사용자가 지정한 경로
  scan_asset_refs: true
```

추출할 정보:
- `engine`, `confidence` — 어떤 엔진인지
- `three_path_entry.path_recommendation` — A(GAME_DESIGN) / B(CONCEPT.md) / C(미설정)
- `has_game_design`, `has_concept_md`, `has_size_spec`, `has_asset_plan`
- `canon_count`, `generated_asset_count`

### Step 2: 생성된 에셋 목록
```
asset_list_assets
  output_dir: "./.minigame-assets"
  asset_type: "all"
  limit: 200
```

타입별로 집계: character, sprite, background, ui, effect, marketing 등.
총 비용은 `metadata.est_cost_usd` 합산.

### Step 3: 누락 에셋
```
asset_list_missing  output_dir: "./.minigame-assets"
```

우선순위 높은 3-5개 항목만 강조.

### Step 4: (선택) display-size 스캔 상태
프로젝트에 게임 코드가 있으면:
```
asset_scan_display_sizes  project_path: "."
```
생성 크기가 실제 display 와 맞는지 확인.

## 대시보드 출력 형식

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Minigame Assets — 현재 상태
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

📋 프로젝트
  경로: /Users/.../my-game
  엔진: Phaser 3 (confidence 100%)
  경로 선택: B (CONCEPT.md 기반)

📝 문서
  CONCEPT.md          ✅
  game-concept.json   ✅
  asset_size_spec     ⬜ (권장)
  GAME_DESIGN.json    ⬜ (선택, 경로 A 필요 시)
  Canon 등록:          3개

🎨 생성된 에셋 (총 47개, ~$1.82)
  character:   3
  sprite:     20  (hero: 9, enemy: 6, boss: 5)
  background:  5
  ui:         12
  logo:        1
  thumbnail:   1
  effect:      5

⚠️  누락 (우선순위 순)
  1. boss_dragon 스프라이트 (hurt, die 액션)
  2. ui_button_shop
  3. app_logo dark variant
  4. parallax_far 배경 3종

💡 추천 다음 단계
  1. asset_generate_sprite_sheet  character_name: "boss_dragon"
     actions: ["hurt", "die"]  base_character_path: "...boss_dragon_base.webp"
  2. asset_scan_display_sizes     (코드 있으면 실행)
  3. asset_review mode: "standard"  target_path: ".minigame-assets/sprites"
     (생성 완료된 에셋 품질 확인)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

## 상황별 라우팅

사용자 상태가 다음과 같으면 해당 슬래시 커맨드·스킬 안내:

| 상태 | 추천 |
|------|------|
| 완전 새 프로젝트 | `/create-minigame-assets` |
| 기존 게임 코드 + 에셋 없음 | `/setup-minigame-assets-concept` |
| CONCEPT.md 있고 생성 중 | Step 4 의 "다음 단계" 중 우선순위 1 실행 |
| 생성은 많이 했는데 품질 의심 | `minigame-assets-review` 스킬 |
| 용량/포맷 이슈 | `minigame-assets-optimize` 스킬 |
| 스타일이 튀기 시작 | `minigame-assets-style-consistency` 스킬 |
| 예산 걱정 | `minigame-assets-cost` 스킬 |
| 생성은 됐는데 게임에 어떻게 넣는지 모르겠음 | `minigame-assets-engine-load` 스킬 |

## 짧은 답 원할 때

사용자가 간단히 물으면 (`"지금 뭐 해?"` 처럼) 대시보드 전체 대신 압축 답:

```
CONCEPT.md ✅ / 에셋 47개 / 누락 4개
→ 다음: boss_dragon 스프라이트 생성 (hurt, die)
```

## 사용자가 CONCEPT 도 없으면

"처음부터 만들어야 하는 상황" — 다음 중 하나 추천:
- 새 프로젝트: `/create-minigame-assets`
- 기존 코드에 에셋만 추가: `/setup-minigame-assets-concept`

두 커맨드 모두 CONCEPT.md 생성부터 시작하니까 안전.

## 연관 리소스

- 기존 슬래시 커맨드 `/minigame-assets-help` 도 동일 대시보드 — 사용자가 명시적으로 원하면 그쪽으로 안내
- 구체 작업은 `minigame-assets-workflow` 스킬에서 단계별 가이드
