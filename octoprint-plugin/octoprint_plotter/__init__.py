"""OctoPrint-Plotter: serves the plotter web app as a full-screen page and stores its settings.

The plugin is deliberately thin: static files, ``env.json`` and a small REST API for the app settings.
All plotting logic lives in the browser application.
"""

import json
import math
import os
import threading
from datetime import datetime, timezone
from urllib.parse import quote

import flask
import octoprint.plugin
from octoprint.access import ADMIN_GROUP
from octoprint.access.permissions import Permissions

from ._version import __version__
from .position import PositionReader, epoch_parts

__plugin_name__ = "Plotter"
__plugin_version__ = __version__
__plugin_pythoncompat__ = ">=3.9,<4"
__plugin_description__ = "Pen plotter web app (SVG to G-code) as a full-screen page"
__plugin_url__ = "https://github.com/"

SECTIONS = ("profile", "calibration", "job", "presets")
USER_SECTIONS = ("job", "presets")  # per-user; profile and calibration are shared by everyone
MAX_SECTION_BYTES = 1024 * 1024
APP_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "app")

NEEDS_PROFILE = "PLUGIN_PLOTTER_MACHINE_PROFILE"

# calibration defaults of the app (the base for a first manual edit or a capture into an empty section)
CALIBRATION_DEFAULTS = {"cornerX": -5, "cornerY": 50, "zTouch": 8}
CALIBRATION_PARTS = {"xy": ("cornerX", "cornerY"), "z": ("zTouch",)}
EPOCH_KEYS = {"xy": "epochXY", "z": "epochZ"}
# Two independent coordinate counters (corner / pen touch). Before the split there was one ``positionEpoch``:
# a counter that was never stored starts from its value, so calibration stamped with it stays fresh after the upgrade.
EPOCH_SETTINGS = {"xy": "positionEpochXY", "z": "positionEpochZ"}
LEGACY_EPOCH_SETTING = "positionEpoch"


def csrf_cookie_name(request):
    """Full name of the CSRF cookie as OctoPrint sets it (suffix depends on port and script root)."""
    try:
        from octoprint.server.util.flask import get_cookie_suffix

        return "csrf_token" + get_cookie_suffix(request)
    except Exception:  # pragma: no cover - internal helper missing: same rules as OctoPrint 1.11
        port = getattr(request, "server_port", None) or request.environ.get("SERVER_PORT", "")
        suffix = "_P" + str(port)
        if request.script_root:
            suffix += "_R" + request.script_root.replace("/", "|")
        return "csrf_token" + suffix


def _add_csrf_cookie(response):
    # The plugin blueprint does not get OctoPrint's CSRF cookie refresh, so the page and env.json set it themselves.
    try:
        from octoprint.server.util.csrf import add_csrf_cookie

        return add_csrf_cookie(response)
    except Exception:  # pragma: no cover
        return response


class PlotterPlugin(
    octoprint.plugin.BlueprintPlugin,
    octoprint.plugin.SettingsPlugin,
    octoprint.plugin.TemplatePlugin,
    octoprint.plugin.EventHandlerPlugin,
):
    def __init__(self):
        super().__init__()
        self._epoch_lock = threading.Lock()
        self._calibration_lock = threading.Lock()
        self._reader = PositionReader()

    # ~~ SettingsPlugin: storage for the app settings

    def get_settings_defaults(self):
        # positionEpochXY / positionEpochZ have no defaults on purpose: an absent counter starts from the legacy positionEpoch
        return {"profile": None, "calibration": None, "users": {}, "positionEpoch": 0}

    # The app has its own REST API for these values; keep them out of OctoPrint's generic /api/settings.
    def on_settings_load(self):
        return {}

    def on_settings_save(self, data):
        return {}

    def get_settings_version(self):
        return 1

    # ~~ TemplatePlugin: navbar link

    def is_template_autoescaped(self):
        return True

    def get_template_configs(self):
        return [{"type": "navbar", "template": "plotter_navbar.jinja2", "custom_bindings": False}]

    # ~~ Blueprint policy

    def is_blueprint_protected(self):
        # login is checked by the routes themselves: page requests are redirected to the login form, API requests get 403
        return False

    def is_blueprint_csrf_protected(self):
        return True

    def get_blueprint_kwargs(self):
        # no default `static` route: files are served by our own routes, which check the login
        return {}

    # ~~ access helpers (small and overridable: unit tests replace them)

    def _session_user(self):
        """Name of the logged-in user, or None. Without customized access control OctoPrint itself is open."""
        from flask_login import current_user

        if current_user is not None and not current_user.is_anonymous and current_user.is_active:
            return current_user.get_name()
        import octoprint.server

        if not octoprint.server.userManager.has_been_customized():
            return "_anonymous"
        return None

    def _can(self, permission_key):
        perm = getattr(Permissions, permission_key, None)
        return bool(perm is not None and perm.can())

    def can_edit_profile(self):
        return self._can(NEEDS_PROFILE)

    def can_edit_calibration(self):
        return self._can("CONTROL")

    # ~~ responses

    @staticmethod
    def _json(value, status=200):
        response = flask.Response(json.dumps(value), status=status, mimetype="application/json")
        response.headers["Cache-Control"] = "no-store"
        return response

    def _error(self, status, message, code=None):
        payload = {"error": message}
        if code:
            payload["code"] = code
        return self._json(payload, status)

    def _login_redirect(self):
        target = flask.request.script_root + flask.request.path
        return flask.redirect(f"{flask.request.script_root}/login/?redirect={quote(target, safe='')}")

    @staticmethod
    def _no_cache(response):
        response.headers["Cache-Control"] = "no-cache"
        return response

    # ~~ page and static files

    @octoprint.plugin.BlueprintPlugin.route("/", methods=["GET"])
    def index(self):
        if self._session_user() is None:
            return self._login_redirect()
        return self._static_file("index.html", set_csrf=True)

    @octoprint.plugin.BlueprintPlugin.route("/env.json", methods=["GET"])
    def env(self):
        user = self._session_user()
        if user is None:
            return self._error(403, "login required")
        root = flask.request.script_root
        payload = {
            "mode": "plugin",
            "baseUrl": root,
            "apiBase": root + "/api",
            "settingsUrl": root + "/plugin/plotter/api/settings",
            "octoprintUrl": root + "/",
            "loginUrl": root + "/login/",
            "version": __version__,
            "csrfCookie": csrf_cookie_name(flask.request),
            "user": user,
            "canEditProfile": self.can_edit_profile(),
            "canEditCalibration": self.can_edit_calibration(),
        }
        return _add_csrf_cookie(self._no_cache(self._json(payload)))

    @octoprint.plugin.BlueprintPlugin.route("/<path:filename>", methods=["GET"])
    def static_file(self, filename):
        if self._session_user() is None:
            return self._error(403, "login required")
        return self._static_file(filename)

    def _static_file(self, filename, set_csrf=False):
        if not os.path.isfile(os.path.join(APP_DIR, "index.html")):
            return flask.Response(
                "The plotter app is not built: run tools/build_plugin.py and reinstall the plugin.",
                status=503,
                mimetype="text/plain",
            )
        # send_from_directory refuses paths that leave the directory
        response = self._no_cache(flask.send_from_directory(APP_DIR, filename))
        return _add_csrf_cookie(response) if set_csrf else response

    # ~~ settings API

    # Per-user sections live in one dict under "users": plugin settings only persist paths declared in the defaults.
    def _read_section(self, section, user):
        if section in USER_SECTIONS:
            users = self._settings.get(["users"])
            value = users.get(user, {}).get(section) if isinstance(users, dict) and isinstance(users.get(user), dict) else None
        else:
            value = self._settings.get([section])
        return value if isinstance(value, dict) else None

    def _write_section(self, section, user, value):
        if section in USER_SECTIONS:
            users = self._settings.get(["users"])
            users = {k: dict(v) if isinstance(v, dict) else {} for k, v in users.items()} if isinstance(users, dict) else {}
            users.setdefault(user, {})[section] = value
            self._settings.set(["users"], users)
        else:
            self._settings.set([section], value)
        self._settings.save()

    @octoprint.plugin.BlueprintPlugin.route("/api/settings/<section>", methods=["GET"])
    def get_section(self, section):
        user = self._session_user()
        if user is None:
            return self._error(403, "login required")
        if section not in SECTIONS:
            return self._error(400, f"unknown section: {section}")
        return self._json(self._read_section(section, user))

    @octoprint.plugin.BlueprintPlugin.route("/api/settings/<section>", methods=["PUT"])
    def put_section(self, section):
        user = self._session_user()
        if user is None:
            return self._error(403, "login required")
        if section not in SECTIONS:
            return self._error(400, f"unknown section: {section}")
        if section == "profile" and not self.can_edit_profile():
            return self._error(403, "missing permission: machine profile")
        if section == "calibration" and not self.can_edit_calibration():
            return self._error(403, "missing permission: printer control")

        length = flask.request.content_length
        if length is not None and length > MAX_SECTION_BYTES * 2:
            return self._error(413, "section is larger than 1 MB")
        raw = flask.request.get_data(cache=True)
        try:
            value = json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return self._error(400, "body is not JSON")
        if not isinstance(value, dict):
            return self._error(400, "section must be a JSON object")
        if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_SECTION_BYTES:
            return self._error(413, "section is larger than 1 MB")

        if section == "calibration":
            with self._calibration_lock:
                value = self._manual_calibration(value)
                self._write_section(section, user, value)
            return self._json({"ok": True, "calibration": value})
        self._write_section(section, user, value)
        return self._json({"ok": True})

    # ~~ calibration: coordinate epoch, capture and confirmation

    @staticmethod
    def _as_counter(value):
        return value if isinstance(value, int) and not isinstance(value, bool) else None

    def current_epoch(self, part):
        """Counter of one part ("xy" | "z"); a never-stored counter falls back to the pre-split ``positionEpoch``."""
        value = self._as_counter(self._settings.get([EPOCH_SETTINGS[part]]))
        if value is None:
            value = self._as_counter(self._settings.get([LEGACY_EPOCH_SETTING]))
        return value if value is not None else 0

    def current_epochs(self):
        return {part: self.current_epoch(part) for part in EPOCH_SETTINGS}

    def bump_epoch(self, reason="", parts=("xy", "z")):
        with self._epoch_lock:
            for part in parts:
                self._settings.set([EPOCH_SETTINGS[part]], self.current_epoch(part) + 1)
            self._settings.save()
        self._logger.debug(f"plotter: coordinate epochs are now {self.current_epochs()} ({reason})")

    def _stored_calibration(self):
        value = self._settings.get(["calibration"])
        return dict(value) if isinstance(value, dict) else {}

    @staticmethod
    def _part_values(doc, part):
        return tuple(doc.get(k, CALIBRATION_DEFAULTS[k]) for k in CALIBRATION_PARTS[part])

    def _manual_calibration(self, body):
        """Manual input: only the parts whose values changed get the current epoch of that part; the others keep theirs."""
        old = self._stored_calibration()
        new = {k: v for k, v in body.items() if k not in EPOCH_KEYS.values()}
        for part, key in EPOCH_KEYS.items():
            if self._part_values(new, part) != self._part_values(old, part):
                new[key] = self.current_epoch(part)
            elif key in old:
                new[key] = old[key]
        return new

    @staticmethod
    def _is_number(v):
        return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)

    def _calibration_action(self, part, confirm):
        user = self._session_user()
        if user is None:
            return self._error(403, "login required")
        if not self.can_edit_calibration():
            return self._error(403, "missing permission: printer control")
        body = {}
        if not confirm:
            body = flask.request.get_json(silent=True)
            keys = {"xy": ("x", "y"), "z": ("zTouch",)}[part]
            if not isinstance(body, dict) or not all(self._is_number(body.get(k)) for k in keys):
                return self._error(400, "expected numbers: " + ", ".join(keys))
            if not isinstance(body.get("epoch"), int) or isinstance(body.get("epoch"), bool):
                return self._error(400, "epoch must be an integer")
        with self._calibration_lock:
            current = self.current_epoch(part)  # the counter of the captured part only
            if not confirm and body["epoch"] != current:
                return self._error(409, "coordinates changed since the position was read", code="stale")
            doc = {**CALIBRATION_DEFAULTS, **self._stored_calibration()}
            if not confirm:
                if part == "xy":
                    doc["cornerX"], doc["cornerY"] = body["x"], body["y"]
                else:
                    doc["zTouch"] = body["zTouch"]
                doc["updatedAt"] = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            doc[EPOCH_KEYS[part]] = current
            self._write_section("calibration", user, doc)
        return self._json({"ok": True, "calibration": doc})

    @octoprint.plugin.BlueprintPlugin.route("/api/calibration/xy", methods=["POST"])
    def capture_xy(self):
        return self._calibration_action("xy", False)

    @octoprint.plugin.BlueprintPlugin.route("/api/calibration/z", methods=["POST"])
    def capture_z(self):
        return self._calibration_action("z", False)

    @octoprint.plugin.BlueprintPlugin.route("/api/calibration/xy/confirm", methods=["POST"])
    def confirm_xy(self):
        return self._calibration_action("xy", True)

    @octoprint.plugin.BlueprintPlugin.route("/api/calibration/z/confirm", methods=["POST"])
    def confirm_z(self):
        return self._calibration_action("z", True)

    @octoprint.plugin.BlueprintPlugin.route("/api/position/epoch", methods=["GET"])
    def get_epoch(self):
        if self._session_user() is None:
            return self._error(403, "login required")
        return self._json(self.current_epochs())

    def _printer_problem(self):
        """(status, code, message) when the head cannot be read now, else None."""
        printer = self._printer
        if printer is None or not printer.is_operational():
            return 409, "offline", "printer is not connected"
        for name in ("is_printing", "is_paused", "is_pausing", "is_cancelling", "is_finishing"):
            check = getattr(printer, name, None)
            if callable(check) and check():
                return 409, "busy", "printer is printing"
        return None

    @octoprint.plugin.BlueprintPlugin.route("/api/position", methods=["POST"])
    def read_position(self):
        if self._session_user() is None:
            return self._error(403, "login required")
        if not self.can_edit_calibration():
            return self._error(403, "missing permission: printer control")
        problem = self._printer_problem()
        if problem:
            return self._error(problem[0], problem[2], code=problem[1])
        rid = self._reader.start()
        if rid is None:
            return self._error(409, "another position read is running", code="busy")
        epoch0 = self.current_epochs()
        try:
            self._printer.commands(self._reader.commands(rid), tags={"plugin:plotter"})
        except Exception as e:
            self._reader.wait(rid, 0)  # release
            return self._error(409, f"cannot send: {e}", code="offline")
        outcome, coords = self._reader.wait(rid)
        if outcome == "unsupported":
            return self._error(501, "the printer firmware does not know M118", code="unsupported")
        if outcome == "timeout":
            return self._error(504, "the printer did not answer", code="timeout")
        if outcome == "nocoords":
            return self._error(502, "no coordinates in the printer answer", code="nocoords")
        if self.current_epochs() != epoch0:  # either counter changed: the read is stale (the route does not know which part is wanted)
            return self._error(409, "coordinates changed while reading", code="stale")
        x, y, z = coords
        return self._json({"x": x, "y": y, "z": z, "epochXY": epoch0["xy"], "epochZ": epoch0["z"]})

    # ~~ hooks

    def on_event(self, event, payload):
        from octoprint.events import Events

        if event == Events.CONNECTED:
            self.bump_epoch("connected")

    def on_gcode_received(self, comm_instance, line, *args, **kwargs):
        self._reader.feed(line)
        return line

    def on_gcode_sent(self, comm_instance, phase, cmd, cmd_type, gcode, *args, **kwargs):
        if gcode in ("G28", "G92"):
            parts = epoch_parts(cmd)
            if parts:  # G92 E0 shifts no axis
                self.bump_epoch(str(cmd), tuple(sorted(parts)))

    def body_size_limits(self, current_max_body_sizes, *args, **kwargs):
        # OctoPrint's default request body limit is 100 KB; sections may be up to 1 MB (routes are relative to /plugin/plotter/)
        return [("PUT", r"api/settings/[a-z]+", MAX_SECTION_BYTES * 2 + 4096)]

    # ~~ permissions

    def get_additional_permissions(self):
        return [
            {
                "key": "MACHINE_PROFILE",
                "name": "Machine profile",
                "description": "Allows to change the shared plotter machine profile (pen heights, speeds, limits).",
                "roles": ["machine_profile"],
                "default_groups": [ADMIN_GROUP],
            }
        ]


__plugin_implementation__ = PlotterPlugin()
__plugin_hooks__ = {
    "octoprint.access.permissions": __plugin_implementation__.get_additional_permissions,
    "octoprint.comm.protocol.gcode.received": __plugin_implementation__.on_gcode_received,
    "octoprint.comm.protocol.gcode.sent": __plugin_implementation__.on_gcode_sent,
    "octoprint.server.http.bodysize": __plugin_implementation__.body_size_limits,
}
