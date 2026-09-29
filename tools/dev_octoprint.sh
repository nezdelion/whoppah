#!/usr/bin/env bash
# Local OctoPrint 1.11 with Virtual Printer and this plugin installed in editable mode.
#
#   tools/dev_octoprint.sh            create the venv (first run), build the app into the plugin, start OctoPrint
#   PORT=5001 VENV=.venv BASE=.octoprint-dev PYTHON=python3.12 tools/dev_octoprint.sh
#
# The app is copied into the plugin package on every start (tools/build_plugin.py --no-zip); restart to pick up changes.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="${VENV:-$ROOT/.venv}"
BASE="${BASE:-$ROOT/.octoprint-dev}"
PORT="${PORT:-5001}"
PYTHON="${PYTHON:-python3.12}"

if [ ! -x "$VENV/bin/octoprint" ]; then
  if command -v uv >/dev/null 2>&1; then
    uv venv "$VENV" --python "$PYTHON"
    uv pip install --python "$VENV/bin/python" "OctoPrint~=1.11.0"
  else
    "$PYTHON" -m venv "$VENV"
    "$VENV/bin/pip" install "OctoPrint~=1.11.0"
  fi
fi

# (re)install the plugin in editable mode when it is missing
if ! "$VENV/bin/python" -c "import octoprint_plotter" 2>/dev/null; then
  if command -v uv >/dev/null 2>&1; then
    uv pip install --python "$VENV/bin/python" -e "$ROOT/octoprint-plugin"
  else
    "$VENV/bin/pip" install -e "$ROOT/octoprint-plugin"
  fi
fi

python3 "$ROOT/tools/build_plugin.py" --no-zip

mkdir -p "$BASE"
if [ ! -f "$BASE/config.yaml" ]; then
  cat > "$BASE/config.yaml" <<YAML
server:
  host: 127.0.0.1
  port: $PORT
  onlineCheck:
    enabled: false
plugins:
  _disabled: [softwareupdate, announcements, tracking, discovery, errortracking]
  virtual_printer:
    _config_version: 1
    enabled: true
serial:
  port: VIRTUAL
  autoconnect: true
  baudrate: 0
YAML
  echo "Fresh base directory $BASE: open http://127.0.0.1:$PORT/ and finish the setup wizard (create the first user)."
fi

exec "$VENV/bin/octoprint" --basedir "$BASE" serve --port "$PORT"
