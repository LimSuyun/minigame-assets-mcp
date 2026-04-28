# 도구 레퍼런스

모든 도구는 `asset_` 으로 시작합니다. 기본 출력 경로는 `./.minigame-assets/<type>/`.

## 컨셉 & 계획

| 도구 | 설명 |
|---|---|
| `asset_create_concept_md` | 게임 컨셉·에셋 목록·스타일 가이드를 CONCEPT.md로 생성 |
| `asset_get_concept` | 현재 게임 컨셉 조회 |
| `asset_generate_execution_plan` | CONCEPT.md + 엔진 감지 → EXECUTION-PLAN.md |
| `asset_generate_asset_plan` | 프로젝트 코드 분석 → 누락 에셋 계획 |
| `asset_list_assets` | 생성된 에셋 목록 조회 |

## 이미지 생성 (범용)

| 도구 | 설명 |
|---|---|
| `asset_generate_image` | 에셋 타입 기반 자동 AI 선택 |
| `asset_generate_image_openai` | OpenAI gpt-image-2 / gpt-image-1 계열 (기본 gpt-image-1-mini) |
| `asset_generate_image_responses` | OpenAI Responses API (텍스트 모델 + 이미지 조합) |
| `asset_batch_generate_images` | 최대 10개 일괄 생성 |
| `asset_compare_models` | 여러 OpenAI 모델 A/B 비교 |
| `asset_generate_with_reference` | 레퍼런스 이미지 기반 생성 |

## 캐릭터 & 스프라이트

| 도구 | 설명 |
|---|---|
| `asset_generate_character_base` | 정면 캐릭터 베이스 (gpt-image-2, 마젠타 크로마키 → 투명). **role**: player/enemy/monster/npc/generic |
| `asset_generate_character_equipped` | 베이스 + 장비 다중 레퍼런스 합성 → 새 투명 PNG |
| `asset_generate_character_views` | 정면·측면·후면 멀티뷰 세트 |
| `asset_generate_character_pose` | 단일 포즈 |
| `asset_generate_character_portrait` | 초상화 3사이즈 (full / bust / thumb) |
| `asset_generate_character_card` | 카드 UI 합성 (Sharp, AI 미사용) |
| `asset_generate_sprite_sheet` | 액션 스프라이트 시트 (gpt-image-2 edit). **기본: 1행 가로 스트립** (`sheet_cols`로 grid 전환) |
| `asset_generate_character_weapon_sprites` | 무기 장착 상태 스프라이트 일괄 |
| `asset_generate_avatar_parts` | 아바타 커스터마이즈 파츠 |
| `asset_generate_weapons` | 무기 아이콘 일괄 (gpt-image-1, 투명) |

## 편집

| 도구 | 설명 |
|---|---|
| `asset_edit_image` | 이미지 스타일/색상 편집 |
| `asset_edit_sprite` | 특정 액션 프레임 수정 |
| `asset_edit_character_design` | 캐릭터 디자인 변경 + 스프라이트 자동 재생성 |
| `asset_remove_background` | 배경 제거 (투명 PNG) |
| `asset_remove_background_batch` | 배경 일괄 제거 |

## 화면 (로딩·로비·배경)

| 도구 | 설명 |
|---|---|
| `asset_generate_loading_screen` | 로딩 화면 (gpt-image-2, 하단 20-25% 프로그레스바 영역 확보) |
| `asset_generate_lobby_screen` | 로비/메인 메뉴 (gpt-image-2, menu_side: left/right/center/bottom) |
| `asset_generate_screen_background` | 게임 씬 배경 (static/parallax) |

## 환경 & 맵

| 도구 | 설명 |
|---|---|
| `asset_generate_parallax_set` | 다층 배경 (레이어별 speed factor) |
| `asset_generate_tileset` | 16타일 시트 + 설정 JSON (seamless tileable) |
| `asset_generate_props_set` | 맵 오브젝트/소품 세트 (투명) |
| `asset_generate_interactive_objects` | 상태별 스프라이트 (open/closed 등) + Atlas |

## UI 세트

| 도구 | 설명 |
|---|---|
| `asset_generate_hud_set` | HUD 일괄 (체력바·미니맵 등) |
| `asset_generate_button_set` | 버튼 세트 (primary/secondary 등) |
| `asset_generate_popup_set` | 팝업·다이얼로그 프레임 |
| `asset_generate_icon_set` | 아이콘 세트 |
| `asset_generate_ui_structural` | 구조적 UI 요소 |
| `asset_generate_ui_decorative` | 장식용 UI 요소 |

## 이펙트 & 튜토리얼

| 도구 | 설명 |
|---|---|
| `asset_generate_effect_sheet` | 이펙트 애니메이션 시트 + Atlas JSON |
| `asset_generate_status_effect_icons` | 상태이상 아이콘 세트 |
| `asset_generate_floating_text` | 플로팅 텍스트 스타일 PNG (Sharp SVG, AI 미사용) |
| `asset_generate_tutorial_overlays` | 스포트라이트·화살표 오버레이 |
| `asset_generate_guide_npc` | 가이드 NPC 표정 세트 |

## 마케팅 (Stage 6 — 캐릭터·배경·타이틀 텍스트 자산이 준비된 뒤 호출)

| 도구 | 설명 |
|---|---|
| `asset_generate_app_logo` | 앱 로고 600×600 — 캐릭터/대표 + 타이틀 텍스트 PNG → gpt-image-2 edit 통합 합성 |
| `asset_plan_thumbnail` | 썸네일 구성 계획 (생성 없음) |
| `asset_generate_thumbnail` | 썸네일 1932×828 — 배경·캐릭터 + 타이틀 텍스트 PNG → gpt-image-2 edit 통합 합성 |
| `asset_generate_store_banner` | 플랫폼별 배너 (Google Play / App Store) |
| `asset_generate_store_screenshots` | 씬별 스크린샷 + 캡션 오버레이 |
| `asset_generate_social_media_pack` | Instagram/Twitter/Facebook 게시물 세트 |
| `asset_generate_style_reference_sheet` | 스타일 레퍼런스 시트 |

## 음악

| 도구 | 설명 |
|---|---|
| `asset_generate_music_local` | 로컬 AudioCraft/MusicGen 또는 Gradio |
| `asset_generate_bgm` | 카테고리별 BGM 일괄 |
| `asset_generate_sfx` | 카테고리별 SFX 일괄 (AudioGen) |
| `asset_edit_music` | 음악 파라미터 수정 |

## Canon (마스터 레퍼런스)

| 도구 | 설명 |
|---|---|
| `asset_register_canon` | 마스터 레퍼런스를 canon registry에 등록 |
| `asset_get_canon` / `asset_list_canon` | canon 조회 |
| `asset_validate_consistency` | canon 대비 생성 결과물 일관성 검사 |

## 계획 & 디자인 문서

| 도구 | 설명 |
|---|---|
| `asset_create_concept` | game-concept.json 생성 |
| `asset_parse_design_doc` | 외부 디자인 문서(GDD) 파싱 |
| `asset_plan_requirements` | 필수 에셋 요구사항 도출 |
| `asset_plan_by_screen` | 화면 단위 에셋 계획 |
| `asset_generate_full_plan` | FULL_ASSET_PLAN.md 생성 |
| `asset_generate_size_spec` | asset_size_spec.json 생성 |

## 검토·검증·유틸

| 도구 | 설명 |
|---|---|
| `asset_review` | 에셋 품질 종합 검토 (구조·크로마·비주얼 AI). mode: quick/standard/deep |
| `asset_validate` | 네이밍 규칙 + PNG 크기 스펙 검사 |
| `asset_list_missing` | 필수 에셋 누락 목록 |
| `asset_generate_atlas_json` | Atlas JSON (Phaser / Unity / Cocos / Generic) |
| `asset_analyze_project` | 게임 엔진 감지 + 에셋 디렉토리 분석 |
| `asset_plan_from_project` | 코드에서 참조된 미싱 에셋 계획 |
| `asset_scan_display_sizes` | 게임 코드 스캔 → display 크기 + asset_urls 추출 |
| `asset_composite` | 다중 이미지 합성 |
| `asset_extract_palette` | 이미지에서 컬러 팔레트 추출 |
| `asset_refine_transparency` | 크로마 잔류 후처리 재실행 |
| `asset_convert_font_to_bitmap` | 폰트 → 비트맵 스프라이트 시트 |
| `asset_get_job_result` | 비동기 job 결과 조회 |

## 배포 (매니페스트 기반)

`.minigame-assets/deploy-map.json` 을 source of truth로, 마스터를 코드 경로에 리사이즈 복사하는 파이프라인.
생성된 모든 에셋은 `approved: false` 로 자동 등록됩니다.

| 도구 | 설명 |
|---|---|
| `asset_approve` | `entries: string[] \| "all"` — 현재 `master_hash` 를 `approved_hash` 로 고정. 마스터 재생성 시 hash 불일치로 `needs_reapproval` 상태가 되어 재호출 필요 |
| `asset_revoke` | 승인 해제 (엔트리는 이력 보존) |
| `asset_deploy` | 승인된 마스터를 sharp로 `width × height × fit × format` 리사이즈해 `deploy_targets[].path` 로 복사. 바이트 동일 시 스킵(idempotent). `dry_run`·`force`·`entries` 필터 지원 |

## 프롬프트 확장 (refine_prompt)

대부분의 이미지 생성 도구가 `refine_prompt: true` 를 지원합니다.
OpenAI **GPT-5.4-nano** 가 짧은 한국어/영어 입력을 상세 영문 프롬프트로 확장한 뒤 이미지 모델로 전달합니다.

```
기본:   "검을 든 전사"                     → 이미지
refine: "A heroic warrior holding an        → 이미지 (디테일 ↑)
        ornate long sword, polished silver
        plate armor with gold trim..."
```

지원 도구: `asset_generate_character_base`, `asset_generate_character_equipped`,
`asset_generate_image_openai`, `asset_generate_thumbnail`,
`asset_generate_loading_screen`, `asset_generate_lobby_screen`.

비용·지연: 호출당 ~\$0.001 + ~2~4초.
