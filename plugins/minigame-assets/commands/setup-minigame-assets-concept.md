---
description: 기존 게임 프로젝트 분석 — 엔진 자동 감지, CONCEPT.md 복원/생성, 누락 에셋 파악 후 플랜 기반 생성까지 실행합니다.
---

# 기존 게임 프로젝트 에셋 분석 및 생성 워크플로우

기존 게임 프로젝트를 분석하여 누락된 에셋을 파악하고 생성합니다.

## 1단계: 프로젝트 경로 확인

사용자에게 게임 프로젝트 루트 경로를 확인하세요. 현재 작업 디렉토리일 수도 있습니다.

## 2단계: 프로젝트 분석

`asset_analyze_project` 도구로 프로젝트를 스캔합니다.

```
project_path: <프로젝트 경로>
scan_asset_refs: true
```

결과에서 확인:
- 감지된 엔진 (Phaser / Unity / Cocos / Godot)
- 기존 에셋 디렉토리
- 코드에서 참조된 에셋 목록
- 권장 출력 설정 (export_formats, output_dir)

## 3단계: 컨셉 설정

기존 `CONCEPT.md` 또는 `game-concept.json`이 있으면 `asset_get_concept`로 불러옵니다.

없으면 프로젝트명과 코드에서 파악한 분위기를 바탕으로 `asset_create_concept_md`로 컨셉을 생성합니다.

## 4단계: 에셋 플랜 생성

`asset_generate_asset_plan` 도구로 누락 에셋 플랜을 생성합니다.

```
project_path: <프로젝트 경로>
output_file: <출력 경로>/asset-plan.json
concept_file: <game-concept.json 경로>
```

이 도구는 자동으로:
1. 디자인 문서 탐색 (CONCEPT.md, GDD.md, README.md 등)
2. 코드에서 참조된 미싱 에셋 추출
3. 에셋별 프롬프트 + 생성 파라미터 포함한 플랜 파일 저장

`prompt_source` 값으로 품질 확인:
- `"design_doc"` — 기획 문서 기반 (품질 높음)
- `"concept_generated"` — 컨셉 기반 자동 생성 (검토 권장)
- `"generic"` — 기본 프롬프트 (필요 시 수동 수정)

## 5단계: 에셋 생성

asset-plan.json의 priority 순서대로 생성합니다.

### 캐릭터 스프라이트
1. `asset_generate_character_base` — 정면 베이스 (gpt-image-2, 마젠타 크로마키 → 투명). **role** 지정 권장: player/enemy/monster/npc
2. (선택) `asset_generate_character_equipped` — 베이스 + 장비(Step 무기/방어구)를 다중 레퍼런스로 합성 → 장비 착용 베이스
3. `asset_generate_sprite_sheet` — 액션 스프라이트 일괄 생성 (gpt-image-2 edit, chroma_key_bg: magenta 권장, 1행 가로 스트립 기본)
   - base_character_path: 베이스 OR equipped 이미지
   - export_formats는 2단계 분석 결과의 권장값 사용

### 무기 아이콘
`asset_generate_weapons` — gpt-image-1, 투명 배경 (네이티브, 빠른 경로 유지)

### 배경 + 화면 이미지
- `asset_generate_screen_background` — gpt-image-2 (불투명 static) / parallax 투명 레이어는 gemini
- `asset_generate_loading_screen` — 로딩 화면 (하단 20% 프로그레스 영역)
- `asset_generate_lobby_screen` — 로비/메인 메뉴 (menu_side로 UI 자리)

### 기타 이미지 (UI 등)
`asset_batch_generate_images` — asset-plan.json의 params 값 사용 (기본: openai/gpt-image-2)

### 음악
`asset_generate_music_local` — 로컬 AudioCraft 서버 실행 중인 경우

## 6단계: 품질 검토 + 검증

### 품질 검토 (권장)
```
asset_review          ← 구조·크로마 잔류·비주얼 AI 종합 검토
  target_path: <.minigame-assets 또는 특정 캐릭터 폴더>
  mode: "standard"    (quick / standard / deep)
  output_report_path: "./reviews/project_review.md"
```

### 스펙 검증 + Atlas 생성
```
asset_validate        ← 네이밍 규칙 + 파일 스펙 검사
asset_list_missing    ← 누락 에셋 재확인
asset_generate_atlas_json  ← 엔진별 Atlas JSON 생성
```

### 엔진별 Atlas 사용 예시

**Phaser 3**
```javascript
this.load.atlas('hero', 'hero_sheet.png', 'hero_phaser.json');
this.add.sprite(x, y, 'hero', 'hero_idle_f00');
```

**Unity**
```
// Texture Import Settings → Sprite Mode: Multiple
// Sprite Editor: Slice by Cell Size (unity.json 참고)
```

**Cocos Creator**
```javascript
spriteFrameCache.addSpriteFramesWithFile('character_cocos.plist');
const frame = spriteFrameCache.getSpriteFrame('hero_idle_f00.png');
```

**Godot**
```gdscript
var texture = load("res://assets/sprites/hero_idle_f00.png")
$AnimatedSprite2D.frames.add_frame("idle", texture)
```
