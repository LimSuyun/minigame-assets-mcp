#!/bin/bash
# UserPromptSubmit hook — 미니게임 에셋 생성 의도 감지 시 사전 조건 검증.
#
# 동작:
#   1. 프롬프트에서 에셋 생성 의도 키워드 감지
#   2. 감지됐으면 OPENAI_API_KEY 확인 → 없으면 차단(exit 2)
#   3. .minigame-assets/ 디렉토리 없으면 CONCEPT.md 설정 안내 출력(비차단)
#
# Opt-out: MINIGAME_ASSETS_INTENT_CHECK=0 환경변수 설정 시 비활성화

set -euo pipefail

if [ "${MINIGAME_ASSETS_INTENT_CHECK:-1}" = "0" ]; then
  exit 0
fi

# stdin에서 JSON 파싱 — python3 없으면 그냥 통과
INPUT=$(cat)
PROMPT=$(printf '%s' "$INPUT" \
  | python3 -c "import sys,json; print(json.load(sys.stdin).get('prompt',''))" 2>/dev/null \
  || echo "")

if [ -z "$PROMPT" ]; then
  exit 0
fi

# ── 에셋 생성 의도 키워드 감지 ──────────────────────────────────────────────
# 오탐을 줄이기 위해 "에셋"·"스프라이트" 등 게임 에셋에 특화된 단어만 사용.
# 일반적인 "이미지"·"캐릭터"만으로는 트리거하지 않음.
ASSET_PATTERN='에셋|스프라이트|스프라이트\s*시트|타일셋|타일\s*세트|배경\s*이미지|게임\s*(이미지|캐릭터|배경|아이콘|로고|썸네일)|asset|sprite\s*sheet|tileset|game\s*asset|game\s*character|generate.*asset'

if ! echo "$PROMPT" | grep -qiP "$ASSET_PATTERN" 2>/dev/null; then
  # grep -P 미지원 환경 대비 (macOS 기본 grep)
  if ! echo "$PROMPT" | grep -qiE "$ASSET_PATTERN" 2>/dev/null; then
    exit 0
  fi
fi

# ── OPENAI_API_KEY 검증 ──────────────────────────────────────────────────────
if [ -z "${OPENAI_API_KEY:-}" ]; then
  # macOS Keychain fallback
  KC_KEY=$(security find-generic-password -l "OPENAI_API_KEY" -w 2>/dev/null || true)
  if [ -z "$KC_KEY" ]; then
    printf '\n⛔  OPENAI_API_KEY가 설정되지 않았습니다.\n'
    printf '    에셋 생성 도구는 OpenAI API 키가 필요합니다.\n'
    printf '    해결 방법:\n'
    printf '      export OPENAI_API_KEY=sk-...\n'
    printf '    또는 .env 파일 / Keychain에 등록 후 재시도하세요.\n\n'
    exit 2
  fi
fi

# ── CONCEPT.md 설정 안내 (비차단) ───────────────────────────────────────────
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ASSETS_DIR="$PROJECT_DIR/.minigame-assets"

if [ ! -f "$ASSETS_DIR/CONCEPT.md" ] && [ ! -f "$ASSETS_DIR/game-concept.json" ]; then
  printf '\n💡  .minigame-assets/CONCEPT.md 가 없습니다.\n'
  printf '    /setup-minigame-assets-concept 으로 먼저 게임 컨셉을 설정하면\n'
  printf '    아트 스타일·색상 팔레트가 모든 에셋에 자동 적용됩니다.\n\n'
fi

exit 0
