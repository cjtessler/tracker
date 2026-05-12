#!/usr/bin/env bash
# Regenerates version.js so the in-app version stamp matches HEAD during
# Claude Code sessions on the web (where .githooks/ is not auto-installed).
set -euo pipefail
exec bash "$CLAUDE_PROJECT_DIR/.githooks/_write-version.sh"
