# Minigame Assets MCP

Claude와 대화하면서 게임 에셋을 생성하는 MCP 서버.
캐릭터·스프라이트·배경·UI·로고·썸네일·음악·영상을 그때그때 만들어 줍니다.

---

## 빠른 시작

**1. 설치**

```bash
claude mcp add minigame-assets --scope user \
  -e OPENAI_API_KEY=sk-... \
  -- npx -y minigame-assets-mcp@latest
```

**2. 확인**

```bash
claude mcp list
# minigame-assets: npx -y minigame-assets-mcp@latest - ✓ Connected
```

**3. 첫 에셋**

Claude에게 이렇게 요청하면 됩니다:

> "슬라임 캐릭터 스프라이트 시트 만들어줘"

도구가 컨셉 파일이 없다는 걸 감지하고 `CONCEPT.md` 생성부터 시작합니다.
이후 모든 산출물은 프로젝트 루트의 `.minigame-assets/` 폴더에 모입니다.

---

## 할 수 있는 것

- **캐릭터** — 베이스 → 장비 결합 → 스프라이트 시트 (1행 가로 스트립 기본)
- **배경·화면** — 게임 씬 배경, 로딩 화면, 로비 화면, parallax 다층 레이어
- **UI** — HUD, 버튼, 팝업, 아이콘, 스타일 레퍼런스 시트
- **마케팅** — 앱 로고, 썸네일, 스토어 배너/스크린샷, SNS 팩
- **사운드** — 로컬 AudioCraft 기반 BGM·SFX
- **영상** — OpenAI Sora
- **배포 파이프라인** — `deploy-map.json` 매니페스트로 마스터 → 코드 경로 리사이즈 복사

자세한 도구 목록은 [`docs/tools.md`](docs/tools.md).

---

## 워크플로우 한눈에

```
컨셉 → 실행 계획 → 캐릭터/에셋 생성 → 검토·검증 → 배포
```

모든 원본은 `.minigame-assets/` 에 모이고, 실제 게임 코드가 쓰는 리사이즈된 사본은
`asset_deploy` 가 승인된 엔트리만 골라 `public/assets/...` 같은 코드 경로로 복사합니다.

자세한 순서는 [`docs/workflow.md`](docs/workflow.md).

---

## 자세한 문서

- [설치 옵션](docs/install.md) — 플러그인 방식, OS 시크릿 저장소, 환경변수
- [도구 레퍼런스](docs/tools.md) — 전체 도구
- [워크플로우](docs/workflow.md) — 권장 생성 순서, 출력 구조, 배포 파이프라인
- [출력 포맷](docs/output-formats.md) — PNG/WebP 자동 감지, display-size scanner, Atlas JSON
- [비용 추적](docs/cost.md) — 모델별 단가 기록
- [고급 기능](docs/advanced.md) — HTTP 모드, 로컬 음악 서버, canon
- [개발 참여](docs/development.md) — 소스 빌드·로컬 등록

---

## 요구사항

- Node.js 18+
- [Claude Code](https://claude.ai/code) CLI
- [OpenAI API Key](https://platform.openai.com/api-keys) — 이미지·영상·비전

## 라이선스

MIT
