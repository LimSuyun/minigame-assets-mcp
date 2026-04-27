# 고급 기능

## HTTP 모드 (stateful 세션)

```bash
TRANSPORT=http PORT=3456 node dist/index.js
```

엔드포인트:
- `POST /mcp` — MCP JSON-RPC. `initialize` 응답에 `mcp-session-id` 헤더가 포함되며 후속 요청은 같은 세션에 라우팅
- `GET /mcp` — SSE 스트림 재개
- `DELETE /mcp` — 세션 종료
- `GET /health` — `{ status, server, version, active_sessions }`

각 세션은 독립된 `McpServer` 인스턴스라 동시 다중 클라이언트 안전.

---

## 로컬 음악 서버

AudioCraft/MusicGen을 로컬에서 실행하는 경우:

```bash
pip install audiocraft
python music_server.py --port 7860
```

Gradio Space를 로컬 실행하는 경우 도구 파라미터에 `use_gradio: true` 사용.

환경변수:
```bash
export LOCAL_MUSIC_SERVER_URL=http://localhost:7860
```

---

## 비동기 Job

오래 걸리는 생성(영상, 음악 등)은 job ID를 반환합니다:

```
asset_generate_video_openai → { job_id: "xxx" }
asset_get_job_result { job_id: "xxx" } → { status: "done", file_path: "..." }
```

---

## Canon (마스터 레퍼런스)

프로젝트 전체에 걸쳐 "이 캐릭터는 이 생김새" 같은 일관성을 강제하려면 canon registry를 씁니다.

```
asset_register_canon   { asset_id, role: "hero", ... }
asset_get_canon / asset_list_canon
asset_validate_consistency  ← 생성 결과물이 canon과 일관되는지 비주얼 AI 검사
```

---

## Registry / Deploy-map 통합 (v3.1.0+)

어떤 도구가 `output_dir` 로 어떤 sub-dir(`logos/`, `marketing/app-icon/`, `thumbnails/` 등)을 받아도, `assets-registry.json` / `deploy-map.json` 은 자동으로 **프로젝트 루트(`.minigame-assets/`)** 한 곳에 모입니다 (`utils/registry-root.ts` 의 `resolveRegistryRoot()` 4단계 폴백).

자산 등록 시 자동으로 다음이 부착됩니다:
- `relative_path` — registry root 기준 POSIX 슬래시 (프로젝트 이동·머신 동기화 안전)
- `provider` 정규화 — `metadata.model` 이 있으면 `vendor/<model>` 형식으로 자동 보강 (예: `openai` + `gpt-image-2` → `openai/gpt-image-2`)

### 옛 v3.0.x 프로젝트 마이그레이션

옛 버전이 만든 `marketing/{app-icon,banner,thumbnail,...}/assets-registry.json` 같은 분산 sub-registry 가 있다면:

```
asset_consolidate_registry
  project_root: ".minigame-assets"
  dry_run: true     # 미리보기 (멱등이라 여러 번 호출 안전)
```

만족하면 `dry_run: false` 로 적용 — sub-registry/sub-deploy-map 의 entries 를 메인으로 흡수 + 자산에 `relative_path` 자동 부착 + sub 파일 정리.

---

## spec-aware 배포 (v3.1.0+)

`asset_deploy` 의 `auto_fill_targets: true` (기본) 동작:

1. `entry.deploy_targets` 가 비었을 때 `asset_size_spec.json` 을 로드
2. 자산 경로 패턴 → spec 카테고리·키 자동 추론 (`utils/size-spec.ts:inferSpecKeyFromPath`)
   - `sprites/{character}/_base` → `characters.base_master`
   - `sprites/{character}/_{action}_f*` → `characters.sprite_frame`
   - `backgrounds/*_far/_mid/_near` → `backgrounds.parallax_*`
   - `backgrounds/*` → `backgrounds.full`
   - `weapons/*` → `ui.icon_md`
   - `ui/popups/*` → `ui.popup_panel`
   - `ui/buttons/*_md` → `ui.button_md`
   - `marketing/app-icon/*` / `logos/*` → `marketing.app_icon`
   - `marketing/thumbnail/*` / `thumbnails/*` → `marketing.thumbnail`
3. 추론된 spec 사이즈 + `public/assets/<카테고리>/<파일명>` 경로의 deploy target 1개를 in-memory 채움 → 즉시 배포
4. 응답에 `auto_filled[]` 섹션으로 어떤 자산이 어떤 spec 키 기준으로 자동 채워졌는지 보고

영구 저장된 `deploy_targets` 가 있는 자산은 그대로 사용. `auto_fill_targets: false` 로 옛 동작(`no_targets` skip) 복원 가능.
