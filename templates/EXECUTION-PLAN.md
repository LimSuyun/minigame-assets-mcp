
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

> **프로세스**: 정면 베이스 이미지(gpt-image-1) → 각 액션 스프라이트(Gemini 편집)

#### 1. 캐릭터명 (character_id) — 타입: player/enemy/boss
- [ ] **베이스 생성**: `asset_generate_character_base` — provider: openai, model: gpt-image-1, transparent background
  - character_name: `character_id`
- [ ] **스프라이트 생성**: `asset_generate_sprite_sheet` — provider: gemini (각 액션별 편집)
  - actions: [idle, walk, run, attack, hurt, die]
  - export_formats: [individual, phaser]

---

### Step 3. 무기 생성

> **프로세스**: gpt-image-1로 투명 배경 아이콘 생성

- [ ] **무기명 (weapon_id)**: `asset_generate_weapons` — gpt-image-1, transparent background

---

### Step 4. 배경 생성

> **프로세스**: Gemini Imagen으로 배경 이미지 생성

- [ ] **배경명 (background_id)**: `asset_generate_image_gemini` — asset_type: background

---

## 완료 체크리스트

- [ ] Step 1: CONCEPT.md 확인
- [ ] Step 2: 캐릭터 N개 생성 (베이스 + 스프라이트)
- [ ] Step 3: 무기 N개 생성
- [ ] Step 4: 배경 N개 생성

---

## 참고 도구 목록

| 도구 | 용도 |
|------|------|
| `asset_generate_character_base` | 캐릭터 정면 베이스 생성 (gpt-image-1, 투명) |
| `asset_generate_sprite_sheet` | 캐릭터 액션 스프라이트 시트 (Gemini) |
| `asset_generate_weapons` | 무기 아이콘 일괄 생성 (gpt-image-1, 투명) |
| `asset_generate_image_gemini` | 배경 이미지 생성 (Gemini) |
| `asset_edit_character_design` | 캐릭터 디자인 수정 후 자동 재생성 |
| `asset_remove_background` | 배경 제거 (투명 PNG) |
| `asset_list_assets` | 생성된 에셋 목록 조회 |
