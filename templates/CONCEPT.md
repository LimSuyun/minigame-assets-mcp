# [게임 이름] - Game Concept
> 생성일: YYYY-MM-DD

---

## 게임 정보

| 항목 | 내용 |
|------|------|
| **장르** | 장르를 입력하세요 |
| **플랫폼** | 플랫폼을 입력하세요 (mobile, PC, web 등) |
| **엔진** | 게임 엔진을 입력하세요 (Phaser 3, Unity, Cocos Creator, Godot 등) |
| **설명** | 게임 전체 설명 및 분위기 |
| **name_slug** | (선택) ASCII 영문 슬러그 — 한글/공백이 들어간 game_name 시 강력 권장 (파일명·디렉터리 안전화). 예: "dongtoesa" |

---

## 아트 스타일

- **스타일**: 아트 스타일을 입력하세요 (예: 2D 카툰, 픽셀아트, 핸드드로운)
- **색상 팔레트**: #hex1, #hex2, #hex3
- **레퍼런스**: 참고 게임이나 스타일 (선택사항)

---

## BASE STYLE PROMPT

> 모든 이미지 생성 시 이 프롬프트를 앞에 추가합니다. (영문)

```
아트 스타일 설명 프롬프트를 영문으로 입력하세요.
예: 2D cartoon game sprite, bold black outlines, flat colors with cel shading
```

---

## 에셋 목록

> **`layer` 컬럼 안내**: 해당 에셋이 런타임에 배치될 Phaser Scene/Layer. 자세한 구조는 `docs/layer-system.md` 참조.
> - **Scene 레벨**(depth 체계 밖): `Scene:Loading`, `Scene:Lobby` 등
> - **Layer 0~5**: 단일 GameScene 내부 depth. 0(배경) / 1(타일) / 2(유닛) / 3(투사체) / 4(이펙트) / 5(UI)

### 캐릭터 (Characters)

> 스프라이트 시트로 생성됩니다. `타입`은 `asset_generate_character_base`의 **`role`** 파라미터로 전달되어 역할별 실루엣·컬러·디테일 가이던스가 자동 주입됩니다.

| ID | 타입 (role) | 이름 | 설명 | 필요 액션 | layer |
|----|------|------|------|---------|-------|
| 식별자 | player / enemy / monster / npc | 이름 | 외형 설명 (영문 프롬프트용) | idle, walk, attack, death 등 | `2` (유닛) |

> 💡 장비 착용 버전 스프라이트가 필요한 경우 `asset_generate_character_equipped`로 베이스 + 무기/방어구를 합성한 후 sprite_sheet에 전달하세요. 장비 착용본도 `layer: 2`.

### 무기 / 투사체 (Weapons / Projectiles)

> 단일 프레임 아이콘으로 생성됩니다. (투명 배경). 런타임 용도에 따라 layer가 달라집니다 — 발사되면 Layer 3, 인벤토리 아이콘이면 Layer 5.

| ID | 이름 | 설명 | 용도 | layer |
|----|------|------|------|-------|
| 식별자 | 이름 | 외형 설명 (영문 프롬프트용) | projectile / inventory | `3` 또는 `5` |

### 배경 (Backgrounds)

> 전체 화면 배경으로 생성됩니다. static은 단일 depth, parallax는 sub-depth 0.0/0.1/0.2.

| ID | 이름 | 설명 | style | layer |
|----|------|------|-------|-------|
| 식별자 | 이름 | 배경 설명 (영문 프롬프트용) | static / parallax | `0` (배경) |

### 화면 (Screens) — Scene 레벨

> **Scene 단위** 풀스크린 배경. depth 체계 밖.

| ID | 이름 | 설명 | 생성 도구 | scene |
|----|------|------|---------|-------|
| loading | 로딩 화면 | 하단 20% 프로그레스 영역 | `asset_generate_loading_screen` | `Scene:Loading` |
| lobby | 로비/메인 메뉴 | menu_side 영역 UI 자리 | `asset_generate_lobby_screen` | `Scene:Lobby` |

### UI 요소 (UI Elements)

| ID | 이름 | 설명 | layer |
|----|------|------|-------|
| 식별자 | 이름 | UI 요소 설명 | `5` (UI) 또는 UIScene 분리 |

### 이펙트 (Effects)

> 스프라이트 시트로 생성됩니다.

| ID | 이름 | 프레임 수 | 설명 | layer |
|----|------|---------|------|-------|
| 식별자 | 이름 | N | 이펙트 설명 | `4` (이펙트) |

### 타일 (Tiles)

| ID | 이름 | 설명 | layer |
|----|------|------|-------|
| 식별자 | 이름 | 타일 설명 | `1` (맵/타일) |

### 오디오 (Audio)

> Scene/Layer 체계와 무관.

| ID | 종류 | 설명 |
|----|------|------|
| 식별자 | BGM/SFX | 설명 |

---

## 생성 가이드

### 캐릭터 생성 순서
1. `asset_generate_character_base` — 정면 베이스 생성 (gpt-image-2, 마젠타 크로마키 → 투명)
2. `asset_generate_sprite_sheet` — 각 액션별 프레임 생성 (gpt-image-2 edit, **Sequential anchor+prev** 패턴, 액션별 5+ 프레임 매트릭스, `chroma_key_bg: magenta` 권장)

### 무기/투사체 생성
1. `asset_generate_weapons` — 투명 배경 아이콘 생성 (gpt-image-1, 네이티브 투명)

### 배경 생성
1. `asset_generate_screen_background` — gpt-image-2, **spec-aware** (`target_size` 또는 `asset_size_spec.json` 의 `backgrounds.full` 자동 적용 + sharp cover-crop). parallax 투명 레이어는 gpt-image-1 네이티브 투명

### 마케팅 (Stage 6 — 마지막 단계)
> 캐릭터·배경 PNG 가 모두 준비된 뒤 호출. 워드마크는 한 번 만들어 모든 마케팅 산출물에 재사용.
1. `asset_generate_title_text` — 타이틀 워드마크 PNG 단독 생성 (재사용 자산)
2. `asset_generate_app_logo` — 캐릭터/대표 + 워드마크 합성 (gpt-image-2 edit)
3. `asset_plan_thumbnail` → `asset_generate_thumbnail` — 배경·캐릭터 + 워드마크 합성

### 에셋 검증
1. `asset_validate` — 네이밍 규칙 + 파일 스펙 + **비율 호환성** (`size_spec_file` 지정 시) 검사
2. `asset_list_missing` — 누락 파일 확인
3. `asset_generate_atlas_json` — 스프라이트 시트 Atlas JSON 생성

### 배포 (옛 v3.0.x 프로젝트 마이그레이션 시)
1. `asset_consolidate_registry` — 분산 sub-registry / sub-deploy-map 흡수
2. `asset_approve` → `asset_deploy` — `auto_fill_targets: true` 기본으로 spec 자동 채움
