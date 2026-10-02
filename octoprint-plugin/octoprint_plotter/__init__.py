"""OctoPrint-Plotter: serves the plotter web app as a full-screen page and stores its settings.

The plugin is deliberately thin: static files, ``env.json`` and a small REST API for the app settings.
All plotting logic lives in the browser application.
"""

import json
import math
import os
import re
import secrets
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

# Machine profiles: a shared collection {version, rev, activeId, items: [{id, name, rev, createdAt, updatedAt, values}]}
MAX_PROFILES = 20
MAX_PROFILE_NAME = 64
DEFAULT_PROFILE_NAME = "Neptune 3 Pro"
PROFILE_ID = re.compile(r"^p_[0-9a-f]{8}$")
BED_KEYS = ("bedX0", "bedY0", "bedX1", "bedY1")
BED_DEFAULTS = {"bedX0": None, "bedY0": None, "bedX1": None, "bedY1": None, "bedUrNominal": False, "bedW": 235, "bedH": 235}

# calibration defaults of the app (the base for a first manual edit or a capture into an empty section)
CALIBRATION_DEFAULTS = {"cornerX": -5, "cornerY": 50, "zTouch": 8}
CALIBRATION_PARTS = {"xy": ("cornerX", "cornerY"), "z": ("zTouch",)}
EPOCH_KEYS = {"xy": "epochXY", "z": "epochZ"}
# the active machine profile at the last capture, input or confirmation of a part (the pen holder is part of the profile)
PROFILE_KEYS = {"xy": "profileXY", "z": "profileZ"}
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
        self._profiles_lock = threading.RLock()
        self._reader = PositionReader()

    # ~~ SettingsPlugin: storage for the app settings

    def get_settings_defaults(self):
        # positionEpochXY / positionEpochZ have no defaults on purpose: an absent counter starts from the legacy positionEpoch
        # "profiles" must be declared here, otherwise OctoPrint does not persist it; "profile" is the pre-profiles section (kept for rollback)
        return {"profile": None, "profiles": None, "calibration": None, "users": {}, "positionEpoch": 0}

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

    # OctoPrint's own rule (octoprint.server.Server._get_locale): the user's Settings -> Appearance language, otherwise the
    # instance default language; "_default" means "not chosen". The browser language (Accept-Language) is left to the app.
    @staticmethod
    def _real_language(value):
        return value if isinstance(value, str) and value.strip() and value != "_default" else None

    def _user_language(self, user):
        try:
            import octoprint.server

            return self._real_language(octoprint.server.userManager.get_user_setting(user, ("interface", "language")))
        except Exception:  # no user manager yet, unknown or anonymous user
            return None

    def _default_language(self):
        try:
            from octoprint.settings import settings

            return self._real_language(settings().get(["appearance", "defaultLanguage"]))
        except Exception:  # settings not initialized
            return None

    def ui_language(self, user):
        """Interface language code of the current user as OctoPrint knows it (e.g. "ru", "de"), or None."""
        return self._user_language(user) or self._default_language()

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
            "profilesUrl": root + "/plugin/plotter/api/profiles",
            "octoprintUrl": root + "/",
            "loginUrl": root + "/login/",
            "version": __version__,
            "csrfCookie": csrf_cookie_name(flask.request),
            "user": user,
            "canEditProfile": self.can_edit_profile(),
            "canEditCalibration": self.can_edit_calibration(),
            "language": self.ui_language(user),  # the app picks its own language from it (en/ru), else from the browser
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
        if section == "profile":  # a cached page of an earlier version: the values of the active profile
            return self._json(self._active_profile(self._ensure_profiles())["values"])
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
            active = self._ensure_profiles()["activeId"]  # before the calibration lock: the lock order is profiles → calibration
            with self._calibration_lock:
                value = self._manual_calibration(value, active)
                self._write_section(section, user, value)
            return self._json({"ok": True, "calibration": value})
        if section == "profile":  # a cached page of an earlier version: merged into the values of the active profile
            with self._profiles_lock:
                col = self._ensure_profiles()
                item = self._active_profile(col)
                values = {**item["values"], **value}
                problem = self._bed_problem(values)
                if problem:
                    return self._error(400, problem)
                self._store_profile(col, {**item, "values": values})
                self._save_profiles(col)
            return self._json({"ok": True})
        self._write_section(section, user, value)
        return self._json({"ok": True})

    # ~~ machine profiles: one shared collection, every write needs the machine profile permission

    @staticmethod
    def _now():
        return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")

    @staticmethod
    def _new_profile_id():
        return "p_" + secrets.token_hex(4)

    @staticmethod
    def _valid_collection(col):
        return (
            isinstance(col, dict)
            and isinstance(col.get("items"), list)
            and len(col["items"]) > 0
            and any(isinstance(p, dict) and p.get("id") == col.get("activeId") for p in col["items"])
        )

    def _ensure_profiles(self):
        """The collection; created once from the pre-profiles section (or defaults) on the first read, by any user."""
        with self._profiles_lock:
            col = self._settings.get(["profiles"])
            if self._valid_collection(col):
                return col
            legacy = self._settings.get(["profile"])
            now = self._now()
            pid = self._new_profile_id()
            values = {**(legacy if isinstance(legacy, dict) else {}), **BED_DEFAULTS}
            col = {
                "version": 1, "rev": 1, "activeId": pid,
                "items": [{"id": pid, "name": DEFAULT_PROFILE_NAME, "rev": 1, "createdAt": now, "updatedAt": now, "values": values}],
            }
            self._settings.set(["profiles"], col)
            # the stored calibration belongs to the created profile: the upgrade does not report "the profile changed"
            with self._calibration_lock:
                cal = self._settings.get(["calibration"])
                if isinstance(cal, dict):
                    cal = dict(cal)
                    for key in PROFILE_KEYS.values():
                        if cal.get(key) is None:
                            cal[key] = pid
                    self._settings.set(["calibration"], cal)
            self._settings.save()
            self._logger.debug("plotter: machine profiles created from the single profile")
            return col

    @staticmethod
    def _active_profile(col):
        return next((p for p in col["items"] if p["id"] == col["activeId"]), col["items"][0])

    def _save_profiles(self, col):
        col["rev"] = int(col.get("rev") or 0) + 1
        self._settings.set(["profiles"], col)
        self._settings.save()

    def _store_profile(self, col, item):
        item = {**item, "rev": int(item.get("rev") or 0) + 1, "updatedAt": self._now()}
        col["items"] = [item if p["id"] == item["id"] else p for p in col["items"]]

    def _bed_problem(self, values):
        bed = [values.get(k) for k in BED_KEYS]
        if all(v is None for v in bed):
            return None
        if not all(self._is_number(v) for v in bed):
            return "the bed must be set entirely or not at all"
        if not (bed[0] < bed[2] and bed[1] < bed[3]):
            return "the bed must have x0 < x1 and y0 < y1"
        return None

    def _name_problem(self, name, items, except_id=None):
        if not isinstance(name, str) or not name.strip():
            return "the profile name is empty"
        if len(name.strip()) > MAX_PROFILE_NAME:
            return f"the profile name is longer than {MAX_PROFILE_NAME} characters"
        low = name.strip().lower()
        if any(p["id"] != except_id and str(p.get("name", "")).strip().lower() == low for p in items):
            return "the profile name is already taken"
        return None

    def _collection_problem(self, col):
        if not isinstance(col, dict) or not isinstance(col.get("items"), list) or not col["items"]:
            return "profiles: expected a collection with items"
        items = col["items"]
        if len(items) > MAX_PROFILES:
            return f"at most {MAX_PROFILES} profiles"
        seen = []
        for p in items:
            if not isinstance(p, dict) or not isinstance(p.get("id"), str) or not PROFILE_ID.match(p["id"]):
                return "profiles: invalid profile id"
            if any(x["id"] == p["id"] for x in seen):
                return "profiles: repeated profile id"
            problem = self._name_problem(p.get("name"), seen) or (None if isinstance(p.get("values"), dict) else "profile values must be an object")
            problem = problem or self._bed_problem(p["values"])
            if problem:
                return problem
            seen.append(p)
        if not any(p["id"] == col.get("activeId") for p in items):
            return "the active profile does not exist"
        return None

    def _profile_body(self):
        """(value, error response): the JSON object of a write, at most 1 MB."""
        length = flask.request.content_length
        if length is not None and length > MAX_SECTION_BYTES * 2:
            return None, self._error(413, "profiles are larger than 1 MB")
        try:
            value = json.loads(flask.request.get_data(cache=True).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None, self._error(400, "body is not JSON")
        if not isinstance(value, dict):
            return None, self._error(400, "body must be a JSON object")
        if len(json.dumps(value, ensure_ascii=False).encode("utf-8")) > MAX_SECTION_BYTES:
            return None, self._error(413, "profiles are larger than 1 MB")
        return value, None

    def _profiles_write_denied(self):
        if self._session_user() is None:
            return self._error(403, "login required")
        if not self.can_edit_profile():
            return self._error(403, "missing permission: machine profile")
        return None

    def _fits(self, col):
        return len(json.dumps(col, ensure_ascii=False).encode("utf-8")) <= MAX_SECTION_BYTES

    @octoprint.plugin.BlueprintPlugin.route("/api/profiles", methods=["GET"])
    def get_profiles(self):
        if self._session_user() is None:
            return self._error(403, "login required")
        return self._json(self._ensure_profiles())

    @octoprint.plugin.BlueprintPlugin.route("/api/profiles", methods=["PUT"])
    def put_profiles(self):
        """The whole collection (settings import)."""
        denied = self._profiles_write_denied()
        if denied:
            return denied
        value, error = self._profile_body()
        if error:
            return error
        problem = self._collection_problem(value)
        if problem:
            return self._error(400, problem)
        with self._profiles_lock:
            old = self._ensure_profiles()
            now = self._now()
            items = [
                {"id": p["id"], "name": p["name"].strip(), "rev": int(p.get("rev") or 0) + 1,
                 "createdAt": p.get("createdAt") or now, "updatedAt": now, "values": p["values"]}
                for p in value["items"]
            ]
            col = {"version": 1, "rev": old.get("rev", 0), "activeId": value["activeId"], "items": items}
            self._save_profiles(col)
        return self._json(col)

    @octoprint.plugin.BlueprintPlugin.route("/api/profiles/active", methods=["PUT"])
    def put_active_profile(self):
        """The active profile is shared by all users: choosing it is a profile write."""
        denied = self._profiles_write_denied()
        if denied:
            return denied
        body = flask.request.get_json(silent=True)
        pid = body.get("id") if isinstance(body, dict) else None
        if not isinstance(pid, str):
            return self._error(400, "expected the profile id")
        with self._profiles_lock:
            col = self._ensure_profiles()
            if not any(p["id"] == pid for p in col["items"]):
                return self._error(404, "unknown profile")
            col = {**col, "activeId": pid}
            self._save_profiles(col)
        return self._json(col)

    @octoprint.plugin.BlueprintPlugin.route("/api/profiles/<profile_id>", methods=["PUT"])
    def put_profile(self, profile_id):
        """Create or replace one profile: {name, values, rev?}; rev — the revision the edit is based on (409 if it moved)."""
        denied = self._profiles_write_denied()
        if denied:
            return denied
        if not PROFILE_ID.match(profile_id):
            return self._error(400, "invalid profile id")
        body, error = self._profile_body()
        if error:
            return error
        values = body.get("values")
        if not isinstance(values, dict):
            return self._error(400, "profile values must be an object")
        problem = self._bed_problem(values)
        if problem:
            return self._error(400, problem)
        with self._profiles_lock:
            col = {**self._ensure_profiles()}
            current = next((p for p in col["items"] if p["id"] == profile_id), None)
            name = body.get("name", current["name"] if current else None)
            problem = self._name_problem(name, col["items"], profile_id)
            if problem:
                return self._error(400, problem)
            if current is None:
                if len(col["items"]) >= MAX_PROFILES:
                    return self._error(400, f"at most {MAX_PROFILES} profiles")
                now = self._now()
                col["items"] = [*col["items"], {"id": profile_id, "name": name.strip(), "rev": 1, "createdAt": now, "updatedAt": now, "values": values}]
            else:
                rev = body.get("rev")
                if rev is not None and rev != current.get("rev"):
                    payload = {"error": "the profile was changed on another device", "code": "conflict", "profile": current}
                    return self._json(payload, 409)
                self._store_profile(col, {**current, "name": name.strip(), "values": values})
            if not self._fits(col):
                return self._error(413, "profiles are larger than 1 MB")
            self._save_profiles(col)
        return self._json(col)

    @octoprint.plugin.BlueprintPlugin.route("/api/profiles/<profile_id>", methods=["DELETE"])
    def delete_profile(self, profile_id):
        denied = self._profiles_write_denied()
        if denied:
            return denied
        with self._profiles_lock:
            col = {**self._ensure_profiles()}
            items = col["items"]
            index = next((i for i, p in enumerate(items) if p["id"] == profile_id), None)
            if index is None:
                return self._error(404, "unknown profile")
            if len(items) <= 1:
                return self._error(409, "the last profile cannot be deleted", code="last")
            if col["activeId"] == profile_id:  # the neighbour: the previous one, else the next one
                col["activeId"] = items[index - 1 if index > 0 else index + 1]["id"]
            col["items"] = [p for p in items if p["id"] != profile_id]
            self._save_profiles(col)
        return self._json(col)

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

    def _manual_calibration(self, body, active):
        """Manual input: only the parts whose values changed get the current epoch of that part and the active profile;
        the others keep theirs."""
        old = self._stored_calibration()
        stamps = set(EPOCH_KEYS.values()) | set(PROFILE_KEYS.values())
        new = {k: v for k, v in body.items() if k not in stamps}
        for part, key in EPOCH_KEYS.items():
            pkey = PROFILE_KEYS[part]
            if self._part_values(new, part) != self._part_values(old, part):
                new[key] = self.current_epoch(part)
                new[pkey] = active
            else:
                for k in (key, pkey):
                    if k in old:
                        new[k] = old[k]
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
        active = self._ensure_profiles()["activeId"]
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
            doc[PROFILE_KEYS[part]] = active
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
        return [("PUT", r"api/(settings/[a-z]+|profiles(/[a-z0-9_]+)?)", MAX_SECTION_BYTES * 2 + 4096)]

    # ~~ permissions

    def get_additional_permissions(self):
        return [
            {
                "key": "MACHINE_PROFILE",
                "name": "Machine profile",
                "description": "Allows to change the shared plotter machine profiles (pen heights, speeds, limits, bed) and to choose the active one.",
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
