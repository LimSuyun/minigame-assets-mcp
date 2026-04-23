# scripts/experiments/

이 디렉토리의 스크립트는 **모델 비교 · 품질 조정 · 디버깅용 수동 실험 스크립트**입니다.
MCP 서버 빌드나 CI와는 무관하며, 자동화된 테스트(vitest) 대상도 아닙니다.

## 실행 방법

모두 `tsx`로 직접 실행합니다. 프로젝트 루트에서:

```bash
npx tsx scripts/experiments/<script>.ts
```

사전 조건:

- `OPENAI_API_KEY` / `GEMINI_API_KEY` 환경 변수
- 일부 스크립트는 `generated-assets/` 하위에 입력 이미지가 있어야 동작 — 각 파일 상단 주석 참고
- 산출물은 `scripts/experiments/out/` 또는 각 스크립트가 지정한 경로에 저장됩니다

## 스크립트 용도

| 파일 | 목적 |
|------|------|
| `scan-residue.ts` | 투명화된 PNG에서 마젠타 크로마 잔류 픽셀 정량 스캔 |
| `test-compare.ts` | 같은 프롬프트를 여러 OpenAI 모델(gpt-image-1-mini / gpt-image-1 / gpt-image-1.5 / gpt-image-2)로 생성해 나란히 비교 |
| `test-gen-base-gpt2.ts` | `asset_generate_character_base`의 gpt-image-2 경로만 단독 호출해 크로마키 투명화 파이프라인 디버깅 |
| `test-sheet-guide.ts` | OpenPose-style skeleton guide로 sprite sheet 생성 실험 |
| `test-skeleton-sprite.ts` | 단일 skeleton pose → 스프라이트 프레임 생성 |
| `test-sprite-compare.ts` | 9-frame 스프라이트 시트를 여러 모델로 생성해 비교 |
| `test-walk-compare.ts` | walk 액션 프레임만 집중 비교 |

## 주의

- 이 스크립트들은 API 키로 실제 호출을 하므로 실행 시 비용이 발생합니다.
- 산출물 이미지는 `.gitignore` 대상 — 커밋하지 마세요.
- npm 패키지(`npm publish`)에는 포함되지 않습니다 (`package.json`의 `files` 배열로 제외).
