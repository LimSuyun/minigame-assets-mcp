---
name: minigame-assets-style-consistency
description: Use this skill when the user wants to maintain visual consistency across multiple generated assets — same character appearance across scenes, unified art style, color palette coherence across the whole project. Triggers on phrases like "스타일이 달라", "같은 캐릭터", "일관성", "Canon", "레퍼런스", "style drift", "inconsistent style", "style reference", "same look".
version: 2.1.0
---

# Minigame Assets — 스타일 일관성 유지

에셋이 쌓일수록 스타일이 흩어지는 문제를 세 가지 축으로 잡습니다.

## 1. `base_style_prompt` — 프로젝트 전체의 공통 접두사

`CONCEPT.md` 의 `base_style_prompt` 필드는 모든 이미지 생성 시 프롬프트 앞에 자동으로 붙는 **스타일 고정자**입니다. 여기에 반드시 포함할 것:

- **아트 스타일 명시**: 예 `"hand-drawn watercolor"`, `"16-bit pixel art"`, `"flat vector illustration"`
- **색상 팔레트 대표 컬러**: 주요 3–5개 hex 코드
- **텍스처 특성**: grain, outline 두께, stroke 색상
- **조명 방향**: "top-left light source, bottom-right drop shadow" 등
- **금지 요소**: 배제할 스타일 (다른 게임 이름, 사실적 사진 등)

예시 (잘 쓴 case):
```
Korean bunsik-themed hand-drawn watercolor, warm orange #FF6B35 main with
cream ivory #FFF4E6, egg-yolk #FFD166 highlights, warm brown #5C3A21 outline
at 2px, cold-press paper grain, soft watercolor bleeds, single top-left light
source, Cozy Grove + Night in the Woods reference. Avoid cyan-blue in #0055D4
range, no photorealism.
```

## 2. Canon 시스템 — "이미 생성한 에셋을 레퍼런스로 재사용"

새로 만드는 에셋이 이전 캐릭터와 비슷해 보이게 하려면:

**등록**:
```
asset_register_canon
  asset_id: "hero_kim"
  canonical_path: ".minigame-assets/characters/sprites/hero_kim/hero_kim_base.webp"
  role: "player_hero"
  description: "55yo Korean male shop owner, warm orange apron, round friendly face"
```

**조회**:
```
asset_list_canon                # 등록된 전체 레퍼런스
asset_get_canon asset_id: "hero_kim"  # 특정 레퍼런스 상세
```

**사용**: `asset_generate_character_pose`, `asset_generate_character_views` 등의 `canonical_path` 파라미터로 전달 → 해당 이미지를 multi-reference 편집으로 주입해 동일 인물로 생성.

**권장**: 각 주요 캐릭터의 `_base` 생성 직후 바로 canon 등록.

## 3. 스타일 레퍼런스 시트

```
asset_generate_style_reference_sheet
  canon_ids: ["hero_kim", "sunja_npc"]
```

- 각 캐릭터의 3-view (front / 3/4 / side)
- 주요 오브젝트 아이콘 샘플
- 색상 팔레트 스와치
→ 한 장으로 묶어 스타일 레퍼런스 제공

이후 생성 시 이 시트를 레퍼런스 이미지로 전달하면 스타일 drift 억제.

## 4. asset_validate_consistency — 사후 검증

```
asset_validate_consistency
  asset_paths: ["...", "..."]
```
Gemini Vision 이 여러 에셋을 비교해 스타일·팔레트 일관성 점수 반환. 임계값 미만이면 재생성 권유.

## 워크플로 권장 순서

```
1. CONCEPT.md 의 base_style_prompt 작성 — 3-5줄 진지하게
2. 첫 캐릭터 베이스 생성 → 마음에 들면 asset_register_canon
3. 스타일 레퍼런스 시트 1장 생성 (asset_generate_style_reference_sheet)
4. 이후 모든 캐릭터 생성 시 canonical_path 로 기존 canon 을 레퍼런스 전달
5. 대량 생성 후 asset_validate_consistency 로 일관성 점수 확인
```

## 흔한 실수

- `base_style_prompt` 가 한 줄짜리 추상 표현 ("cartoon style") — 너무 약해서 drift 억제 안됨
- canon 등록 안 하고 매번 새 프롬프트로 캐릭터 생성 → 매번 약간 다른 얼굴
- 첫 생성 때 여러 캐릭터를 동시에 생성 → 서로 상호 참조 불가 → 각자 드리프트

## 연관 스킬

- **스타일이 아예 틀어져 버렸을 때 재생성 전략**: `minigame-assets-workflow` Step 3 참조
- **일관성 점수 해석**: `minigame-assets-review`
