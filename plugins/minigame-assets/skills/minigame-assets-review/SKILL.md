---
name: minigame-assets-review
description: Use this skill when the user wants to verify quality of generated assets — chroma key residue, transparency issues, anatomy, full body visibility, spec conformance, or missing files. Triggers on phrases like "품질 확인", "검증", "리뷰", "마젠타 잔류 있어", "스펙 검사", "에셋 검토", "review assets", "validate", "check quality", "chroma residue".
version: 2.1.0
---

# Minigame Assets — 품질 검토 & 검증

세 가지 도구가 서로 보완적으로 작동합니다 — 비주얼 AI 검토 · 스펙 검증 · 누락 탐지.

## 1. asset_review — 비주얼 + 구조 종합

```
asset_review
  target_path: "generated-assets/sprites/hero"
  mode: "standard"          # quick / standard / deep
  character_hint: "chibi boy with red tunic"
  output_report_path: "./reviews/hero_review.md"
```

모드별 차이:

| 모드 | 체크 | 비용 |
|------|------|------|
| `quick` | 구조(해상도, 파일 크기, 알파 채널), 크로마 잔류 측정 | 거의 무료 (AI 호출 없음) |
| `standard` | quick + 비주얼 AI (Gemini 2.5 Flash): 전신 가시성, 배경 clean, 해부학, 단일 캐릭터 | ~$0.02 per asset |
| `deep` | standard + 프레임 간 일관성, 포즈 변화 검증 | ~$0.05 per asset |

체크 항목 자세히:
- **구조**: 해상도, 파일 크기, 알파 채널 (투명 기대 에셋)
- **크로마 잔류**: 마젠타 #FF00FF 잔류 픽셀 정량 + 최대 클러스터 크기 (임계값 초과 시 flag)
- **비주얼 AI**: 클리핑, 배경 오염, 캐릭터 수(단일 캐릭터 정책), 얼굴/손발 온전성

## 2. asset_validate — 스펙 & 네이밍 검증

```
asset_validate
  target_dir: "generated-assets"
```

하드 룰 검사 (AI 미사용, 즉시 반환):
- 네이밍 규칙 (snake_case, 허용 prefix)
- 파일 포맷 (.png / .webp)
- 투명도 존재 여부 (스프라이트는 alpha 필수)
- 사이즈 일치 (asset_size_spec.json 의 기대 크기)

## 3. asset_validate_consistency — 스타일 일관성

여러 에셋 간 아트 스타일 일관성 검증 (Gemini Vision):
```
asset_validate_consistency
  asset_paths: ["generated-assets/sprites/hero_base.webp",
                "generated-assets/sprites/enemy_base.webp"]
```

스타일 불일치 감지 시 `minigame-assets-style-consistency` 스킬 참조.

## 4. asset_list_missing — 누락 탐지

```
asset_list_missing  output_dir: "./generated-assets"
```

CONCEPT.md 의 에셋 목록 대비 생성되지 않은 항목 반환.

## 일반 이슈 대응

| 증상 | 원인 | 해결 |
|------|------|------|
| 마젠타 픽셀 잔류 | 크로마키 제거 불완전 | `asset_refine_transparency` 로 재처리 |
| 배경이 안 지워짐 | 원본이 크로마키 없음 or 색상 미세 차이 | `asset_remove_background_batch` |
| 캐릭터 일부 잘림 | 생성 프롬프트에 "full body" 누락 | 재생성 시 프롬프트 보강 |
| 프레임 간 스타일 튐 | base_character_path 미사용 | sprite_sheet 에 `base_character_path` 반드시 전달 |
| 파일 크기 여전히 큼 | 엔진 미감지 → PNG 로 저장됨 | `minigame-assets-optimize` 스킬 참조 |

## 리뷰 워크플로 (권장)

대량 생성 직후:
```
1. asset_review mode: "quick"           (빠른 전체 스크린)
2. 문제 있는 부분만 mode: "standard"    (비주얼 AI 검토)
3. asset_validate                       (스펙 검사)
4. asset_list_missing                   (누락 확인)
```

## 연관 스킬

- **품질 이슈가 스타일 일관성 문제면**: `minigame-assets-style-consistency`
- **크기 이슈면**: `minigame-assets-optimize`
