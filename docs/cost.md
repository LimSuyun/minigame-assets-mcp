# 비용·성능 추적

AI를 호출하는 모든 이미지/스프라이트/UI/환경/마케팅/튜토리얼 도구는
`assets-registry.json` 의 각 에셋 `metadata` 에 다음 필드를 기록합니다.

```json
"metadata": {
  "model": "gpt-image-2",
  "latency_ms": 12843,
  "est_cost_usd": 0.04,
  "cost_formula": "gpt-image-2 × high × size-mult 1 = $0.04 × 1"
}
```

- 합성 도구(tileset, effect sheet 등) 는 단가를 타일/프레임 수만큼 곱해 집계
- **참고용 추정치** 입니다. 실제 청구는 OpenAI 공식 대시보드 기준
- `asset_list_assets` 로 누적 비용을 빠르게 훑어볼 수 있음
- v3.1.0 부터 `provider` 표기가 `vendor/<model>` 형식으로 표준화 — registry 에서 prefix 매치(`openai/`, `local/`, `sharp/`)로 일관 집계 가능

## 대략적 단가 참고

| 모델 | 한 장 기준 |
|---|---|
| `gpt-image-1-mini` | 저비용 (2D 치비·단순 에셋 기본) |
| `gpt-image-1` | 중간 |
| `gpt-image-1.5` | 중상 |
| `gpt-image-2` | 상 (고디테일·텍스트·4K) |
| `refine_prompt` (GPT-5.4-nano) | ~\$0.001 / 호출 |
| Vision QC (gpt-4.1-mini) | ~\$0.001~0.005 / 호출 |

정확한 금액은 각 플랫폼의 가격 페이지를 참고하세요.
