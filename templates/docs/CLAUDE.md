# 슈팅+디펜스 미니게임 — Claude Code 컨텍스트

## 프로젝트 개요

| 항목 | 내용 |
|------|------|
| 장르 | 2D 슈팅 + 타워 디펜스 미니게임 |
| 배포 플랫폼 | 앱인토스 (Apps in Toss) |
| 실행 환경 | 모바일 WebView (iOS / Android) |
| 기준 해상도 | 390 × 844 px (iPhone 14 기준) |

## 기술 스택

| 역할 | 기술 |
|------|------|
| 게임 엔진 | Phaser 3 |
| 번들러 | Vite |
| 언어 | TypeScript |
| 앱인토스 SDK | @apps-in-toss/web-framework |
| 에셋 처리 | Sharp (스프라이트 슬라이싱) |

## 레이어 구조 (z-index)

```
Layer 5 : UI          — HP바, 웨이브 표시, 버튼
Layer 4 : 이펙트       — 폭발, 히트 스파크
Layer 3 : 투사체       — 총알, 미사일
Layer 2 : 유닛         — 적, 포탑, 구조물
Layer 1 : 맵/타일      — 타일맵, 경로
Layer 0 : 배경         — 패럴렉스 배경
```

Phaser 3 코드 기준:
```typescript
// 씬 내 depth 값으로 제어
gameObject.setDepth(3); // 투사체
```

## 에셋 핵심 규칙 (요약)

> 상세 스펙은 각 docs/ 파일 참조

- **스프라이트**: 48×48px, PNG-32 (투명 배경 필수)
- **타일**: 32×32px, PNG-32
- **이펙트**: 64×64px (소) / 128×128px (대), 스프라이트 시트
- **UI**: 390px 기준, PNG 또는 SVG
- **오디오**: OGG (SFX) / MP3 or OGG (BGM)
- **네이밍**: `[카테고리]_[이름]_[상태]_[번호].ext`

## 참조 문서

| 문서 | 경로 | 내용 |
|------|------|------|
| 에셋 전체 스펙 | `docs/asset-spec.md` | 크기·포맷·프레임 수 등 제작 기준 |
| 파일 네이밍 | `docs/naming-convention.md` | 파일명·폴더 구조 규칙 |
| 레이어 시스템 | `docs/layer-system.md` | Phaser 3 레이어 설계 |
| 게임 디자인 | `docs/game-design.md` | 웨이브·포탑·적 유닛 설계 |

## MCP 도구 목록

| 도구 | 설명 |
|------|------|
| `generate_asset_prompt` | 에셋 종류를 입력하면 AI 이미지 생성 프롬프트 반환 |
| `slice_spritesheet` | 스프라이트 시트를 프레임 단위로 슬라이싱 |
| `generate_atlas_json` | 스프라이트 시트 → TexturePacker 호환 JSON 생성 |
| `rename_assets` | 네이밍 규칙에 맞게 파일 일괄 정리 |
| `validate_assets` | 에셋 규격(크기·포맷·네이밍) 검사 |

MCP 설정: `.mcp.json` 참조

## 작업 시 주의사항

1. 에셋 파일에는 레이어 정보를 넣지 않는다. 레이어는 Phaser 씬 코드에서 `setDepth()`로 지정.
2. 모든 스프라이트는 투명 배경(PNG-32 RGBA)으로 제작.
3. 피벗 포인트: 캐릭터=발바닥 중앙, 포탑=중심, 투사체=발사 기준점.
4. 이펙트는 반드시 비루프 + 오브젝트 풀링으로 관리.
5. 앱인토스 WebView 환경이므로 WebGL 성능 주의 — 드로우콜 최소화.
