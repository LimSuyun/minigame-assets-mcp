# Changelog

이 프로젝트의 주요 변경 사항. SemVer 를 따르며, BREAKING 항목은 명시적으로 표시한다.

## 3.4.1 — 2026-11-12

> OpenAI 모델 지원 종료 대응 핫픽스. 기본 이미지 모델 `gpt-image-1-mini` 가 2026-12-01 종료되므로 그 전에 업데이트해야 합니다. 모델 레지스트리 중앙화 + 검증 중 발견한 버그 3건 수정.

### 🔄 동작 변경 — 모델 지원 종료 대응

- **기본 이미지 모델 교체: `gpt-image-1-mini` → `gpt-image-2.6-flare`** — 범용 이미지·무기·UI 장식·버튼·팝업·환경·이펙트·튜토리얼·아바타 파츠·편집 도구 등 기본 모델을 쓰던 모든 경로에 적용. 네이티브 투명 배경 지원(실측 7/7 정상).
- **종료된 모델 ID 자동 대체** — `gpt-image-1`(2026-10-23 종료) / `gpt-image-1-mini` / `gpt-image-1.5`(2026-12-01 종료) / `chatgpt-image-latest` 를 `model` 로 지정하면 거부하지 않고 `gpt-image-2.6-flare` 로 치환한다 (stderr 에 모델당 1회 경고). 저장해 둔 플랜·스크립트가 그대로 동작.
- **선택 가능 이미지 모델**: `gpt-image-2.6-flare` / `gpt-image-2.6-sunburst`(편집 정밀) / `gpt-image-2.5-flare`(저비용) / `gpt-image-2.5-sunburst` / `gpt-image-2`. `asset_compare_models` 기본 비교 대상도 2.6-flare / 2.6-sunburst / 2.5-flare 로 변경.
- **quality 과금 가드** — gpt-image-2.5/2.6 계열은 `quality` 를 생략하거나 `auto` 로 보내면 출력 토큰이 medium 의 약 4배(2.6-flare 1024² 실측: medium 1,449 / auto 5,795 토큰)가 된다. 이 계열은 미지정·`auto` 를 `medium` 으로 고정. `asset_generate_image_openai` 의 `quality` 기본값도 `auto` → `medium`.
- **edit 호출의 투명 입력 처리** — gpt-image-2.5/2.6 edit 는 입력 알파를 무시하고 투명 영역을 검은 배경으로 인식해 어두운 배경이 그려진 결과를 돌려준다(실측). 이 계열로 편집할 때는 투명 입력을 흰 배경에 합성해 전송하고, 첫 입력이 투명이었으면 `background: "transparent"` 를 요청한다. `asset_edit_image` / `asset_edit_sprite` / `asset_edit_character_design` 결과의 투명 배경 유지 확인. `asset_generate_character_portrait` 는 `background_style` 에 맞춰 transparent/opaque 를 명시 전송.
- **투명 배경 요청 시 프롬프트 보강** — gpt-image-2.5/2.6 은 `background: "transparent"` 만으로는 부족하다. 스타일 프롬프트에 "종이 질감·분위기·장식 문양" 같은 표현이 있으면 캔버스 전체에 배경을 그려 넣는다(세시마을 민화 컨셉 실측: 아이콘 3/3 이 불투명 한지 배경으로 반환). 투명 생성 요청 시 "피사체만 그릴 것" 지시문을 프롬프트 끝에 자동으로 붙인다 (수정 후 6/6 투명).
- **`gpt-5.2-chat-latest` 제거** — 2026-08-10 종료된 프롬프트 리파인 모델.
- **유지되는 것** — 캐릭터 베이스·스프라이트·로고·썸네일·로딩/로비 화면 등 특수 목적 파이프라인의 기본 모델 `gpt-image-2`(마젠타 크로마키 경로)와 Vision QC `gpt-4.1-mini`, 프롬프트 리파인 `gpt-5.4-nano` 는 이번 릴리스에서 바꾸지 않았다. `gpt-image-2` 요청 본문은 이전과 동일. 각각 2027-02-10 / 2027-01-14 / 2027-04-01 종료 예정이라 v3.5.0 에서 이전한다.

### ✨ 신규

- **`src/models.ts` 모델 레지스트리** — 이미지·비전·텍스트 모델 ID, 기본값, 종료 모델 대체표, 투명 지원 여부, quality 규칙을 한 파일로 모았다. 다음 지원 종료 때는 이 파일(과 `cost-tracking.ts` 단가표)만 고치면 된다. 도구 20여 개 파일에 흩어져 있던 모델 ID 하드코딩·유니온 캐스트 제거.
- **기본 모델 환경변수 override** — `OPENAI_IMAGE_MODEL`(예: 비용 우선이면 `gpt-image-2.5-flare`), `OPENAI_VISION_MODEL`, `OPENAI_PROMPT_MODEL`.
- **`asset_generate_image_responses`** — image_generation tool 에 `model` 을 명시 전달(기본 `gpt-image-2.6-flare`). 이전에는 미지정이라 API 기본값에 맡겨져 있었다.
- **`editImageOpenAI`** 에 `quality` / `background` 파라미터 추가. `image_edit` 의 `quality` 입력이 실제로 전달되도록 수정(이전에는 무시됨).

### 💰 비용 추정 테이블 갱신 (`src/utils/cost-tracking.ts`)

- 2026-11-12 실측 출력 토큰 × $30/1M 기준으로 교체 (1024² low / medium / high):
  - `gpt-image-2.6-flare`, `gpt-image-2.6-sunburst`: $0.025 / $0.043 / $0.053 (sunburst 는 low 만 실측, 나머지는 flare 와 동일 가정)
  - `gpt-image-2.5-flare`, `gpt-image-2.5-sunburst`: $0.006 / $0.013 / $0.053
  - `gpt-image-2`: $0.006 / $0.053 / $0.211 (OpenAI 공식 장당 단가표, medium 실측과 일치)
- ⚠️ **이전 테이블은 `gpt-image-2` 를 크게 과소 추정**하고 있었다 (high $0.04 → 실제 약 $0.21). registry 의 과거 `est_cost_usd` 는 실제 청구보다 낮게 기록돼 있을 수 있다.
- ⚠️ **기본 모델 단가 상승** — `gpt-image-1-mini` medium 약 $0.011 → `gpt-image-2.6-flare` medium 약 $0.043. `gpt-image-2.5-flare`(medium 약 $0.013)가 비용은 비슷하지만 투명 배경 요청 5건 중 2건이 불투명 배경으로 돌아와 기본값으로 채택하지 않았다.
- 1536/1792 급 직사각형 사이즈 계수 1.3 → 1.0 (실측상 1024² 와 토큰 수가 비슷하거나 적음). edit 추정은 2.5/2.6 계열 medium, `gpt-image-2` high 가정.

### 🐛 버그 수정

- **`asset_generate_weapons` 가 항상 실패하던 문제** — 생성 후 제자리 패딩(`addPadding(filePath, filePath)`)에서 sharp 가 `Cannot use same file for input and output` 을 던져 모든 무기가 실패 처리됐다. `addPadding` 이 버퍼를 거쳐 기록하도록 수정.
- **`asset_convert_font_to_bitmap` 의 `korean_basic` 문자셋 오류** — KS X 1001 완성형 2,350자가 아니라 U+AC00 부터 연속 2,350자를 잘라 써서 '가'~'딭' 범위만 포함되고 '사'·'하' 등 대부분의 상용 음절이 빠져 있었다. 표준 KS X 1001 표(`src/utils/ksx1001-hangul.ts`)를 내장해 수정.
- **`cleanupOldJobs`** — 주석과 달리 손상된 job 파일을 삭제하지 않던 문제 수정.
- 플러그인 `plugin.json` 버전이 3.1.1 에 머물러 있던 것을 3.4.1 로, `package-lock.json` 버전 필드(2.0.0)를 패키지 버전과 맞춤.
- v3.2.0 에서 제거한 영상(Sora)·Gemini 언급이 `plugin.json` / `marketplace.json` / `.env.example` / README / 스킬 문서 / 서버 헤더 주석에 남아 있던 것 정리.

### 🧪 테스트

- `tests/models.test.ts` 신설 (레지스트리·종료 모델 치환·quality 규칙·스키마·KS X 1001 표), `addPadding` 제자리 패딩 회귀 테스트, `prepareEditInput` 테스트, 비용 추정 테스트 보강. 27 → **43 tests**.
- 실제 OpenAI API + MCP stdio 클라이언트로 종단 검증: 기본 모델 생성, 종료 ID 치환, `gpt-image-2` 경로, 무기, Responses API, 한글 비트맵 폰트, 이미지/스프라이트 편집, 초상화(투명·배경). 세시마을 컨셉·canon 으로 아이콘 배치·아이템·편집·초상·참조 생성·디자인 시트(`gpt-image-2` 경로) 확인.

### ⚠️ 알려진 제한

- 스프라이트·로고·썸네일 등 `gpt-image-2` 기본 파이프라인에서 `model` 을 gpt-image-2.5/2.6 으로 직접 지정하는 조합은 이번 릴리스에서 종단 검증하지 않았다 (v3.5.0 에서 크로마키 경로 정리와 함께 이전 예정).
- 새 기본 모델은 스타일 프롬프트를 이전 모델보다 문자 그대로 따른다. 예: "decorative folk patterns" 가 있으면 장작·철괴 같은 사물 표면에도 문양을 입힌다. 기존 에셋과 톤을 맞추려면 CONCEPT 의 BASE STYLE PROMPT 를 조정하거나 canon 참조 생성을 쓸 것.
- `asset_generate_character_portrait` 는 프롬프트에 치비 스타일이 고정돼 있어 CONCEPT 의 화풍과 무관하게 캐릭터를 치비로 바꾼다 (기존 동작, v3.5.0 에서 수정 예정).
- Vision QC·`asset_select_best` 가 쓰는 `gpt-4.1-mini` 는 2027-01-14 종료 예정. 그 전에 `OPENAI_VISION_MODEL` 로 교체하거나 v3.5.0 으로 업데이트 필요.

## 3.4.0 — 2026-07-14

> Visual Concept 전자동 파이프라인(키 비주얼 자동 선별 → canon 앵커 → 디자인 시트 세트 생성) + 해부학 정밀 QC(손가락·좌우·소품 위치) + rembg 패키징/모델 선택 수정. 세시마을 실전 검증 완료.

### 🐛 버그 수정

- **플러그인 훅 스크립트 누락 복구** — v3.3.0에 커밋된 `hooks.json`이 참조하는 `hooks/asset-intent.sh`(UserPromptSubmit — 에셋 생성 의도 감지 + OPENAI_API_KEY 사전 검증)가 저장소에 빠져 있어 플러그인 사용자의 훅이 깨지던 문제. 스크립트 추가로 해결.
- **npm 패키지 rembg 스크립트 누락 수정** — `dist/`에 `remove_bg_ai.py`/`remove_chromakey.py`가 포함되지 않아 npm 설치 버전에서 `asset_remove_background`(AI), `asset_remove_background_batch`, 스프라이트 AI 배경 제거 fallback이 항상 실패하던 문제 (v1.0.0부터 존재). `build` 스크립트가 `src/utils/*.py`를 `dist/utils/`로 복사하도록 수정.

### ✨ 신규 기능

- **rembg 모델 선택** — `asset_remove_background`·`asset_remove_background_batch`에 `ai_model` 파라미터 추가: `u2net`(기본) / `isnet-general-use` / `birefnet-general`. isnet/birefnet은 에지 정밀도가 높은 대신 느리고 첫 사용 시 모델 가중치를 다운로드. `removeBackgroundAI`/`processFrameBase64AI` 유틸에도 동일 파라미터 추가 (타임아웃 60s → 120s, 첫 사용 시 가중치 다운로드 고려).
- **`asset_select_best`** — 후보 이미지 N개(2~10)를 AI 아트디렉터 루브릭(style_fit / composition / clarity / technical, 0~10)으로 병렬 채점해 최고점을 자동 선정. 실격 기준(텍스트·워터마크, 캐릭터 중복, 심각한 해부학 오류, 에지 잘림) 포함. `register_as_canon`으로 선정본 canon 자동 등록. 전자동 파이프라인에서 사람의 "옥석 고르기"를 대체.
- **vision-qc 검사 항목 4종 추가** — FINGERS(손별 손가락 수 명시 카운팅, 스타일 인지 — 치비는 3~4개 허용, 양손 불일치/5개 초과 감지), CHIRALITY(왼손 두 개 등 좌우 오류), FACING(기준 이미지 대비 방향 반전), PROP_SIDE(소품이 든 손 변경). FACING·PROP_SIDE는 기준 이미지 제공 시 2장 비교로 검사하며, 스프라이트 시트 파이프라인 QC에 base 캐릭터가 기준으로 자동 연결됨. 저해상도 프레임은 검사 전 512px 업스케일 보정.
- **종족 인지형 손 검사 (`character_kind`)** — FINGERS/CHIRALITY 엄격도를 종족별로 분리: `human`(엄격 카운팅+엄지 방향), `creature`(동물/마스코트/로봇 — paw·벙어리장갑형 손은 정상으로 인정, 6개 이상 뚜렷한 손가락·융합 뭉개짐 등 극단 오류만 감지), `auto`(기본, 모델이 종족 판별 후 기준 적용). `asset_review`에 `character_kind` 파라미터 노출. 비인간 캐릭터의 손가락 오탐 방지.
- **`analyzeImageOpenAI` 다중 이미지 지원** — `additionalImages`/`primaryLabel`로 라벨 붙은 복수 이미지를 한 호출에 전달 (기준 대비 비교 검사·canon 다중 참조의 기반).
- **Visual Concept 단계 공식화 (전자동)** — 실행 계획 Stage 0에 편입: 키 비주얼 후보 K개 생성(`KEY_VISUAL_VARIATION_PRESETS` 구도 프리셋 3종 + `CONCEPT_SUPPRESS_EFFECTS` 억제 지시) → `asset_select_best` 자동 선별·canon 등록 → 대표 캐릭터/배경 분리 추출 → 팔레트 역주입 → 스타일 시트. `create-minigame-assets` 스킬에 2.5단계로 절차 문서화 (사람 선택 없음, 전원 미달 시 1회 재생성).
- **`asset_generate_design_sheet`** — 디자인 시트 기반 세트 생성: 여러 아이템(건물/아이콘/소품/캐릭터 뷰)을 **한 장의 시트로 생성** → 크로마 연결 성분 검출 → 개수 검증(불일치 시 1회 자동 재생성) → 슬라이스 → 크로마 제거 → 개별 투명 PNG 저장·registry 등록. "한 장 안에서 함께 생성된 것은 비례·형태 언어가 자동 통일"되는 원리의 파이프라인화. 실측: 건물 7종 세트를 개별 생성 대비 AI 호출 1/7로, 세트 일관성은 더 좋게 생성 (장독대 실루엣 회귀 해결). `src/utils/sheet-slicer.ts` (성분 검출·행 클러스터링·슬라이스) 신설.
- **컨셉 계층 확장 — 캐릭터 3면도 + 플레이 스타일 목업** — Visual Concept 단계에 (D) 캐릭터별 3면도 컨셉 시트(`asset_generate_design_sheet`로 정면/측면/후면 → 정면을 캐릭터 canon으로), (E) 인게임 룩앤필 목업(UI 없는 플레이 화면 컨셉 — 건물 배치·밀도·분위기 기준) 단계 추가. 상세 에셋(초상·포즈·스프라이트·화면 구성)은 이 컨셉 앵커에서 파생. 세시마을 실증: 촌장·무당 3면도 → 대화창 초상 2종 파생, 캐릭터 동일성 유지 확인.

### 🔄 동작 변경

- `asset_remove_background`·`asset_remove_background_batch`의 `threshold`/`bg_color`/`feather` 파라미터는 **deprecated (무시됨)** — 두 도구는 이전부터 색상 임계값이 아닌 rembg AI로 동작했으며, 설명과 실제 동작이 달랐던 것을 바로잡음. 파라미터는 하위 호환을 위해 스키마에 유지.

## 3.3.0 — 2026-05-30

> 일반 이미지 생성 툴 추가 + 스프라이트 grid 모드 파일 관리 개선 + 게임 에셋 기본 선 스타일 적용.

### ✨ 신규 기능

- **`image_generate`** — 게임 에셋과 무관한 범용 이미지 생성 툴.
  - 게임 컨셉(CONCEPT.md) 주입 없음, 치비 스타일 강제 없음, 이미지 내 텍스트 허용(기본).
  - `style` 프리셋 10종: photorealistic / illustration / anime / oil-painting / watercolor / 3d-render / sketch / pixel-art / cinematic / flat.
  - 배경 기본값 `opaque`, 출력 기본 경로 `./generated-images`.
- **`image_edit`** — 기존 이미지를 기반으로 수정하는 범용 편집 툴 (게임 컨셉 비주입).

### 🔄 동작 변경

- **스프라이트 grid 모드 — 파일 출력 구조 변경** (`asset_generate_sprite_sheet`, `generation_mode: "grid"`):
  - 개별 프레임 PNG가 영구 저장되지 않음. `_grid_raw.png`(원본 그리드)와 `_sheet.webp`(합성 시트) 두 파일만 남음.
  - 합성 성공/실패·`auto_compose_sheet` 값 무관하게 개별 프레임이 항상 정리됨(이전에는 합성 실패 시 누수).
  - 응답 `results[].file_path` 및 `manifest.frames[].file_path`가 삭제된 경로를 더 이상 노출하지 않음.

- **게임 에셋 기본 선 스타일 자동 주입** — CONCEPT.md/game-concept.json에 watercolor·pastel 등 soft 스타일이 명시되지 않으면 `clean crisp outlines, sharp defined edges` 지시어를 모든 게임 에셋 프롬프트에 자동 추가. 스프라이트 베이스 캐릭터에도 동일 적용.

### 🐛 버그 수정

- 스프라이트 grid 모드: `composeSpritSheet` 예외 발생 시 개별 프레임 파일이 디스크에 남는 누수 수정.
- 스프라이트 grid 모드: `auto_compose_sheet: false` + `export_formats: ["individual"]` 조합 시 파일 누수 수정.
- `hasSoftStyle`: 게임 이름·색상 팔레트 이름에 "soft" 단어가 포함될 때 false positive로 clean line 주입이 스킵되던 문제 수정 — 이제 `Style:` 섹션만 검사.

### ⚡ 개선

- `SOFT_STYLE_KEYWORDS` 배열을 모듈 레벨 상수로 이동 — 호출마다 재생성 제거.
- `image_edit`의 `editImageOpenAI` dynamic import → 정적 import로 변경.
- `editSize` 항상-true 삼항 연산자 dead code 제거.

## 3.2.0 — 2026-04-28

> 마케팅 도구 전반 재설계 + video 워크플로 폐기 + 스프라이트 시트 한도 가드. BREAKING 다수(시그니처 변경 / 도구 제거)가 포함되지만 SemVer 상 minor 로 발행 — npm 의 v3 라인 유지를 위함. **CHANGELOG 의 BREAKING 섹션을 반드시 참조하세요.**

### 🔄 동작 변경 — 마케팅 도구 재설계

- **`asset_generate_social_media_pack` v2** — 파이프라인 전면 재작성.
  - **AI 호출 1회만** — gpt-image-2 로 1024×1024 "atmosphere plate" 한 장만 생성 (캐릭터/텍스트/UI 자리 비움).
  - 4 플랫폼 비율(1080×1080 post / 1080×1920 story / 1200×675 twitter / 1200×630 fb)을 sharp mirror+blur extend 로 빌드 — 옛 v1 의 cover-crop 정보 손실 해결. 캐릭터·로고가 변두리를 덮어 mirror 흔적 거의 안 보임.
  - `key_visual_path` 합성에 drop shadow + 플랫폼별 anchor (post=중앙, story=중앙 상단, banner류=좌측 1/3) + 발 캐치 위치 정렬 도입.
  - 신규 옵션: `logo_path?` (코너 safe-zone 합성), `vignette` (기본 true, 가장자리 어둡게).
  - **`caption` 입력 제거** — 텍스트 합성 자체를 폐지. 텍스트가 필요하면 외부에서 별도 합성.
  - description 상단에 "명시 요청 전용" ⚠️ 표기 — 기본 마케팅 워크플로(스토어 배너·썸네일·로고)에는 포함 안 됨.

- **`asset_generate_store_screenshots` 재정의** — "AI mockup 배경 + 텍스트" → "사용자 캡쳐 + 캡션 합성" 으로 의미 자체가 바뀜.
  - **`capture_image_path` 필수화** — 각 scene 마다 실제 게임 플레이 캡쳐 PNG 경로 필요. 사전 검증으로 누락 시 명확한 에러 + 시뮬레이터/실기기 캡쳐 안내.
  - **AI 호출 0회** — 캡쳐를 플랫폼 비율(iOS 1290×2796 / Android 1080×1920) cover fit + 캡션 SVG 합성만 수행. provider 항상 `"sharp"`.
  - **제거된 입력**: `background_image_path`, `style_description` (의미 중복 / 더 이상 AI fallback 없음).

### 🧱 데이터 모델 — asset-requirements 카테고리 재구성 (`src/utils/asset-requirements.ts`)

- **`AssetCategory.requires_explicit_request?: boolean` 신규 필드** — `true` 면 `analyzeAssetRequirements` 가 자동 추천 단계에서 항상 `optional` 로 분류 (사용자가 도구를 직접 부를 때만 의미가 있는 카테고리에 사용).
- **`marketing_store` 통합 카테고리 분리** → 3개로:
  - `marketing_screenshots` (`requires_explicit_request: true`) — 캡쳐 파일이 있어야 의미.
  - `marketing_banner` — 기존 `hasMarketing` 자동 추천 흐름 유지.
  - `marketing_social` (`requires_explicit_request: true`) — 마케팅 캠페인 시점에 명시 호출.
- `marketing_thumbnail` 자동 추천 흐름은 그대로.

### 🎬 도구 제거 — `asset_generate_video_openai`

- OpenAI Sora API 가 **2026-09-24 종료 예정**이고 공식 후속 영상 모델이 API 로 제공되지 않음. 본 프로젝트에서 영상 자산 워크플로를 운영하지 않기로 결정해 도구·서비스를 제거.
- 제거 대상: `src/tools/video.ts` 파일, `services/openai.ts` 의 `generateVideoOpenAI` 함수 + Sora 관련 타입(`SoraModel`, `SoraSize`, `OpenAIVideoParams`, `OpenAIVideoResult`), `constants.ts` 의 `VIDEO_TYPES` 상수, `types.ts` `GeneratedAsset.type` 의 `"video"` 멤버.
- 외부 문서 (`README.md`, `docs/workflow.md`, `docs/advanced.md`, `docs/tools.md`) 의 영상 언급 제거. 내부 변천사 문서(`docs/internals/process.md`)는 기록 보존.
- 향후 영상 기능이 필요해지면 다른 provider (Runway / Google Veo / Kling 등) 로 별도 통합 필요.

### 📐 스프라이트 시트 한도 가드 (`src/utils/spritesheet-composer.ts`)

- **신규 상수**: `DEFAULT_MAX_SHEET_DIM = 4096` (모바일 GPU 텍스처 광범위 호환선), `WEBP_HARD_LIMIT = 16383` (libwebp VP8 절대 한도).
- **`composeSpritSheet` 한도 검사 + 자동 그리드 재배치**:
  - 새 인자 `maxSheetDim?: number` (기본 `DEFAULT_MAX_SHEET_DIM`).
  - 사용자가 1×N 가로 스트립을 요청해도 시트 변(dim) 이 한도를 넘으면 자동으로 sqrt 에 가까운 그리드로 재배치, stderr 로 알림.
  - 한도 안 그리드 자체가 불가능하면 throw + 해결책(프레임 다운스케일 / `maxSheetDim` 상향 / 시트 분할) 명시.
- **`asset_generate_sprite_sheet` 의 default `sheet_cols` 변경** — 1×N 가로 스트립 → `Math.ceil(Math.sqrt(N))` 정사각 그리드. 사용자가 명시한 `sheet_cols` 는 그대로 우선하되 composer 가 한도 초과 시 자동 재배치.
- 이 변경으로 "20프레임 1행 스트립이 WebP 16,383px 한도 초과 → 합성 시트 합성 실패" 케이스가 해결됨.

### 🧪 테스트

- `tests/spritesheet-composer.test.ts` 신설 — 4 케이스 (정상 cols 유지 / 1×N 한도 초과 자동 재배치 / sqrt 그리드 default / 단일 프레임 한도 초과 시 에러). 23 → **27 tests**.

### 🛠 내부 정리

- `src/services/openai.ts` 영상 섹션 — 제거 사유 코멘트 1줄로 압축.
- `scripts/smoke-marketing-v2.mjs` — 마케팅 v2 + screenshots 시각 결과 검증용 ad-hoc 스크립트 (test-output/smoke/ 결과는 git ignored).
- `package.json` description 에서 "video" 항목 제거.

### ⚠️ BREAKING — 마이그레이션 가이드

- **`asset_generate_video_openai` 도구 제거**. 호출 시 `Tool not found` 에러. 영상 기능이 필요하면 다른 provider 로 별도 통합 필요.
- **`asset_generate_social_media_pack` 시그니처 변경** — `caption` 입력 제거. 호출 코드에서 해당 인자 삭제 필요 (zod strict reject).
- **`asset_generate_store_screenshots` 시그니처 변경** — `screenshots[].capture_image_path` 필수, `screenshots[].background_image_path` / `style_description` 입력 제거. 캡쳐 파일이 없으면 호출 자체가 실패. AI mockup 으로 채우던 흐름은 더 이상 지원하지 않음.
- **카테고리 ID `marketing_store` 소멸** — 외부에서 `analyzeAssetRequirements` 결과의 `marketing_store` 에 의존했다면 `marketing_screenshots` / `marketing_banner` / `marketing_social` 로 분기 변경 필요.
- **`GeneratedAsset.type` 에서 `"video"` 제거** — registry 에 기존 video 자산이 있다면 type narrowing 시 컴파일 에러. 외부 코드에서 video 타입 분기를 사용한다면 해당 분기 제거.
- **`VIDEO_TYPES` 상수 제거** — 외부에서 import 했다면 컴파일 에러. 영상 워크플로 자체가 사라졌으므로 제거가 정답.
- **`asset_generate_sprite_sheet` 의 default 시트 레이아웃 변경** — 옛 동작(1×N 가로 스트립)은 사실상 항상 한도에 걸렸으므로 의미 있는 행위 변경은 아니지만, 정사각 그리드를 명시적 default 로 잡은 만큼 atlas JSON / Phaser anims index 매핑 코드가 cols/rows 전제에 의존했다면 검토 필요.

## 3.1.1 — 2026-04-27

> 마케팅 자산 합성 흐름 개편 + 시퀀스 스프라이트 패턴 + registry/deploy-map 통합 + spec-aware 사이즈 정합성. 변경 범위는 SemVer 상 minor 급(신규 도구 2개 + BREAKING 항목)이지만 npm 의 `3.1.0` 이 이미 publish 되어 있어 **patch bump (`3.1.1`)** 로 발행. CHANGELOG 의 BREAKING 섹션을 반드시 참조하세요.

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
