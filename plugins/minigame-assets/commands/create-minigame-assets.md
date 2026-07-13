---
description: 새 게임 프로젝트용 — 컨셉 정의부터 캐릭터·스프라이트·배경·UI·마케팅 에셋까지 전체 생성 워크플로를 단계별로 실행합니다.
---

# 새 게임 에셋 생성 워크플로우

새 게임 프로젝트의 에셋을 처음부터 생성합니다.

## 1단계: 게임 컨셉 정의

`asset_create_concept_md` 도구를 호출하여 CONCEPT.md와 game-concept.json을 생성합니다.

**직접 질문하기 전에 먼저 다음 순서로 정보를 자동 수집하세요:**

1. 현재 디렉토리의 `CONCEPT.md` 또는 `game-concept.json` 탐색
2. `asset_get_concept` 도구로 저장된 컨셉 확인
3. `README.md`, `GAME_DESIGN.md` 등 문서 파일 탐색
4. 위에서 정보를 찾지 못한 경우에만 사용자에게 질문

**수집할 정보:**
- game_name, genre, theme, art_style, color_palette
- characters[], weapons[], backgrounds[] (에셋 목록)
- base_style_prompt (일관된 스타일 유지용 핵심 프롬프트)

> CONCEPT.md가 이미 있으면 추가 질문 없이 바로 다음 단계로 진행하세요.

## 2단계: 실행 계획 생성

`asset_generate_execution_plan` 도구를 호출합니다.

- CONCEPT.md를 읽어 에셋 목록 파악
- 게임 엔진 감지 (Phaser / Unity / Cocos / Godot)
- EXECUTION-PLAN.md 생성 (체크리스트 형식)

## 2.5단계: 비주얼 컨셉 확립 (전자동 — 사람 선택 없음)

텍스트 컨셉(CONCEPT.md)을 **시각적 기준(canon 앵커 세트)**으로 변환하는 단계입니다.
"공들인 키 비주얼 하나가 모든 파생물의 퀄리티를 결정한다" — 이후 모든 Stage가 이 앵커를 기준으로 생성됩니다.

**A. 키 비주얼 후보 생성 (K=3)**
`asset_generate_image`를 구도 프리셋 3종(hero_shot / scene_wide / character_closeup)으로 각 1회 호출합니다.
- 각 프롬프트 = base_style_prompt + 구도 프리셋 + 효과 억제 지시(텍스트·워터마크·UI·과도한 글로우 금지)
- 파일명: `key_visual_candidate_01.png` ~ `_03.png`

**B. 자동 선별 → canon 등록**
```
asset_select_best
  image_paths: [후보 3개 경로]
  purpose: "key visual for <게임명> — master style anchor"
  register_as_canon: true
  canon_type: "other"
  canon_name: "key_visual"
```
- 루브릭: style_fit / composition / clarity / technical (손가락 수·좌우 구분 등 해부학 감점 포함)
- `all_below_threshold: true`가 반환되면 후보를 **1회만** 재생성 후 재선별 (그래도 미달이면 최고점 후보로 진행하고 리포트에 기록)

**C. 대표 캐릭터·배경 분리 추출**
선정된 키 비주얼을 기준으로 `asset_generate_with_reference` 2회 호출:
- 대표 캐릭터 단독 (canon_type: "character", register_as_derived: true)
- 대표 배경/환경 단독 (canon_type: "background", register_as_derived: true)

**D. 팔레트 역주입 + 스타일 시트**
- `asset_extract_palette`로 키 비주얼의 실제 팔레트 추출 → CONCEPT.md의 color_palette 갱신
- `asset_generate_style_reference_sheet`로 canon 세트 시각화

> 이 단계 완료 후 3단계 이후의 캐릭터·배경·UI 생성 시, 여기서 만든 canon을 레퍼런스로 활용하세요
> (`asset_generate_character_base`의 스타일 근거, `asset_generate_with_reference`의 canon_id 등).

## 3단계: 캐릭터 베이스 생성

`asset_generate_character_base` 도구로 각 캐릭터의 정면 베이스 이미지를 생성합니다.

- AI: OpenAI **gpt-image-2** (기본) — 마젠타 크로마키 자동 적용 → 투명 PNG
- 대안: `model: "gpt-image-1"` 명시 시 네이티브 투명 (더 빠르나 디테일 낮음)
- **`role` 파라미터 활용**: `player` / `enemy` / `monster` / `npc` / `generic` — 역할별 실루엣·컬러·디테일 가이던스 자동 주입
- CONCEPT.md의 base_style_prompt 활용
- 짧은 한국어/간단한 설명이면 `refine_prompt: true`로 GPT-5.4-nano가 상세 영문 확장

## 3.5단계 (선택): 장비 결합 베이스 생성

플레이어가 특정 장비(무기·방어구·액세서리)를 착용한 상태의 스프라이트 시트가 필요한 경우:

`asset_generate_character_equipped` 도구로 **장비 착용 베이스**를 생성합니다.

- 입력: 3단계 베이스 PNG + 4단계(아래)의 장비 아이콘 PNG들 (최대 4개)
- gpt-image-2 edit API에 다중 레퍼런스로 전달 → 장비 착용한 새 베이스 생성
- 결과물은 투명 PNG (마젠타 크로마키 + residue 패스 자동)
- 5단계 스프라이트 시트에 그대로 재사용 가능: `base_character_path: hero_equipped_base.png`

예시 흐름:
```
3단계: asset_generate_character_base → hero_base.png
4단계: asset_generate_weapons → sword.png, shield.png
3.5단계: asset_generate_character_equipped(
    base_character_path=hero_base.png,
    equipment_image_paths=[sword.png, shield.png],
    equipment_description="wielding sword in right hand, shield in left hand"
) → hero_equipped_base.png
5단계: asset_generate_sprite_sheet(base_character_path=hero_equipped_base.png)
```

## 4단계: 무기 아이콘 생성

`asset_generate_weapons` 도구로 무기 아이콘을 일괄 생성합니다.

- AI: OpenAI gpt-image-1 (유지 — 투명 배경 네이티브로 빠른 경로)
- 투명 배경 PNG
- CONCEPT.md의 무기 목록 자동 참조

## 5단계: 스프라이트 시트 생성

`asset_generate_sprite_sheet` 도구로 각 캐릭터의 액션 스프라이트를 생성합니다.

- AI: OpenAI **gpt-image-2 edit** (기본) — 캐릭터 베이스 이미지 편집으로 포즈 변환
- **Sequential anchor+prev 패턴 (기본)**: 첫 프레임은 anchor 1개 reference, 이후는 [anchor, prev_frame] 두 reference → 디자인 동결 + 모션 연속
- `chroma_key_bg: "magenta"` 자동 권장 (외곽선 내부 포켓 residue 제거)
- 기본 액션: idle, walk, run, attack, hurt, die
- 디폴트 `frames_per_action: 5` + 액션별 매트릭스 (idle:5, walk:6, run:6, jump:5, attack:5, hurt:5, die:6)
- **레이아웃 기본: 1행 가로 스트립** (`sheet_cols` 미지정 시 cols = frames.length). 2행 그리드 원하면 `sheet_cols: Math.ceil(N/2)` 지정
- `auto_compose_sheet: true` 기본 → `_sheet.{webp|png}` + Phaser atlas json 자동 동반
- 첫 프레임 `first_frame_quality_check: true` 기본 → OpenAI Vision QC + fallback 으로 시퀀스 토대 보호
- ⏱️ 프레임당 ~30-60초, 액션 간 병렬·액션 내 직렬 → 7액션 × 5+ 프레임 ≈ 5~10분/캐릭터
- 옛 동작 원하면 `sequential_mode: "off"` + `frames_per_action: 1`

## 6단계: 배경 + 화면 생성

### 게임 씬 배경
`asset_generate_screen_background`
- AI: OpenAI **gpt-image-2** (기본, static 배경) — 디테일·텍스트 품질 우수, 불투명 PNG
- **spec-aware 사이즈 (v3.1.0+)**: `target_size` (예: "390x844") 또는 `asset_size_spec.json` 의 `backgrounds.full` 자동 적용 → sharp cover-crop 으로 정확한 사이즈 출력. setDisplaySize 시 stretch 발생 방지.
- parallax 모드 (far/mid/near 레이어): mid/near 는 gpt-image-1 네이티브 투명. 각 레이어는 `parallax_far/mid/near` spec 자동 적용

### 로딩 화면
`asset_generate_loading_screen`
- AI: gpt-image-2 (불투명 풀스크린)
- 하단 20-25% 시각적으로 조용하게 생성 (프로그레스 바 영역)
- 히어로 이미지를 `hero_image_path`로 전달 시 그 캐릭터 기반 합성

### 로비/메인 메뉴 화면
`asset_generate_lobby_screen`
- AI: gpt-image-2 (불투명 풀스크린)
- `menu_side: left/right/center/bottom`으로 UI가 놓일 영역 지정 → 해당 영역 조용하게 생성
- 히어로 이미지 쇼케이스 (선택)

## 7단계: 마케팅 에셋 생성 (마지막 단계)

> **반드시 이 시점까지 캐릭터·배경 PNG가 모두 준비되어 있어야 합니다.** 로고/썸네일은 그 자산을 레퍼런스로 합성하는 마지막 단계입니다.
> 타이틀 텍스트(워드마크) PNG는 첫 호출 시 `.minigame-assets/title_text/` 에 자동 생성·저장되며, 이후 호출에서는 `title_text_image_path` 로 재사용해 비용을 절약하고 로고/썸네일 간 일관성을 유지합니다.

### 앱 로고 (600×600px)
`asset_generate_app_logo` 도구 사용

- color_scheme: "both" (light + dark 두 버전)
- character_image_paths: 3단계에서 생성한 캐릭터 이미지 경로 (필수에 가까움)
- brand_color: 워드마크 색상 (선택, hex/색명) — 미지정 시 theme/art_style로부터 자동 추론
- title_text_image_path: (선택) 이미 만든 워드마크 PNG 재사용

### 썸네일 (1932×828px)
`asset_plan_thumbnail` → `asset_generate_thumbnail` 순서로 진행

1. `asset_plan_thumbnail`로 구성 계획 및 프롬프트 작성 (생성 없음)
2. 계획 확인 후 `asset_generate_thumbnail`로 실제 생성:
   - gpt-image-2 edit, **`[배경, 캐릭터들…, 타이틀 텍스트]` 순서**로 다중 레퍼런스 투입
   - 종전의 SVG 텍스트 사후 오버레이는 제거됨 — 텍스트도 합성 시점의 입력으로 함께 들어감
   - `character_image_paths` / `background_image_path` / `brand_color` / `title_text_image_path` 입력 권장
   - layout: `characters_spread` 는 텍스트 미투입 (전면 액션 컷)

## 8단계: 품질 검토 + 검증

### 품질 검토 (권장 — 대량 생성 후)
`asset_review` 도구로 생성된 에셋 품질 종합 검토:

```
asset_review
  target_path: ".minigame-assets/sprites/hero"
  mode: "standard"   # quick / standard / deep
  character_hint: "chibi boy adventurer with red tunic"
  output_report_path: "./reviews/hero_review.md"
```

체크 항목:
- **구조**: 해상도, 파일 크기, 알파 채널 (투명 기대 에셋)
- **크로마 잔류**: 마젠타 #FF00FF 잔류 픽셀 정량 측정 + 최대 클러스터 크기
- **비주얼 AI** (standard/deep): 전신 가시성, 배경 클린, 캐릭터 해부학, 단일 캐릭터 (OpenAI gpt-4.1-mini Vision)

### 스펙 검증 + Atlas 생성
```
asset_validate        ← 네이밍 규칙 + 파일 스펙 검사
asset_list_missing    ← 누락 에셋 확인
asset_generate_atlas_json  ← 스프라이트 Atlas JSON 생성
```

## 도구 참조

| 단계 | 도구 | AI |
|------|------|----|
| 컨셉 | `asset_create_concept_md` | — |
| 실행 계획 | `asset_generate_execution_plan` | — |
| 키 비주얼 후보 | `asset_generate_image` (구도 프리셋 ×3) | **gpt-image-2** |
| **후보 자동 선별** | `asset_select_best` (루브릭 채점 → canon 자동 등록) | OpenAI gpt-4.1-mini Vision |
| 캐릭터/배경 분리 | `asset_generate_with_reference` (키 비주얼 기준) | **gpt-image-2 edit** |
| 팔레트 역주입 | `asset_extract_palette` | — |
| 캐릭터 베이스 | `asset_generate_character_base` (role 지원) | **gpt-image-2** (마젠타 크로마키 → 투명) |
| 장비 결합 베이스 | `asset_generate_character_equipped` | **gpt-image-2 edit** (다중 레퍼런스 합성) |
| 스프라이트 | `asset_generate_sprite_sheet` (Sequential anchor+prev, 1행 기본) | **gpt-image-2 edit** (마젠타 크로마키, frames_per_action 5+ 매트릭스) |
| 타이틀 워드마크 | `asset_generate_title_text` | **gpt-image-2** + 마젠타 크로마키 → 투명 PNG (재사용 자산) |
| 무기 | `asset_generate_weapons` | gpt-image-1 (투명 배경, 네이티브) |
| 배경 | `asset_generate_screen_background` | **gpt-image-2** (spec-aware 사이즈, parallax 레이어는 gpt-image-1 투명) |
| 로딩 화면 | `asset_generate_loading_screen` | **gpt-image-2** (히어로 레퍼런스 지원) |
| 로비 화면 | `asset_generate_lobby_screen` | **gpt-image-2** (menu_side 지정) |
| 로고 | `asset_generate_app_logo` | **gpt-image-2** (타이틀 텍스트 PNG + 캐릭터/대표 이미지 → edit 통합 합성) |
| 썸네일 계획 | `asset_plan_thumbnail` | — |
| 썸네일 생성 | `asset_generate_thumbnail` | **gpt-image-2 edit** (배경·캐릭터 + 타이틀 텍스트 PNG 다중 레퍼런스 합성) |
| 음악 | `asset_generate_music_local` | 로컬 AudioCraft |
| **품질 검토** | `asset_review` | OpenAI gpt-4.1-mini Vision (비주얼) + 비 AI (구조·크로마) |
| 검증 | `asset_validate` (size_spec_file 지정 시 비율 호환성), `asset_list_missing` | — |
| 마이그레이션 | `asset_consolidate_registry` | 분산 sub-registry 통합 |
| 배포 | `asset_approve` → `asset_deploy` (auto_fill_targets 기본 true) | spec-aware 자동 채움 |
| 프롬프트 확장 | 각 이미지 도구의 `refine_prompt: true` | **GPT-5.4-nano** (짧은 입력 상세화) |
