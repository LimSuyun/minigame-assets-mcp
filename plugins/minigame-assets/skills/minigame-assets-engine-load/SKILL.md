---
name: minigame-assets-engine-load
description: Use this skill when the user asks how to load generated assets into their game engine's runtime code — Phaser 3 atlas, Unity sprite import workflow, Cocos Creator plist, Godot SpriteFrames. Triggers on phrases like "Phaser 로딩 코드", "Unity 에 어떻게 넣어", "Cocos atlas 사용법", "Godot import", "게임 코드에 연결", "load atlas", "import sprite", "use in engine".
version: 2.1.0
---

# Minigame Assets — 엔진별 로딩 코드

생성된 에셋을 실제 게임 코드에 연결하는 방법. 엔진별 atlas 포맷은 `asset_generate_sprite_sheet` 의 `export_formats` 파라미터로 자동 생성되므로, 사용자는 로딩 코드만 작성하면 됩니다.

## Phaser 3

### Atlas (애니메이션)
```javascript
// preload
this.load.atlas(
  'hero',                 // 텍스처 key
  'assets/hero_sheet.webp',
  'assets/hero_phaser.json'
);

// create
const hero = this.add.sprite(400, 300, 'hero', 'idle_f00');
this.anims.create({
  key: 'hero_idle',
  frames: this.anims.generateFrameNames('hero', {
    prefix: 'idle_f',
    start: 0,
    end: 5,
    zeroPad: 2,
  }),
  frameRate: 8,
  repeat: -1,
});
hero.play('hero_idle');
```

### 개별 스프라이트
```javascript
this.load.image('coin', 'assets/coin.webp');
this.load.image('forest_bg', 'assets/backgrounds/forest.webp');
```

### 배경음 · 효과음
```javascript
this.load.audio('bgm', 'assets/music/forest_bgm.mp3');
```

**WebP 주의**: Phaser 3 는 브라우저 내장 디코더를 쓰므로 모던 브라우저(Chrome/Safari 14+/Firefox 65+)에서 기본 작동. iOS Safari 13 이하는 PNG fallback 필요.

## Unity

Unity 는 런타임 WebP 로드를 기본 지원하지 않으므로, 이 MCP 는 Unity 프로젝트 감지 시 **PNG 로 저장**합니다.

### Sprite import
```
1. Assets 폴더에 _sheet.png 복사
2. Texture Import Settings:
   - Texture Type: Sprite (2D and UI)
   - Sprite Mode: Multiple
   - Pixels Per Unit: 100 (또는 프로젝트 규격)
3. Sprite Editor 열기:
   - Slice > Type: Grid By Cell Size
   - Cell Size: {frameWidth} × {frameHeight}   ← unity.json 참조
4. Apply
```

### 런타임 로드
```csharp
using UnityEngine;

public class HeroAnimation : MonoBehaviour
{
    [SerializeField] private Sprite[] idleFrames;  // 에디터에서 드래그

    private int currentFrame = 0;
    private SpriteRenderer sr;

    void Start() {
        sr = GetComponent<SpriteRenderer>();
        InvokeRepeating(nameof(NextFrame), 0, 0.125f);  // 8 fps
    }

    void NextFrame() {
        sr.sprite = idleFrames[currentFrame];
        currentFrame = (currentFrame + 1) % idleFrames.Length;
    }
}
```

### WebP 를 Unity 에서 쓰려면
커뮤니티 패키지 `com.netpyoung.webp` 또는 유료 `Unity.WebP` 도입. 런타임 디코딩 비용 있음 — 권장 안 함.

## Cocos Creator 3+

### Atlas 로드
```javascript
import { SpriteAtlas, resources, Sprite } from 'cc';

resources.load('hero_cocos', SpriteAtlas, (err, atlas) => {
  const sprite = node.getComponent(Sprite);
  sprite.spriteFrame = atlas.getSpriteFrame('idle_f00.webp');
});
```

### Plist atlas (Cocos2d-x 스타일)
```javascript
spriteFrameCache.addSpriteFramesWithFile('hero_cocos.plist');
const frame = spriteFrameCache.getSpriteFrame('hero_idle_f00.webp');
sprite.spriteFrame = frame;
```

### 애니메이션 클립
Cocos Creator 에디터에서:
1. Assets 에 모든 프레임을 AnimationClip 에 추가
2. Animation 컴포넌트에 클립 할당
3. `animation.play('idle')`

## Godot 3+ / 4+

### AnimatedSprite2D
```gdscript
extends AnimatedSprite2D

func _ready():
    # SpriteFrames 리소스에 프레임 추가
    sprite_frames.add_animation("idle")
    for i in range(6):
        var tex = load("res://assets/hero_idle_f%02d.webp" % i)
        sprite_frames.add_frame("idle", tex)
    sprite_frames.set_animation_speed("idle", 8)
    play("idle")
```

### SpriteFrames 리소스 (권장 — 에디터에서)
1. SpriteFrames 새 리소스 생성
2. 애니메이션 추가 (idle, walk, attack 등)
3. 각 애니메이션에 프레임 드래그
4. AnimatedSprite2D 노드의 SpriteFrames 필드에 할당

Godot 4 는 `.webp` first-class 지원 — `load("res://path.webp")` 바로 작동.

## 파일 확장자 자동 선택 규칙

`asset_generate_*` 는 엔진을 감지해 확장자를 자동 결정:
- Phaser / Cocos / Godot → `.webp`
- Unity / unknown → `.png`

Atlas JSON / Cocos plist 의 `meta.image` / `textureFileName` 도 실제 확장자로 자동 설정되므로 로딩 코드는 MCP 가 출력한 JSON 을 그대로 쓰면 됩니다.

## 연관 스킬

- **Atlas 가 안 생겼다면**: `minigame-assets-workflow` 의 sprite_sheet 단계 확인
- **로드는 됐는데 크기가 이상하다면**: `minigame-assets-optimize` 의 display-size scanner
- **WebP 지원 안하는 엔진이라면 PNG 강제**: `ASSET_OUTPUT_FORMAT=png`
