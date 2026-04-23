
# [게임 이름] - 에셋 생성 실행 계획
> 생성일: YYYY-MM-DD

---

## 프로젝트 정보

| 항목 | 내용 |
|------|------|
| **게임 엔진** | Cocos Creator / Unity / Phaser / Godot / unknown |
| **에셋 출력 경로** | `./generated-assets` |
| **Export 포맷** | individual, phaser, cocos, unity |
| **플랫폼** | Mobile |

---

## 에셋 통계

| 카테고리 | 개수 |
|---------|------|
| 캐릭터 | N개 |
| 무기 | N개 |
| 배경 | N개 |
| **총합** | **N개** |

---

## 실행 순서

### Step 1. 컨셉 확인 ✅
- [x] CONCEPT.md 파일 확인 완료
- [x] BASE STYLE PROMPT 확인

---

### Step 2. 캐릭터 생성

> **프로세스**: 정면 베이스(gpt-image-2, 마젠타 크로마키) → [선택: 장비 결합] → 각 액션 스프라이트(gpt-image-2 edit, 1행 가로 스트립)

#### 1. 캐릭터명 (character_id) — 역할: player / enemy / monster / npc
- [ ] **베이스 생성**: `asset_generate_character_base` — provider: openai, model: gpt-image-2 (기본), **role**: player/enemy/monster/npc, magenta 크로마키 자동 적용 → 투명 PNG
  - character_name: `character_id`
  - role: 적절히 지정 (실루엣·컬러·디테일 가이던스 자동 주입)
- [ ] **(선택) 장비 결합**: `asset_generate_character_equipped` — 베이스 + 무기/방어구 PNG 다중 레퍼런스 합성
  - base_character_path: 위 베이스 파일 경로
  - equipment_image_paths: Step 3의 무기 PNG들 (최대 4개)
  - equipment_description: "wielding sword in right hand, round shield in left hand" 등
  - variant_name: "equipped" (기본) 또는 "sword_shield" 등
- [ ] **스프라이트 생성**: `asset_generate_sprite_sheet` — provider: openai, model: gpt-image-2 (각 액션별 편집), chroma_key_bg: magenta 권장
  - base_character_path: 베이스 OR equipped 이미지
  - actions: [idle, walk, run, attack, hurt, die]
  - frames_per_action: 1 (또는 애니메이션 프레임 수)
  - export_formats: [individual, phaser]
  - sheet_cols: 미지정 시 1행 가로 스트립 (기본)

---

### Step 3. 무기 생성

> **프로세스**: gpt-image-1로 투명 배경 아이콘 생성 (네이티브 투명, 빠른 경로 유지)

- [ ] **무기명 (weapon_id)**: `asset_generate_weapons` — gpt-image-1, transparent background

---

### Step 4. 배경 + 화면 생성

> **프로세스**: gpt-image-2로 배경·화면 이미지 생성 (불투명) / parallax 투명 레이어는 Gemini

- [ ] **게임 씬 배경 (background_id)**: `asset_generate_screen_background` — provider: openai, model: gpt-image-2, style: static
- [ ] **로딩 화면**: `asset_generate_loading_screen` — game_name, hero_image_path (선택), aspect_ratio: 16:9
  - 하단 20-25% 프로그레스 바 영역 자동 확보
- [ ] **로비/메인 메뉴 화면**: `asset_generate_lobby_screen` — game_name, menu_side: right (기본), hero_image_path (선택)
  - menu_side 영역은 시각적으로 조용하게 생성 → UI 배치 자리 확보

---

### Step 5. 품질 검토

- [ ] `asset_review` — 생성된 에셋 종합 검토
  - target_path: "generated-assets/sprites" 또는 특정 캐릭터 폴더
  - mode: "standard" (quick: 구조만 / standard: +비주얼 샘플 / deep: 전수 비주얼)
  - output_report_path: "./reviews/review.md"

---

## 완료 체크리스트

- [ ] Step 1: CONCEPT.md 확인
- [ ] Step 2: 캐릭터 N개 생성 (베이스 + [선택 장비결합] + 스프라이트)
- [ ] Step 3: 무기 N개 생성
- [ ] Step 4: 배경·로딩·로비 화면 생성
- [ ] Step 5: 품질 검토 (asset_review)

---

## 참고 도구 목록

| 도구 | 용도 |
|------|------|
| `asset_generate_character_base` | 캐릭터 정면 베이스 (gpt-image-2, role: player/enemy/monster/npc) |
| `asset_generate_character_equipped` | 베이스 + 장비 다중 레퍼런스 합성 → 새 베이스 |
| `asset_generate_sprite_sheet` | 캐릭터 액션 스프라이트 시트 (gpt-image-2 edit, 1행 가로 기본) |
| `asset_generate_weapons` | 무기 아이콘 일괄 생성 (gpt-image-1, 투명) |
| `asset_generate_screen_background` | 게임 씬 배경 (gpt-image-2 static / Gemini parallax 레이어) |
| `asset_generate_loading_screen` | 로딩 화면 (gpt-image-2, 하단 20% 프로그레스 영역) |
| `asset_generate_lobby_screen` | 로비/메인 메뉴 (gpt-image-2, menu_side로 UI 자리 지정) |
| `asset_review` | 생성 에셋 품질 검토 (구조·크로마·비주얼) |

---

## Phaser Scene / Layer 매핑

생성된 에셋이 런타임에서 어떤 Scene/Layer로 배치되는지 매핑표. 자세한 구조는 `docs/layer-system.md` 참조.

### Scene 레벨 (전환 단위, depth 체계 밖)
| Scene | 에셋 | 생성 도구 |
|-------|------|----------|
| `LoadingScene` | 로딩 화면 풀스크린 배경 | `asset_generate_loading_screen` |
| `LobbyScene` / `MenuScene` | 로비/메인 메뉴 풀스크린 | `asset_generate_lobby_screen` |
| `GameScene` | 실제 게임플레이 (하단 Layer 0~4 사용) | — |
| `UIScene` (stacked) | 게임 중 UI 오버레이 (Layer 5 역할) | `asset_generate_ui_*`, `asset_generate_hud_set` |

### GameScene 내부 Layer (setDepth)
| Layer | depth | 에셋 카테고리 | 주요 생성 도구 |
|-------|-------|-------------|--------------|
| UI | 5 | HP바·버튼·패널 | `asset_generate_ui_structural`, `asset_generate_hud_set`, `asset_generate_button_set` |
| 이펙트 | 4 | 폭발·스파크 | `asset_generate_effect_sheet` |
| 투사체 | 3 | 총알·미사일 (또는 무기 발사) | `asset_generate_weapons` (발사 용도) |
| 유닛 | 2 | 플레이어·적·몬스터·NPC | `asset_generate_character_base`, `asset_generate_character_equipped`, `asset_generate_sprite_sheet` |
| 맵/타일 | 1 | 타일맵·경로 | `asset_generate_tileset` |
| 배경 | 0 | 스테이지 배경 | `asset_generate_screen_background` (parallax 시 0.0/0.1/0.2) |

### 구현 팁
- 에셋 PNG 자체에는 레이어 정보 포함하지 않음. 런타임에 `setDepth(N)`으로 제어.
- UI는 별도 `UIScene`으로 분리하면 게임 로직과 독립 관리 가능.
- 패럴렉스 배경은 같은 Layer 0에서 sub-depth(0.0, 0.1, 0.2) 구분.
- 장비 착용 캐릭터는 `_equipped_base.png`가 Layer 2의 새 스프라이트로 등록.

---
| `asset_edit_character_design` | 캐릭터 디자인 수정 후 자동 재생성 |
| `asset_remove_background` | 배경 제거 (투명 PNG) |
| `asset_list_assets` | 생성된 에셋 목록 조회 |
