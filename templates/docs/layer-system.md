# 레이어 시스템 (Phaser 3 기준)

---

## Screen vs Layer (혼동 방지)

이 두 개념은 **다른 축**입니다:

- **Screen (Phaser Scene)** — 전환 단위. 한 번에 하나(또는 stacked)가 활성. 예: `LoadingScene`, `LobbyScene`, `GameScene`, `UIScene`
- **Layer (setDepth 값)** — **하나의 Scene 내부의** 렌더링 순서. 0(뒤) ↔ 5(앞)

| 에셋 종류 | 소속 | 설명 |
|---|---|---|
| 로딩 화면 아트 | **LoadingScene의 풀스크린 배경** (Scene 레벨) | depth 체계 밖 — Scene 자체가 다른 씬들과 전환됨 |
| 로비/메뉴 아트 | **LobbyScene의 풀스크린 배경** (Scene 레벨) | 동일 |
| 게임 배경 | GameScene의 Layer 0 (배경) | GameScene 내부 depth 0 |
| 유닛 스프라이트 | GameScene의 Layer 2 (유닛) | GameScene 내부 depth 2 |
| UI 요소 | UIScene 전체 (또는 GameScene의 Layer 5) | 별도 씬이면 씬 자체가 최상단, 같은 씬이면 depth 5 |

예시 흐름:
```
앱 기동 → LoadingScene (loading_screen.png 풀스크린 배경 + 프로그레스 바)
       ↓ (로드 완료)
       → LobbyScene (lobby_screen.png 풀스크린 + 메뉴 UI)
       ↓ ("게임 시작" 버튼)
       → GameScene (Layer 0~4) + UIScene stacked (Layer 5 역할)
```

---

## GameScene 내부 레이어 구조

| depth | 이름 | 포함 오브젝트 | 설명 |
|-------|------|------------|------|
| 5 | UI | HP바, 웨이브 표시, 버튼, 패널 | 항상 최상단 (UIScene 분리 권장) |
| 4 | 이펙트 | 폭발, 히트 스파크, 머즐 플래시 | 유닛보다 앞 |
| 3 | 투사체 | 총알, 미사일, 레이저 | |
| 2 | 유닛 | 적, 포탑, 방어 구조물, 플레이어 캐릭터 | |
| 1 | 맵 / 타일 | 타일맵, 경로 표시 | |
| 0 | 배경 | 패럴렉스 배경 레이어 | 항상 최하단 |

---

## MCP 도구별 Layer / Scene 매핑

각 `asset_generate_*` 도구가 어느 Scene/Layer에 쓰이도록 설계된 에셋을 생성하는지:

| MCP 도구 | 소속 | 비고 |
|---|---|---|
| `asset_generate_loading_screen` | **LoadingScene** (풀스크린 배경) | Scene 레벨 — depth 체계 밖 |
| `asset_generate_lobby_screen` | **LobbyScene** (풀스크린 배경) | Scene 레벨 — `menu_side` 영역에 UI 올림 |
| `asset_generate_screen_background` | GameScene **Layer 0** | `style: parallax` 시 0.0/0.1/0.2 sub-depth |
| `asset_generate_character_base` | GameScene **Layer 2** (유닛) | 플레이어·적·NPC·몬스터 |
| `asset_generate_character_equipped` | GameScene **Layer 2** (유닛) | 장비 착용 버전, base와 동일 레이어 |
| `asset_generate_sprite_sheet` | GameScene **Layer 2** (유닛 애니메이션) | |
| `asset_generate_action_sprite` | GameScene **Layer 2** | 단일 액션 프레임 |
| `asset_generate_weapons` | **Layer 3** (투사체) 또는 **Layer 5** (UI 인벤토리) | 용도에 따라 배치 |
| `asset_generate_effect_sheet` | GameScene **Layer 4** (이펙트) | 폭발·충격파 등 |
| `asset_generate_tileset` | GameScene **Layer 1** (맵/타일) | 타일맵용 |
| `asset_generate_ui_*` / `asset_generate_hud_set` | **UIScene** 또는 GameScene **Layer 5** | UI 씬 분리 권장 |
| `asset_generate_app_logo` | Scene 외 (앱 아이콘·마케팅) | |
| `asset_generate_thumbnail` | Scene 외 (스토어 썸네일) | |

---

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
