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
