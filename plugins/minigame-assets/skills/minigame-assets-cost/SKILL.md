---
name: minigame-assets-cost
description: Use this skill when the user asks about asset generation costs, model pricing, per-call budget, or which model is cheapest/best value for a given task. Triggers on phrases like "비용 얼마야", "가격", "싼 모델", "예산", "cost", "pricing", "budget", "how much", "cheapest model", "compare models".
version: 2.1.0
---

# Minigame Assets — 비용 관리

모든 `asset_generate_*` 도구는 registry metadata 에 `est_cost_usd`, `latency_ms`, `model`, `cost_formula` 를 자동 기록합니다. 아래는 정확한 단가표와 절감 전략.

## OpenAI gpt-image 계열 (2026-04 추정 기준)

| 모델 | low | medium | high | auto |
|------|-----|--------|------|------|
| `gpt-image-2` | $0.010 | $0.020 | **$0.040** | $0.025 |
| `gpt-image-1.5` | $0.008 | $0.016 | $0.030 | $0.020 |
| `gpt-image-1` | $0.005 | $0.012 | $0.020 | $0.015 |
| `gpt-image-1-mini` | $0.003 | $0.008 | $0.015 | $0.010 |

**2K/4K 사이즈 배수** (gpt-image-2 전용):
- 1024/1536 (default): ×1.0
- 1792/1536 wide: ×1.3
- 2048×2048: ×1.8
- 3840×2160 (4K): ×3.0

예: `gpt-image-2, high, 2048×2048` = $0.040 × 1.8 = **$0.072 per image**

## Gemini Imagen / Veo

| 모델 | 단가 |
|------|------|
| Imagen-4 (모든 variant) | **$0.04 per image** (flat) |
| Veo 3 video | ~$0.50 per 8-sec clip |

## GPT-5 텍스트 (프롬프트 refine 시)

| 모델 | Input $/1M | Output $/1M |
|------|-----------|-------------|
| `gpt-5.4-nano` | $0.10 | $0.40 |
| `gpt-5.2` | $0.50 | $2.00 |
| `gpt-5.2-pro` | $3.00 | $12.00 |

`refine_prompt: true` 는 `gpt-5.4-nano` 사용, 한 번 호출당 ~$0.0003 수준 (무시 가능).

## 과제별 권장 모델

| 작업 | 권장 모델 | 이유 |
|------|----------|------|
| UI 아이콘·버튼 | `gpt-image-1-mini` medium | 단순 · 충분 |
| 캐릭터 베이스·스프라이트 | `gpt-image-2` high | 디테일·텍스트·일관성 우수 |
| 배경 (정적) | `gpt-image-2` medium | 텍스트 없으면 high 불필요 |
| 배경 parallax 레이어 | `Gemini Imagen-4 fast` | 투명도 네이티브 |
| 앱 로고 | `gpt-image-1` high | 텍스트 포함 시 gpt-image-2 |
| 썸네일·마케팅 | `gpt-image-2` high | 품질 최우선 |
| 프로토타입 전반 | `gpt-image-1-mini` low/medium | 스타일 확정 전 |

## 비용 추적 & 집계

생성 후:
```
asset_list_assets  output_dir: "./generated-assets"
```
각 에셋의 `metadata.est_cost_usd` 합산하면 프로젝트 누적 비용.

캐릭터 1 (base + 9 sprites + sheet) 예상:
- base: gpt-image-2 high 1024 = $0.040
- 9 sprites (edit): $0.040 × 9 × 1.1 (edit multiplier) = $0.396
- sheet: 합성 (AI 미사용) = $0
- **소계: ~$0.44 per character**

## 비용 절감 팁

1. **품질 레벨 조정** — 처음엔 `quality: "medium"` 으로 스타일·구도 확인 → 확정 후 `"high"` 로 재생성
2. **`refine_prompt: true`** 활용 — 짧은 한국어 입력을 영문 상세화해서 적중률 높여 재시도 줄임 (비용 대비 효과 최고)
3. **`asset_compare_models`** — 한 프롬프트를 여러 모델에 태워서 스타일 비교. 한 번 쓰고 그 뒤로는 검증된 모델만 사용
4. **Canon 시스템** — 레퍼런스로 재사용해 재생성 루프 줄임 (`minigame-assets-style-consistency` 참조)
5. **asset_review mode: "quick"** 우선 — "standard" 는 Gemini Vision 호출 비용 있음

## asset_compare_models 실사용

```
asset_compare_models
  prompt: "chibi Korean boy adventurer, red tunic, transparent bg"
  models: ["gpt-image-1", "gpt-image-2", "imagen-4.0-generate-001"]
  quality: "medium"
```
→ 3장 생성 + registry metadata 에 비교용 tag. 스타일 확인 후 프로젝트 표준 모델 결정.

## 연관 스킬

- **refine_prompt 활용 워크플로**: `minigame-assets-workflow`
- **재생성 줄이는 스타일 전략**: `minigame-assets-style-consistency`
- **품질과 비용 균형**: `minigame-assets-review` mode 선택
