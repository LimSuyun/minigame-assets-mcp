# 레이어 시스템 (Phaser 3 기준)

---

## 레이어 구조

| depth | 이름 | 포함 오브젝트 | 설명 |
|-------|------|------------|------|
| 5 | UI | HP바, 웨이브 표시, 버튼, 패널 | 항상 최상단 |
| 4 | 이펙트 | 폭발, 히트 스파크, 머즐 플래시 | 유닛보다 앞 |
| 3 | 투사체 | 총알, 미사일, 레이저 | |
| 2 | 유닛 | 적, 포탑, 방어 구조물 | |
| 1 | 맵 / 타일 | 타일맵, 경로 표시 | |
| 0 | 배경 | 패럴렉스 배경 레이어 | 항상 최하단 |

---

## Phaser 3 구현

### 씬 구조

```typescript
// GameScene.ts
class GameScene extends Phaser.Scene {
  create() {
    // Layer 0: 배경
    this.createBackground();

    // Layer 1: 타일맵
    const map = this.make.tilemap({ key: 'tilemap' });
    const tileset = map.addTilesetImage('tile_main_sheet');
    const groundLayer = map.createLayer('ground', tileset);
    groundLayer.setDepth(1);

    // Layer 2: 유닛 (적, 포탑)
    this.enemies = this.physics.add.group();
    this.turrets = this.add.group();
    // → 개별 오브젝트에서 setDepth(2)

    // Layer 3: 투사체
    this.bullets = this.physics.add.group();
    // → 개별 오브젝트에서 setDepth(3)

    // Layer 4: 이펙트
    this.effects = this.add.group();
    // → 개별 오브젝트에서 setDepth(4)

    // Layer 5: UI (별도 씬으로 분리 권장)
    this.scene.launch('UIScene');
  }
}
```

### 오브젝트 depth 설정

```typescript
// 적 유닛
const enemy = this.enemies.create(x, y, 'char_enemy_basic_sheet');
enemy.setDepth(2);

// 총알
const bullet = this.bullets.create(x, y, 'proj_bullet_basic');
bullet.setDepth(3);

// 폭발 이펙트
const explosion = this.effects.get(x, y, 'fx_explode_small_sheet');
explosion.setDepth(4);
explosion.setActive(true).setVisible(true);
```

### UI 씬 분리

UI는 별도 씬으로 분리하면 게임 로직과 완전히 독립되어 관리가 용이하다.

```typescript
// UIScene.ts — GameScene 위에 launch되어 항상 최상단 유지
class UIScene extends Phaser.Scene {
  constructor() {
    super({ key: 'UIScene' });
  }

  create() {
    // HP 바
    this.hpBarBg   = this.add.image(20, 20, 'ui_hpbar_bg').setOrigin(0, 0.5);
    this.hpBarFill = this.add.image(20, 20, 'ui_hpbar_fill').setOrigin(0, 0.5);

    // 웨이브 표시
    this.waveText = this.add.text(195, 20, 'Wave 1 / 5', {
      fontSize: '16px', fontFamily: 'Arial'
    }).setOrigin(0.5, 0.5);

    // 코인
    this.coinIcon = this.add.image(340, 20, 'ui_icon_coin');
    this.coinText = this.add.text(360, 20, '100');
  }
}
```

---

## 레이어 설계 원칙

1. **에셋 파일에는 레이어 정보를 포함하지 않는다.** 레이어는 항상 씬 코드에서 `setDepth()`로 지정한다.
2. **UI는 반드시 게임 오브젝트보다 높은 depth**에 위치해야 한다.
3. **이펙트는 유닛보다 높고 UI보다 낮은 depth**에 위치한다 (depth: 4).
4. **같은 depth의 오브젝트**는 씬에 추가된 순서대로 렌더링된다 (나중에 추가될수록 앞).
5. **패럴렉스 배경은 depth 0**에서 여러 레이어를 구분할 때 소수점 사용 가능 (0.0, 0.1, 0.2).

---

## 패럴렉스 배경 설정

```typescript
// 배경 레이어 (depth 0.x 사용)
const bg0 = this.add.tileSprite(0, 0, 390, 844, 'bg_layer_0').setOrigin(0).setDepth(0.0);
const bg1 = this.add.tileSprite(0, 0, 390, 844, 'bg_layer_1').setOrigin(0).setDepth(0.1);
const bg2 = this.add.tileSprite(0, 0, 390, 844, 'bg_layer_2').setOrigin(0).setDepth(0.2);

// update()에서 속도 다르게 스크롤
update() {
  bg0.tilePositionX += 0.2;  // 가장 느리게
  bg1.tilePositionX += 0.5;
  bg2.tilePositionX += 1.0;  // 가장 빠르게
}
```
