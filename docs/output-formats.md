# 출력 포맷과 엔진 감지

## 포맷 자동 결정

작업 디렉토리의 게임 엔진을 자동 감지해 PNG/WebP가 결정됩니다.

| 엔진 | 기본 포맷 | 용량 비교 (캐릭터 베이스 실측) |
|---|---|---|
| Phaser 3 | **WebP** | 2.03 MB → 250 KB (**−87.7%**) |
| Cocos Creator 3 | **WebP** | 동일 수준 |
| Godot 3+ | **WebP** | 동일 수준 |
| Unity | PNG | 런타임 WebP 미지원 |
| 엔진 미감지 | PNG | 안전한 기본값 |

결정 우선순위:
1. 각 도구 호출의 `output_format` 파라미터 (명시 지정)
2. `ASSET_OUTPUT_FORMAT=png|webp` 환경변수 (전역 override)
3. 자동 감지된 엔진 → WebP 지원 여부
4. fallback: PNG

**PNG 고정:**
```bash
export ASSET_OUTPUT_FORMAT=png
```

입력 파일이 이미 PNG이고 PNG로 저장되는 경우 sharp 재인코딩을 건너뛰어 원본 바이트를 보존합니다 (재인코딩으로 오히려 15% 커지는 현상 회피).

Atlas JSON / Phaser Loader 등 엔진별 export는 실제 파일 확장자로 자동 참조됩니다.

---

## Display-size Scanner

이미 게임 코드가 있는 프로젝트는 **실제 런타임 표시 크기** 에 맞춰 생성할 수 있습니다.

```
asset_scan_display_sizes  project_path: "."
```

감지 패턴:
- **Phaser**: `add.sprite(x, y, 'key').setDisplaySize(w, h)`, `.setScale(n)` + `load.image/spritesheet/atlas(key, path)`
- **Cocos Creator**: `.setContentSize(w, h)` + `resources.load(path)`
- **Godot**: `$Sprite.scale = Vector2(n, n)` + `preload/load("res://...")`

출력 예:
```json
{
  "detections": [
    {
      "asset_key": "hero",
      "display_width": 64,
      "display_height": 64,
      "suggested_generation_size": 128,
      "asset_urls": ["assets/characters/hero.png"]
    },
    {
      "asset_key": "forest_bg",
      "display_width": 800,
      "display_height": 600,
      "suggested_generation_size": 1024,
      "asset_urls": ["assets/backgrounds/forest.webp"]
    }
  ]
}
```

- `suggested_generation_size` 를 `asset_generate_*` 의 `size` 파라미터로 넘기면 1024 기본값 대신 딱 맞는 크기로 생성 → 추가 용량 절감. 2× 헤드룸 + multiple-of-64 스냅 적용.
- `asset_urls[]` 는 `asset_deploy` 의 `deploy_targets[].path` 힌트로 그대로 재사용 가능.

---

## Atlas JSON

스프라이트 시트를 엔진별 포맷으로 내보냅니다.

```
asset_generate_atlas_json
  source_image: ".minigame-assets/sprites/hero_sheet.png"
  engine: "phaser" | "unity" | "cocos" | "generic"
  rows: 1
  cols: 8
```

각 프레임 좌표·크기를 엔진이 요구하는 JSON 스키마로 직렬화합니다.
