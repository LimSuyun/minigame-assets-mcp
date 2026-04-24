---
description: 현재 프로젝트의 에셋 생성 진행 상황 대시보드 — 엔진·컨셉·에셋·누락 항목을 종합해 다음 할 일을 안내합니다.
---

# 미니게임 에셋 MCP — 현재 상태 확인 & 사용법 안내

현재 프로젝트의 에셋 생성 진행 상황을 확인하고, 다음에 무엇을 해야 하는지 안내합니다.

---

## 실행 순서

아래 순서대로 도구를 호출하여 데이터를 수집한 뒤, 대시보드 형태로 출력하세요.

### Step 1: 프로젝트 전체 스캔

`asset_analyze_project` 도구를 호출합니다.

```
project_path: (현재 작업 디렉토리 또는 사용자가 지정한 경로)
scan_asset_refs: true
```

반환값에서 확인:
- `three_path_entry.path_recommendation` — A(GAME_DESIGN.json) / B(CONCEPT.md) / C(미설정)
- `has_game_design`, `has_concept_md`, `has_size_spec`, `has_asset_plan`
- `canon_count`, `generated_asset_count`
- 감지된 엔진 정보

### Step 2: 생성된 에셋 목록 조회

`asset_list_assets` 도구를 호출합니다.

```
output_dir: (프로젝트의 에셋 출력 경로, 기본: ./.minigame-assets)
```

반환값에서 asset_type별로 집계:
- character, sprite, background, ui, effect, sound, marketing 등

### Step 3: 누락 에셋 확인

`asset_list_missing` 도구를 호출합니다.

```
output_dir: (에셋 출력 경로)
```

반환값에서:
- 누락된 에셋 ID 목록
- 우선순위 높은 누락 항목 3~5개 추출

### Step 4: 데이터 종합 후 대시보드 출력

수집한 모든 데이터를 아래 형식으로 출력하세요.

---

## 출력 형식

```
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  Minigame Assets MCP — 현재 상태 대시보드
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[프로젝트 진입 경로]
  (Path A / B / C 중 하나와 그 이유를 표시)
  예: Path A — GAME_DESIGN.json 감지됨 ("게임명", preset)
  예: Path B — CONCEPT.md 감지됨, GAME_DESIGN.json 없음
  예: Path C — 문서 없음, 위자드로 시작 필요

[프로젝트 문서 현황]
  ✅/⬜ GAME_DESIGN.json   → 게임명 / 미생성
  ✅/⬜ asset_size_spec.json → preset명 (tile_size, screen_w×h)
  ✅/⬜ FULL_ASSET_PLAN.md  → 총 N개 에셋 계획 / 미생성
  ✅/⬜ CONCEPT.md          → 있음 / 없음

[Canon 현황]
  ✅/⬜ 게임 로고            canon/logo/...
  ✅/⬜ 스타일 레퍼런스 시트  canon/style/...
  ✅/⬜ 캐릭터: (각 ID)      canon/characters/.../base_master.png
  ✅/⬜ 무기: (각 ID)        canon/weapons/.../icon_master.png
  (없으면 "Canon 에셋 없음" 표시)

[에셋 생성 현황 — Stage별]
  Stage 0 (Canon/기반):  ████████░░  N% (X/Y)
  Stage 1 (캐릭터):      ██░░░░░░░░  N% (X/Y)
  Stage 2 (환경/배경):   ░░░░░░░░░░   N% (X/Y)
  Stage 3 (이펙트):      ░░░░░░░░░░   N% (X/Y)
  Stage 4 (UI):          ░░░░░░░░░░   N% (X/Y)
  Stage 5 (사운드):      ░░░░░░░░░░   N% (X/Y)
  Stage 6 (마케팅):      ░░░░░░░░░░   N% (X/Y)
  ──────────────────────────────────────────
  전체:                  ████░░░░░░  N% (X/총Y 완료)
  
  (FULL_ASSET_PLAN.md가 없으면 생성된 에셋 수만 표시)

[수정/보완이 필요한 항목]
  (asset_list_missing 결과 기반, 우선순위 높은 순)
  ⚠️ (에셋 ID) — (이유: Canon 미등록 / 파일 없음 / 스펙 불일치 등)
  ⚠️ ...
  (없으면 "누락 에셋 없음 ✅" 표시)

[다음 권장 작업 (3가지)]
  → (구체적인 다음 작업 — 어떤 도구로 무엇을 생성해야 하는지)
  → ...
  → ...

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  사용법 안내
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

[처음 시작 (Path 안내)]
  Path A (권장): GAME_DESIGN.json이 있으면 자동으로 전체 계획 생성
    → "에셋을 만들어주세요" 또는 "asset_plan_from_project 실행해주세요"
  Path B: CONCEPT.md만 있는 경우
    → "CONCEPT.md로 에셋 생성 시작해주세요"
  Path C: 아무것도 없는 경우
    → "새 게임 에셋을 처음부터 만들어주세요"

[특정 에셋 생성]
  "hero 스프라이트 시트를 만들어주세요"
  "배경을 forest 테마로 만들어주세요"
  "BGM을 생성해주세요"
  "UI 버튼 세트를 만들어주세요"
  "마케팅 썸네일을 만들어주세요"

[Canon 관련]
  "게임 로고를 Canon으로 등록해주세요"
  "스타일 레퍼런스 시트를 만들어주세요"
  "hero Canon 일관성을 검증해주세요"

[상태 확인 명령]
  "현재 상태를 보여주세요"   → 이 스킬 (/minigame-assets-help)
  "누락된 에셋이 뭐야?"      → asset_list_missing 실행
  "에셋 목록을 보여줘"       → asset_list_assets 실행
  "프로젝트를 분석해줘"      → asset_analyze_project 실행

[에셋 품질 / 수정]
  "이 이미지의 배경을 제거해주세요"
  "캐릭터 디자인을 수정해주세요" → asset_edit_character_design
  "스프라이트 일관성을 검증해주세요" → asset_validate

[사용 가능한 전체 도구 카테고리]
  기획/설계:   asset_create_concept_md, asset_generate_execution_plan,
               asset_generate_asset_plan, asset_plan_from_project,
               asset_generate_size_spec
  Canon:       asset_generate_character_base (→ Canon 등록),
               asset_validate (일관성 검증)
  캐릭터:      asset_generate_character_base, asset_generate_sprite_sheet,
               asset_generate_action_sprite, asset_generate_character_portrait,
               asset_generate_character_card, asset_generate_avatar_parts
  스프라이트:  asset_generate_character_weapon_sprites
  환경:        asset_generate_parallax_set, asset_generate_tileset,
               asset_generate_props_set, asset_generate_interactive_objects
  이펙트:      asset_generate_effect_sheet, asset_generate_floating_text,
               asset_generate_status_effect_icons
  UI:          asset_generate_ui_structural, asset_generate_button_set,
               (기타 UI 도구)
  사운드:      asset_generate_bgm, asset_generate_sfx, asset_generate_music_local
  마케팅:      asset_generate_thumbnail, asset_generate_app_logo,
               asset_generate_store_screenshots, asset_generate_store_banner,
               asset_generate_social_media_pack
  튜토리얼:   asset_generate_tutorial_overlays, asset_generate_guide_npc
  폰트:        asset_convert_font_to_bitmap
  유틸:        asset_list_assets, asset_list_missing, asset_validate,
               asset_remove_background, asset_generate_atlas_json
```

---

## 특이사항 처리

- **프로젝트 문서가 전혀 없는 경우:** "아직 프로젝트가 설정되지 않았습니다. `/create-minigame-assets` 또는 `새 게임 에셋을 만들어주세요`로 시작하세요."
- **GAME_DESIGN.json은 있지만 에셋이 전혀 없는 경우:** "에셋 생성을 시작하시겠습니까? `asset_plan_from_project`로 전체 계획을 먼저 세우는 것을 권장합니다."
- **FULL_ASSET_PLAN.md가 없는 경우:** Stage별 진행률 대신 현재까지 생성된 에셋 수와 asset_type별 집계만 표시
- **Canon 에셋이 없는 경우:** "Stage 0 (Canon 기반 확립)부터 시작을 권장합니다." 안내
