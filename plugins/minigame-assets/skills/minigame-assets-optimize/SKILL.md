---
name: minigame-assets-optimize
description: Use this skill when the user asks about reducing generated asset file sizes, changing image format (PNG ↔ WebP), or sizing assets to match the game code's actual display dimensions. Triggers on phrases like "용량 줄이기", "파일이 너무 커", "최적화", "WebP 로 바꿀 수 있어", "크기 조정", "reduce size", "optimize images", "compress assets", "too big".
version: 2.1.0
---

# Minigame Assets — 용량 최적화

에셋 용량 문제를 다룰 때 참조할 레버 3가지 — 포맷 · 크기 · 재인코딩.

## 1. 엔진 기반 자동 포맷 선택 (이미 작동 중)

모든 생성 도구는 `cwd` 에서 엔진을 감지해 포맷을 결정합니다:

| 엔진 | 포맷 | 실측 감소율 |
|------|------|------------|
| Phaser 3 | **WebP** | 2 MB → 250 KB (**-87%**) |
| Cocos Creator 3+ | **WebP** | 동일 수준 |
| Godot 3+ | **WebP** | 동일 수준 |
| Unity | PNG | 변화 없음 (런타임 WebP 미지원) |
| 미감지 | PNG | 안전 기본값 |

**강제 override**:
```bash
export ASSET_OUTPUT_FORMAT=png   # 모든 프로젝트에서 PNG 고정
export ASSET_OUTPUT_FORMAT=webp  # 모든 프로젝트에서 WebP 고정
```

도구 호출 시 `output_format: "png"` 또는 `"webp"` 파라미터로 개별 override 도 가능.

## 2. 코드 기반 크기 스캔 (display_size matching)

게임 코드에 이미 정의된 표시 크기에 맞춰 생성해서 overgeneration 을 줄이려면:

```
asset_scan_display_sizes  project_path: "."
```

감지 패턴:
- Phaser: `.setDisplaySize(w, h)`, `.setScale(n)`
- Cocos: `.setContentSize(w, h)`
- Godot: `Vector2(scale)`

결과 예:
```json
{
  "detections": [
    { "asset_key": "hero", "display_width": 64, "display_height": 64, "suggested_generation_size": 128 }
  ]
}
```

`suggested_generation_size` 를 각 `asset_generate_*` 의 `size` 파라미터로 전달:
```
asset_generate_character_base  character_name: "hero"  size: "128x128"  ...
```

**추천 룰 내부 규칙**: display × 2 headroom → multiple-of-64 snap → 1024 cap.

## 3. 이미 생성된 에셋 재인코딩 (옵션)

CONCEPT 변경 없이 기존 PNG 를 WebP 로 한꺼번에 변환하려면 Bash 로 직접:

```bash
# Phaser 프로젝트라면
find generated-assets -name "*.png" -exec sh -c '
  sharp="$(npm exec -c "which sharp" 2>/dev/null)"
  # 또는 cwebp 사용
  cwebp -q 90 "$1" -o "${1%.png}.webp" && rm "$1"
' _ {} \;
```

또는 각 에셋을 `asset_edit_image` 에 통과시키지 말고 그냥 포맷 변환만 스크립트로 처리.

## 체크리스트

```
✔ 엔진 감지 확인      → asset_analyze_project 의 engine 필드
✔ 포맷 기본값 동작   → 생성 후 파일 확장자 확인 (.webp 또는 .png)
✔ 크기 스캔 실행      → asset_scan_display_sizes (코드 있는 프로젝트)
✔ size 파라미터 전달  → 각 asset_generate_* 호출
✔ 생성 후 확인       → asset_review 로 파일 크기·크로마 잔류 검사
```

## 연관 스킬

- **크기 조정 후 품질 확인**: `minigame-assets-review`
- **엔진별 로딩 코드 변경** (`.png` → `.webp` 참조): `minigame-assets-engine-load`
- **전체 워크플로 재확인**: `minigame-assets-workflow`
