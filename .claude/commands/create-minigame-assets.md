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

## 3단계: 캐릭터 베이스 생성

`asset_generate_character_base` 도구로 각 캐릭터의 정면 베이스 이미지를 생성합니다.

- AI: OpenAI gpt-image-1
- 투명 배경 PNG
- CONCEPT.md의 base_style_prompt 활용

## 4단계: 스프라이트 시트 생성

`asset_generate_sprite_sheet` 도구로 각 캐릭터의 액션 스프라이트를 생성합니다.

- AI: Gemini Imagen (캐릭터 베이스 이미지 편집)
- 기본 액션: idle, walk, run, attack, hurt, die
- 엔진별 Atlas JSON 자동 생성

## 5단계: 무기 아이콘 생성

`asset_generate_weapons` 도구로 무기 아이콘을 일괄 생성합니다.

- AI: OpenAI gpt-image-1
- 투명 배경 PNG
- CONCEPT.md의 무기 목록 자동 참조

## 6단계: 배경 이미지 생성

`asset_generate_image_gemini` 도구로 배경 이미지를 생성합니다.

- AI: Gemini Imagen 4
- 16:9 비율 권장

## 7단계: 마케팅 에셋 생성 (선택)

### 앱 로고 (600×600px)
`asset_generate_app_logo` 도구 사용

- color_scheme: "both" (light + dark 두 버전)
- character_image_paths: 3단계에서 생성한 캐릭터 이미지 경로

### 썸네일 (1932×828px)
`asset_plan_thumbnail` → `asset_generate_thumbnail` 순서로 진행

1. `asset_plan_thumbnail`로 구성 계획 및 프롬프트 작성 (생성 없음)
2. 계획 확인 후 `asset_generate_thumbnail`로 실제 생성

## 8단계: 검증

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
| 캐릭터 베이스 | `asset_generate_character_base` | gpt-image-1 (투명 배경) |
| 스프라이트 | `asset_generate_sprite_sheet` | Gemini Imagen |
| 무기 | `asset_generate_weapons` | gpt-image-1 (투명 배경) |
| 배경 | `asset_generate_image_gemini` | Gemini Imagen 4 |
| 로고 | `asset_generate_app_logo` | gpt-image-1 / Gemini |
| 썸네일 계획 | `asset_plan_thumbnail` | — |
| 썸네일 생성 | `asset_generate_thumbnail` | gpt-image-1 |
| 음악 | `asset_generate_music_local` | 로컬 AudioCraft |
| 영상 | `asset_generate_video_gemini` | Gemini Veo |
| 검증 | `asset_validate`, `asset_list_missing` | — |
