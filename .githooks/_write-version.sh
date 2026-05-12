#!/usr/bin/env bash
# Regenerates version.js from the current git state. Sourced by post-merge,
# post-checkout, and post-commit so the Settings header always matches HEAD.
#
# Output format: window.APP_VERSION = '<git-describe>';
#   - With tags:    '1.5.0'  or  '1.5.0-3-gabc123'  (3 commits past v1.5.0)
#   - Without tags: '<short-sha>'  (e.g., 'b1bda4f')
#   - Dirty tree:   '<above>-dirty'

set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
version="$(git describe --tags --always --dirty 2>/dev/null || echo 'unknown')"
printf "window.APP_VERSION = '%s';\n" "$version" > "$repo_root/version.js"
