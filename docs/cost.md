# 비용·성능 추적

AI를 호출하는 모든 이미지/스프라이트/UI/환경/마케팅/튜토리얼 도구는
`assets-registry.json` 의 각 에셋 `metadata` 에 다음 필드를 기록합니다.

```json
"metadata": {
  "model": "gpt-image-2.6-flare",
  "latency_ms": 8737,
  "est_cost_usd": 0.043,
  "cost_formula": "gpt-image-2.6-flare × medium × size-mult 1 = $0.043 × 1"
}
```

- 합성 도구(tileset, effect sheet 등) 는 단가를 타일/프레임 수만큼 곱해 집계
- **참고용 추정치** 입니다. 실제 청구는 OpenAI 공식 대시보드 기준
- `asset_list_assets` 로 누적 비용을 빠르게 훑어볼 수 있음
- v3.1.0 부터 `provider` 표기가 `vendor/<model>` 형식으로 표준화 — registry 에서 prefix 매치(`openai/`, `local/`, `sharp/`)로 일관 집계 가능

## 대략적 단가 참고

| 모델 | 1024×1024 한 장 (low / medium / high) |
|---|---|
| `gpt-image-2.6-flare` (기본) | \$0.025 / \$0.043 / \$0.053 |
| `gpt-image-2.6-sunburst` (편집 정밀) | flare 와 동일 가정 (low 만 실측) |
| `gpt-image-2.5-flare` (저비용) | \$0.006 / \$0.013 / \$0.053 |
| `gpt-image-2` (특수 목적 파이프라인, 2027-02-10 종료 예정) | \$0.006 / \$0.053 / \$0.211 |
| `refine_prompt` (GPT-5.4-nano) | ~\$0.001 / 호출 |
| Vision QC (gpt-4.1-mini) | ~\$0.001~0.005 / 호출 |

- 위 값은 2026-11-12 실측 출력 토큰 × \$30/1M 환산치입니다 (입력 토큰 비용 제외).
- gpt-image-2.5/2.6 계열은 `quality` 를 생략하거나 `auto` 로 보내면 medium 의 약 4배 토큰이 나오므로, 서버가 미지정·`auto` 를 `medium` 으로 고정합니다.
- `gpt-image-1` / `gpt-image-1-mini` / `gpt-image-1.5` 는 OpenAI 지원 종료 모델입니다. 지정하면 `gpt-image-2.6-flare` 로 자동 대체됩니다.
- 기본 모델은 `OPENAI_IMAGE_MODEL` 환경변수로 바꿀 수 있습니다 (비용 우선이면 `gpt-image-2.5-flare` — 단, 투명 배경 요청이 간헐적으로 무시됨).

정확한 금액은 각 플랫폼의 가격 페이지를 참고하세요.
