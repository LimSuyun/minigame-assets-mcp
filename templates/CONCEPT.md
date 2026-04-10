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

### 캐릭터 (Characters)

> 스프라이트 시트로 생성됩니다.

| ID | 타입 | 이름 | 설명 | 필요 액션 |
|----|------|------|------|---------|
| 식별자 | player/enemy/boss/npc | 이름 | 외형 설명 (영문 프롬프트용) | idle, walk, attack, death 등 |

### 무기 / 투사체 (Weapons / Projectiles)

> 단일 프레임 아이콘으로 생성됩니다. (투명 배경)

| ID | 이름 | 설명 |
|----|------|------|
| 식별자 | 이름 | 외형 설명 (영문 프롬프트용) |

### 배경 (Backgrounds)

> 전체 화면 배경으로 생성됩니다.

| ID | 이름 | 설명 |
|----|------|------|
| 식별자 | 이름 | 배경 설명 (영문 프롬프트용) |

### UI 요소 (UI Elements)

| ID | 이름 | 설명 |
|----|------|------|
| 식별자 | 이름 | UI 요소 설명 |

### 이펙트 (Effects)

> 스프라이트 시트로 생성됩니다.

| ID | 이름 | 프레임 수 | 설명 |
|----|------|---------|------|
| 식별자 | 이름 | N | 이펙트 설명 |

### 오디오 (Audio)

| ID | 종류 | 설명 |
|----|------|------|
| 식별자 | BGM/SFX | 설명 |

---

## 생성 가이드

### 캐릭터 생성 순서
1. `asset_generate_character_base` — 정면 베이스 생성 (gpt-image-1, 투명 배경)
2. `asset_generate_sprite_sheet` — 각 액션별 프레임 생성 (Gemini 편집)

### 무기/투사체 생성
1. `asset_generate_weapons` — 투명 배경 아이콘 생성 (gpt-image-1)

### 배경 생성
1. `asset_generate_image_gemini` — asset_type: background

### 에셋 검증
1. `asset_validate` — 네이밍 규칙 + 파일 스펙 검사
2. `asset_list_missing` — 누락 파일 확인
3. `asset_generate_atlas_json` — 스프라이트 시트 Atlas JSON 생성
