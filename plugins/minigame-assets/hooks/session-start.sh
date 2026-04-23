#!/bin/bash
# Background auto-update for the minigame-assets plugin.
#
# Fires on SessionStart. Throttled to once per 6 hours via a marker file.
# Runs `claude plugin marketplace update` + `claude plugin update` in the
# background so session start is never blocked. Updates take effect on the
# NEXT Claude Code session (the CLI reports "restart required to apply").
#
# Opt out: set MINIGAME_ASSETS_AUTO_UPDATE=0 in the shell environment.

set -euo pipefail

# User opt-out
if [ "${MINIGAME_ASSETS_AUTO_UPDATE:-1}" = "0" ]; then
  exit 0
fi

MARKER="${HOME}/.claude/plugins/.minigame-assets-last-update"
INTERVAL_SECONDS=21600  # 6 hours

# Throttle check
if [ -f "$MARKER" ]; then
  now=$(date +%s)
  # macOS: stat -f %m, Linux: stat -c %Y
  last=$(stat -f %m "$MARKER" 2>/dev/null || stat -c %Y "$MARKER" 2>/dev/null || echo 0)
  if [ $((now - last)) -lt "$INTERVAL_SECONDS" ]; then
    exit 0
  fi
fi

# Locate claude CLI — fall back to common install paths if PATH is minimal
CLAUDE_BIN="$(command -v claude 2>/dev/null || true)"
if [ -z "$CLAUDE_BIN" ]; then
  for candidate in "${HOME}/.local/bin/claude" "/opt/homebrew/bin/claude" "/usr/local/bin/claude"; do
    if [ -x "$candidate" ]; then
      CLAUDE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "$CLAUDE_BIN" ]; then
  # Can't find the CLI — silently give up; user can still update manually.
  exit 0
fi

# Detached background update so SessionStart is not blocked by network I/O.
(
  "$CLAUDE_BIN" plugin marketplace update minigame-assets-mcp >/dev/null 2>&1 || true
  "$CLAUDE_BIN" plugin update minigame-assets --scope user >/dev/null 2>&1 || true
  mkdir -p "$(dirname "$MARKER")"
  touch "$MARKER"
) &

# Detach from the parent so the shell won't wait on our background job.
disown 2>/dev/null || true

exit 0
