# Changelog

이 프로젝트의 주요 변경 사항. SemVer 를 따르며, BREAKING 항목은 명시적으로 표시한다.

## 3.1.0 — 2026-04-27

> 마케팅 자산 합성 흐름 개편 + 워크플로 순서 정정 + registry/deploy-map 통합. SemVer 상 일부 BREAKING 항목이 포함되어 있으나 외부 호출 흔적이 없어 보수적으로 minor bump 로 발행.

### ✨ 신규 도구
- **`asset_generate_title_text`** — 게임 타이틀(워드마크) 만 담긴 투명 배경 PNG 1장 단독 생성. 로고/썸네일/로딩 화면에서 `title_text_image_path` 로 재사용해 일관성·비용 절감.
- **`asset_consolidate_registry`** — v3.0.x 이전 도구로 분산된 sub `assets-registry.json` / `deploy-map.json` 을 프로젝트 루트(`.minigame-assets/`) 한 곳으로 흡수. 멱등.

### 🔄 동작 변경 (마케팅 합성 파이프라인 개편)
- **`asset_generate_app_logo`** — 종전 SVG 텍스트 사후 오버레이 방식 폐기. 워드마크 PNG + 캐릭터/대표 이미지를 gpt-image-2 edit 입력으로 함께 투입해 통합 합성. `character_image_paths` 미제공 시 대표 이미지 자동 생성.
- **`asset_generate_thumbnail`** — 종전 SVG 텍스트 사후 오버레이 방식 폐기. 워드마크 PNG 를 마지막 레퍼런스로 함께 투입해 합성 (layout=`characters_spread` 만 텍스트 미투입).
- 두 도구 모두 새 입력 추가:
  - `brand_color?` — 워드마크 색상 (hex 또는 색명; 미지정 시 theme/art_style 로부터 자동 추론)
  - `title_text_image_path?` — 이미 만든 워드마크 PNG 재사용 (재생성 비용 0)
  - `name_slug?` — ASCII 영문 슬러그 (한글 game_name 시 권장)

### 📐 사이즈 정합성 보강 — spec-aware 파이프라인
실 게임 테스트에서 발견된 "spec 정의된 사이즈 ↔ 실 마스터 사이즈 미스매치 → setDisplaySize 시 stretch" 문제 해결.

- **`asset_generate_screen_background`** — 옛 버그 수정: `aspect_ratio` 입력이 무시되고 `1024x1024` 하드코딩되던 문제 해결.
  - 신규 입력 `target_size: "WxH"` (예: "390x844") — 명시 시 가장 가까운 OpenAI 지원 사이즈로 생성 후 sharp cover-crop + resize 로 정확히 target 사이즈 출력.
  - `size_spec_file` 입력 추가 — 미명시 시 `asset_size_spec.json` 의 `backgrounds.full` (또는 parallax 레이어별 spec) 자동 적용.
  - 우선순위: `target_size` > `size_spec(backgrounds.full)` > `aspect_ratio`.
  - 출력 자산 metadata 에 `target_size`, `target_display`, `spec_key`, `ai_size`, `size_reason` 기록.
- **`asset_deploy`** — spec auto-fallback 도입.
  - 기존: `entry.deploy_targets.length === 0` 이면 `skipped: "no_targets"` 로 영구 패스 (사용자가 직접 채워야 함).
  - 신규: `auto_fill_targets: true` (기본) 이면 `asset_size_spec.json` + 자산 경로 패턴으로 spec 자동 추론하여 `public/assets/<카테고리>/<파일명>` 으로 in-memory 채움 → 즉시 배포.
  - 응답에 `auto_filled[]` 섹션 추가 (어떤 자산이 어떤 spec 키 기준으로 자동 채워졌는지).
  - in-memory 채움은 deploy-map.json 에 저장 안 함 — 사용자가 명시적으로 `deploy_targets` 채우는 흐름 유지.
- **`asset_validate`** — 비율 호환성 검사 추가.
  - 신규 입력 `size_spec_file`, `ratio_tolerance_pct` (기본 5).
  - 자산 경로 → spec 매핑하여 마스터 비율 vs spec 비율 비교, tolerance 초과 시 `ratio_mismatch` 경고 (setDisplaySize stretch 위험 사전 진단).
  - 마스터 픽셀 < spec 픽셀이면 `upscale_risk` 경고.
  - 응답에 `size_compatibility_warnings[]` 섹션.
- **신규 유틸 `src/utils/size-spec.ts`** — `loadSizeSpecFile`, `inferSpecKeyFromPath`, `lookupSpecEntry`, `specEntryToDeployTarget`, `compareRatio` 공통 헬퍼.

### 🎬 동작 변경 (스프라이트 시퀀스 패턴 개편)
- **`asset_generate_sprite_sheet`** — Anchor + Prev 이중 reference 시퀀스 패턴 도입.
  - 첫 프레임: anchor (= `pose_image ?? base_character_path`) 1개 reference 로 시작 포즈 생성
  - 이후 프레임: `[anchor, prev_frame]` 두 reference 로 디자인 동결 + 모션 연속성 동시 확보 → "왔다갔다" drift 거의 제거
  - 액션 단위 병렬 실행, 액션 내부는 직전 프레임 의존성 때문에 직렬
  - 신규 헬퍼 `buildSequentialFramePrompt` + `describeMotionStage` (액션·프레임 위치별 단계 묘사: "wind-up", "mid-stride", "impact", "follow-through" 등)
- **신규 입력**:
  - `sequential_mode: "anchor_prev" | "off"` (기본 `anchor_prev`). `off` 면 옛 독립 패턴 (병렬 가능, 일관성↓)
  - `first_frame_quality_check: boolean` (기본 `true`) — 첫 프레임만 자동 Claude Vision 검증 + OpenAI fallback 으로 시퀀스 토대 보호
  - `auto_compose_sheet: boolean` (기본 `true`) — 개별 PNG 에 더해 합성 시트 (`_sheet.{webp|png}`) 항상 생성
- **디폴트 변경**:
  - `frames_per_action`: 1 → **5** (글로벌 최소). sequential 모드 + 사용자 미지정 시 액션별 매트릭스 적용 (`idle:5, walk:6, run:6, jump:5, attack:5, hurt:5, die:6`). 사용자가 5 미만으로 명시해도 sequential 모드에서는 5 로 강등.
  - `export_formats`: `["individual"]` → `["individual", "phaser"]` — Phaser atlas JSON 기본 동반.
- **비용·시간 영향** (의도된 BREAKING): 1캐릭터 7액션 기준 ~7콜 → ~35콜, 시간 ~3.5분 → ~5~10분, 비용 ~$0.35 → ~$1.5~2.0. 옛 동작을 원하면 `sequential_mode: "off"` + `frames_per_action: 1`.

### 🧹 데이터 모델 정합성
- **registry / deploy-map 통합** — 어떤 sub-dir 을 `output_dir` 로 받아도 `resolveRegistryRoot()` 가 `.minigame-assets/` 한 곳으로 모아 등록. `marketing/app-icon/assets-registry.json` 같은 sub-registry 분산이 더 이상 발생하지 않음.
- **`relative_path` 자동 부착** — 등록 시 registry 루트 기준 POSIX 상대경로를 함께 저장 (프로젝트 이동/머신 동기화 안전).
- **`provider` 표기 통일** — `openai/<model>` 슬래시 형식. 기존 `openai-gpt-image-2`, `openai-gpt-image-1`, `openai-edit`, `openai-sora`, `local_musicgen`, `sharp_svg` 등 비표준 표기 모두 정정. `provider: "openai"` 단독 케이스는 등록 시 자동으로 `openai/<metadata.model>` 로 보강.
- **CONCEPT 에 `name_slug` 필드 추가** — 한글/공백 game_name 의 파일명 안전화. 미지정 시 한글 보존 슬러그로 fallback.

### 📋 워크플로 순서 정정
- `asset_generate_app_logo` 를 Stage 0 (Canon) → **Stage 6 (Marketing)** 으로 이동. 캐릭터·배경·타이틀 텍스트 자산이 모두 준비된 뒤 마지막에 합성하는 정공 순서로 통일.
- 영향 받은 곳: `asset-requirements.ts` 의 `app_logo.stage`, `design-doc.ts` 의 `stageRecommendations` / `Stage 0` 마크다운 표 / 메뉴 화면 자산 priority, `SKILL.md` Step 7, `create-minigame-assets.md`, `minigame-assets-help.md`, `cost SKILL.md`, `docs/workflow.md`, `docs/internals/process.md`, `docs/tools.md`.
- `output_dir` 시멘틱 일관화 — registry/deploy-map 은 항상 프로젝트 루트로 통합된다는 점을 도구 description 에 명시.

### ⚠️ BREAKING (의도적, 외부 호출 흔적 없음)
- `asset_generate_app_logo` / `asset_generate_thumbnail` 의 **`add_text` 입력 제거**. 명시 호출 시 zod strict 로 reject. 텍스트 처리는 "타이틀 텍스트 PNG 합성 입력" 패턴으로 일원화.
- 두 도구의 **결과 이미지 톤·비용·소요 시간 변화** — gpt-image-1-mini 단발 → gpt-image-2 edit 다중 합성. 시각적으로도 다름.
- `asset_generate_sprite_sheet` 의 **디폴트 동작 변경** — `frames_per_action` 1 → 5, `sequential_mode` 기본 `anchor_prev`, `auto_compose_sheet` 기본 true, `export_formats` 기본 `[individual, phaser]`. 사용자가 명시 안 한 호출의 비용·시간이 약 5× 증가. 옛 동작을 원하면 `sequential_mode: "off"` + `frames_per_action: 1`.
- `asset_generate_screen_background` 의 **출력 사이즈 변경** — 옛 항상 1024×1024 → 이제 `target_size`/`asset_size_spec.json`/`aspect_ratio` 우선순위로 결정해 정확히 그 사이즈로 출력. 기존 사용자가 별도 후처리에 의존했다면 동작 차이 발생 가능 (개선 의도).
- `asset_deploy` 의 `auto_fill_targets` 기본 true — 옛 `no_targets` 로 패스되던 entry 가 spec 이 있으면 자동 배포됨. 사용자가 의도적으로 미배포 상태 유지하려면 `auto_fill_targets: false` 명시 필요.
- 마이그레이션: 기존 분산 sub-registry 가 있던 프로젝트는 `asset_consolidate_registry` 한 번 호출로 자동 통합 (`dry_run: true` 로 미리보기 가능).

### 🛠 내부 정리
- 신규 유틸: `src/utils/registry-root.ts`, `src/utils/slug.ts`, `src/utils/title-text.ts`
- `GeneratedAsset` 인터페이스에 `relative_path?: string` 필드 추가
- `*.tgz` 를 `.gitignore` 에 추가
- 빌드·타입체크·단위 테스트 23/23 통과

---

## 3.0.2 — 2026-04 (hotfix)
- **fix(desc)!**: 도구 description 의 기본 경로 안내를 `.minigame-assets/` 하위로 sync.

## 3.0.1 — 2026-04 (hotfix)
- **fix(detector)!**: `.minigame-assets/` 탐지 복원, CHANGELOG 정리.

## 3.0.0 — 2026-04
- masters/deploy split + manifest-based approval workflow (Phase 2)
- 기본 자산 출력 경로를 `.minigame-assets/` 로 마이그레이션 (Phase 1)

(과거 2.x 버전의 상세 내역은 git log 참조)
