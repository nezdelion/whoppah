#!/usr/bin/env bash
# Plugin tests (pytest) in one shared venv: created on the first run, reused afterwards.
#
#   tools/test_plugin.sh [pytest args]     e.g. tools/test_plugin.sh -q -k epoch
#
# The venv is .venv in the main checkout (git-ignored, shared with tools/dev_octoprint.sh), also when run from a
# git worktree: the tests import the plugin from this checkout's octoprint-plugin/, not from the venv.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN="$(cd "$(git -C "$ROOT" rev-parse --git-common-dir)/.." && pwd)"
VENV="${VENV:-$MAIN/.venv}"
PYTHON="${PYTHON:-python3.12}"

if [ ! -x "$VENV/bin/octoprint" ] || ! "$VENV/bin/python" -c "import pytest" 2>/dev/null; then
  if command -v uv >/dev/null 2>&1; then
    [ -x "$VENV/bin/python" ] || uv venv "$VENV" --python "$PYTHON"
    uv pip install --python "$VENV/bin/python" "OctoPrint~=1.11.0" pytest
  else
    [ -x "$VENV/bin/python" ] || "$PYTHON" -m venv "$VENV"
    "$VENV/bin/pip" install "OctoPrint~=1.11.0" pytest
  fi
fi

cd "$ROOT/octoprint-plugin"
exec "$VENV/bin/python" -m pytest -p no:cacheprovider "$@"
