# 워크플로우

## 생성 → 배포 한눈에

```
컨셉 정의 → 실행 계획 → 에셋 생성 → 검토/검증 → 배포
```

생성된 **마스터(원본, 고해상도)** 는 전부 `.minigame-assets/` 한 곳에 모입니다.
실제 게임 코드가 쓰는 **리사이즈된 사본** 은 `asset_deploy` 가 `deploy-map.json` 의
승인된 엔트리만 골라 코드 경로로 복사합니다.

---

## 권장 순서

```
1. 컨셉 정의
   asset_create_concept_md
   → .minigame-assets/CONCEPT.md + .minigame-assets/game-concept.json

2. 실행 계획
   asset_generate_execution_plan
   → 게임 엔진 감지 (Phaser / Unity / Cocos / Godot)
   → .minigame-assets/EXECUTION-PLAN.md

3. 캐릭터 베이스 (role: player / enemy / monster / npc)
   ├─ asset_generate_character_base       ← 정면 베이스 (gpt-image-2)
   └─ asset_generate_character_equipped   ← 베이스 + 장비 합성 (선택)

4. 무기
   asset_generate_weapons                 ← 아이콘 일괄 (gpt-image-1, 투명)

5. 스프라이트 시트 (1행 가로 스트립 기본)
   asset_generate_sprite_sheet            ← 액션 프레임 (gpt-image-2 edit)

6. 배경 + 화면
   ├─ asset_generate_screen_background    ← 게임 씬 배경
   ├─ asset_generate_loading_screen       ← 로딩 (하단 20% 프로그레스바 영역)
   └─ asset_generate_lobby_screen         ← 로비/메뉴 (menu_side: left/right/center/bottom)

7. 마케팅
   ├─ asset_generate_app_logo             ← 600×600
   └─ asset_generate_thumbnail            ← 1932×828

8. 검토 + 검증
   ├─ asset_review                        ← 구조·크로마·비주얼 AI 종합
   ├─ asset_validate                      ← 네이밍·스펙
   ├─ asset_list_missing                  ← 누락 체크
   └─ asset_generate_atlas_json           ← Phaser/Unity/Cocos Atlas

9. 배포
   ├─ asset_scan_display_sizes            ← 코드에서 display 크기 + asset_urls 스캔
   ├─ deploy-map.json 의 deploy_targets    ← 스캔 결과로 채움
   ├─ asset_approve { entries: "all" }    ← master_hash 를 approved_hash 로 고정
   └─ asset_deploy                        ← 승인된 마스터를 리사이즈해 코드 경로로 복사
```

**프롬프트 확장:** 디테일이 필요한 생성 호출에 `refine_prompt: true` 를 주면
GPT-5.4-nano 가 짧은 한국어/영어 입력을 상세 영문 프롬프트로 확장한 뒤 이미지를 만듭니다.

지원: `asset_generate_character_base`, `asset_generate_character_equipped`,
`asset_generate_thumbnail`, `asset_generate_image_openai`,
`asset_generate_loading_screen`, `asset_generate_lobby_screen`.

---

## 출력 구조

```
.minigame-assets/                ← 마스터 전용 (gitignore 권장)
├── CONCEPT.md                   ← 게임 컨셉 (아트 스타일, 에셋 목록)
├── game-concept.json            ← 컨셉 JSON (도구 참조용)
├── GAME_DESIGN.json             ← 게임 디자인 문서 (선택)
├── asset_size_spec.json         ← 에셋 크기 스펙 (생성 가능)
├── EXECUTION-PLAN.md            ← 실행 계획
├── FULL_ASSET_PLAN.md           ← 전체 에셋 플랜 (선택)
├── assets-registry.json         ← 생성된 모든 에셋 메타데이터
├── deploy-map.json              ← 배포 매니페스트 (approved/targets/hashes)
├── images/                      ← 일반 이미지
├── sprites/                     ← 캐릭터 스프라이트 시트
├── characters/                  ← 캐릭터 베이스
├── weapons/                     ← 무기 아이콘
├── backgrounds/                 ← 배경
├── logos/                       ← 앱 로고
├── thumbnails/                  ← 썸네일
├── music/                       ← 음악
└── videos/                      ← 영상
```

**`.gitignore` 권장:**
```
.minigame-assets/
!.minigame-assets/*.md
!.minigame-assets/*.json
!.minigame-assets/deploy-map.json
```
바이너리(에셋)는 제외, 설계 문서/매니페스트만 공유.

---

## 배포 파이프라인 상세

```
1. asset_generate_* 로 생성
   → .minigame-assets/<type>/*.png
   → deploy-map.json 에 approved:false 로 자동 등록

2. asset_scan_display_sizes
   → 코드에서 기대되는 크기·경로 스캔

3. deploy-map.json 의 deploy_targets 채우기
   (스캔 결과를 힌트로 수동 또는 스크립트로)

4. asset_approve { entries: [...] } 또는 { entries: "all" }
   → 현재 master_hash 를 approved_hash 로 고정

5. asset_deploy
   → 승인된 마스터를 sharp 로 리사이즈
   → public/assets/... 등 코드 경로로 복사
   → 마스터 재생성 시 hash 불일치 → needs_reapproval 상태
```

`asset_deploy` 는 idempotent. 바이트 동일하면 재작성 스킵. `dry_run`·`force`·`entries` 필터 지원.
