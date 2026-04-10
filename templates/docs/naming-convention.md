# 파일 네이밍 규칙

> 모든 에셋 파일은 이 규칙을 반드시 따른다.
> 일관된 네이밍은 MCP 자동화 도구의 정확한 동작을 보장한다.

---

## 기본 패턴

```
[카테고리]_[이름]_[상태]_[번호].ext
```

| 구성요소 | 설명 | 규칙 |
|---------|------|------|
| 카테고리 | 에셋 종류 | 소문자, 아래 표 참조 |
| 이름 | 구체적 대상 | 소문자, 언더스코어 구분 |
| 상태 | 애니메이션 상태 | 소문자, 생략 가능 |
| 번호 | 프레임 번호 | 2자리 zero-padding (00, 01, ...) |
| ext | 확장자 | png, ogg, mp3, json |

**규칙 요약**
- 모두 소문자
- 단어 구분은 언더스코어(`_`)만 사용
- 하이픈(`-`), 공백, 대문자 사용 금지
- 번호는 반드시 2자리 (00 ~ 99)

---

## 카테고리 코드

| 카테고리 코드 | 대상 |
|-------------|------|
| `char` | 캐릭터, 유닛 (플레이어, 적, 포탑) |
| `tile` | 타일셋 |
| `proj` | 투사체 (총알, 미사일) |
| `fx` | 이펙트 (폭발, 히트, 연기) |
| `ui` | UI 요소 |
| `bg` | 배경 이미지 |
| `sfx` | 효과음 |
| `bgm` | 배경음악 |

---

## 상태(state) 코드

| 상태 코드 | 설명 |
|----------|------|
| `idle` | 대기 |
| `walk` | 걷기 |
| `run` | 뛰기 |
| `attack` | 공격 |
| `hit` | 피격 |
| `death` | 사망 |
| `shoot` | 발사 |
| `place` | 설치 |

---

## 파일명 예시

### 캐릭터 / 유닛

```
char_player_idle_00.png       ← 플레이어 idle 0번 프레임
char_player_idle_01.png
char_player_attack_00.png
char_enemy_basic_walk_00.png  ← 기본 적 walk 0번 프레임
char_enemy_fast_walk_00.png   ← 빠른 적
char_turret_basic_idle_00.png ← 기본 포탑
char_turret_sniper_shoot_00.png
```

### 스프라이트 시트 (묶음 파일)

```
char_player_sheet.png         ← 전체 스프라이트 시트
char_player_sheet.json        ← 프레임 좌표 메타데이터
char_enemy_basic_sheet.png
char_enemy_basic_sheet.json
```

### 타일셋

```
tile_ground_dirt.png          ← 흙 바닥
tile_ground_road.png          ← 도로
tile_wall_top.png             ← 위쪽 벽
tile_wall_corner_tl.png       ← 좌상단 코너
tile_path_right.png           ← 우측 방향 경로
tile_zone_placement.png       ← 포탑 설치 영역
```

### 투사체

```
proj_bullet_basic.png         ← 기본 총알 (단일 이미지)
proj_bullet_big.png
proj_missile_default.png
proj_laser_beam.png
```

### 이펙트

```
fx_explode_small_00.png       ← 소형 폭발 0번 프레임
fx_explode_small_01.png
...
fx_explode_small_07.png
fx_explode_large_00.png
fx_hit_spark_00.png
fx_muzzle_flash_00.png
fx_smoke_00.png

fx_explode_small_sheet.png    ← 시트 파일
fx_explode_small_sheet.json
```

### UI

```
ui_hpbar_bg.png               ← HP바 배경
ui_hpbar_fill.png             ← HP바 게이지
ui_icon_coin.png              ← 코인 아이콘
ui_icon_wave.png              ← 웨이브 아이콘
ui_btn_pause.png              ← 일시정지 버튼
ui_btn_retry.png              ← 재시작 버튼
ui_panel_gameover_bg.png      ← 게임오버 패널 배경
ui_panel_victory_bg.png       ← 승리 패널 배경
ui_card_turret_basic.png      ← 포탑 선택 카드
```

### 배경

```
bg_layer_0.png                ← 가장 뒤 배경 (패럴렉스 0)
bg_layer_1.png                ← 중간 배경 (패럴렉스 1)
bg_layer_2.png                ← 앞 배경 (패럴렉스 2)
```

### 오디오

```
sfx_shoot_basic.ogg
sfx_shoot_missile.ogg
sfx_explode_small.ogg
sfx_explode_large.ogg
sfx_enemy_die.ogg
sfx_place_turret.ogg
sfx_wave_start.ogg
sfx_game_over.ogg
sfx_victory.ogg
sfx_coin.ogg
bgm_main.mp3
bgm_menu.mp3
```

---

## 폴더 구조

```
assets/
├── sprites/
│   ├── player/
│   │   ├── char_player_sheet.png
│   │   └── char_player_sheet.json
│   ├── enemies/
│   │   ├── char_enemy_basic_sheet.png
│   │   ├── char_enemy_basic_sheet.json
│   │   ├── char_enemy_fast_sheet.png
│   │   └── char_enemy_fast_sheet.json
│   └── turrets/
│       ├── char_turret_basic_sheet.png
│       ├── char_turret_basic_sheet.json
│       ├── char_turret_sniper_sheet.png
│       └── char_turret_sniper_sheet.json
├── tilesets/
│   ├── tile_main_sheet.png
│   └── tile_main_sheet.json
├── effects/
│   ├── fx_explode_small_sheet.png
│   ├── fx_explode_small_sheet.json
│   ├── fx_explode_large_sheet.png
│   ├── fx_explode_large_sheet.json
│   ├── fx_hit_spark_sheet.png
│   ├── fx_hit_spark_sheet.json
│   ├── fx_muzzle_flash_sheet.png
│   └── fx_muzzle_flash_sheet.json
├── ui/
│   ├── hud/
│   │   ├── ui_hpbar_bg.png
│   │   ├── ui_hpbar_fill.png
│   │   ├── ui_icon_coin.png
│   │   └── ui_icon_wave.png
│   └── panels/
│       ├── ui_panel_gameover_bg.png
│       ├── ui_panel_victory_bg.png
│       ├── ui_btn_retry.png
│       └── ui_btn_pause.png
├── backgrounds/
│   ├── bg_layer_0.png
│   ├── bg_layer_1.png
│   └── bg_layer_2.png
└── audio/
    ├── sfx/
    │   ├── sfx_shoot_basic.ogg
    │   ├── sfx_explode_small.ogg
    │   └── ...
    └── bgm/
        ├── bgm_main.mp3
        └── bgm_menu.mp3
```
