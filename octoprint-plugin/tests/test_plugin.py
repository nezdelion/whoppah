"""Plugin routes on a bare Flask app: access, sections, permissions, CSRF, size limits, per-user data.

Login and permission lookups are replaced (the plugin keeps them in small methods); the real integration
with OctoPrint is checked on a running server.
"""

import json
import os
import types

import flask
import pytest

import octoprint_plotter as plotter
from octoprint.server.util.csrf import validate_csrf_request, generate_csrf_token


class FakeSettings:
    def __init__(self):
        self.data = {"profile": None, "calibration": None, "users": {}}
        self.saved = 0

    def get(self, path):
        node = self.data
        for key in path:
            if not isinstance(node, dict) or key not in node:
                return None
            node = node[key]
        return node

    def set(self, path, value):
        node = self.data
        for key in path[:-1]:
            node = node.setdefault(key, {})
        node[path[-1]] = value

    def save(self):
        self.saved += 1


class Who:
    """Mutable identity used by the fake access helpers."""

    def __init__(self):
        self.user = "alice"
        self.rights = set()


@pytest.fixture
def env(tmp_path, monkeypatch):
    app_dir = tmp_path / "app"
    (app_dir / "src").mkdir(parents=True)
    (app_dir / "index.html").write_text("<!doctype html><title>app</title>")
    (app_dir / "src" / "a.js").write_text("export const a = 1;")
    (tmp_path / "secret.txt").write_text("nope")
    monkeypatch.setattr(plotter, "APP_DIR", str(app_dir))

    who = Who()
    plugin = plotter.PlotterPlugin()
    plugin._settings = FakeSettings()
    plugin._identifier = "plotter"
    plugin._logger = types.SimpleNamespace(warning=lambda *a, **k: None, debug=lambda *a, **k: None)
    plugin._session_user = lambda: who.user
    plugin._can = lambda key: key in who.rights

    plugin._basefolder = str(tmp_path)
    app = flask.Flask(__name__)
    app.config["SECRET_KEY"] = "test-secret"
    # mimic OctoPrint's registration: the server installs the CSRF handler on protected blueprints
    blueprint = plugin.get_blueprint()
    assert plugin.is_blueprint_csrf_protected()
    blueprint.before_request(lambda: validate_csrf_request(flask.request))
    app.register_blueprint(blueprint, url_prefix="/plugin/plotter")

    client = app.test_client()
    with app.test_request_context():
        token = generate_csrf_token()
    client.set_cookie("csrf_token", token)  # same-host cookie, name without suffix as in the test app
    return types.SimpleNamespace(client=client, plugin=plugin, who=who, token=token, app=app, tmp=tmp_path)


def put(env, section, body, token="auto", **kwargs):
    headers = {}
    if token == "auto":
        token = env.token
    if token:
        headers["X-CSRF-Token"] = token
    data = body if isinstance(body, (str, bytes)) else json.dumps(body)
    return env.client.put(f"/plugin/plotter/api/settings/{section}", data=data, headers=headers, content_type="application/json", **kwargs)


# ~~ access

def test_anonymous_gets_nothing(env):
    env.who.user = None
    for url in ("/plugin/plotter/env.json", "/plugin/plotter/api/settings/job", "/plugin/plotter/src/a.js"):
        assert env.client.get(url).status_code == 403
    assert put(env, "job", {"a": 1}).status_code == 403
    assert env.plugin._settings.saved == 0


def test_anonymous_page_redirects_to_login_and_back(env):
    env.who.user = None
    r = env.client.get("/plugin/plotter/")
    assert r.status_code == 302
    assert r.headers["Location"].endswith("/login/?redirect=%2Fplugin%2Fplotter%2F")


def test_page_and_static_files_for_logged_in_user(env):
    r = env.client.get("/plugin/plotter/")
    assert r.status_code == 200 and b"<title>app</title>" in r.data
    assert r.headers["Cache-Control"] == "no-cache"
    assert env.client.get("/plugin/plotter/src/a.js").data == b"export const a = 1;"
    assert env.client.get("/plugin/plotter/src/missing.js").status_code == 404


def test_static_files_cannot_leave_the_app_directory(env):
    for url in ("/plugin/plotter/../secret.txt", "/plugin/plotter/src/../../secret.txt", "/plugin/plotter/%2e%2e/secret.txt"):
        assert env.client.get(url).status_code in (400, 404)


def test_unbuilt_app_gives_503(env, monkeypatch):
    monkeypatch.setattr(plotter, "APP_DIR", str(env.tmp / "nowhere"))
    assert env.client.get("/plugin/plotter/").status_code == 503


# ~~ env.json

def test_env_json(env):
    env.who.rights = {"CONTROL"}
    data = env.client.get("/plugin/plotter/env.json").get_json()
    assert data["mode"] == "plugin"
    assert data["baseUrl"] == "" and data["settingsUrl"] == "/plugin/plotter/api/settings"
    assert data["user"] == "alice" and data["canEditProfile"] is False and data["canEditCalibration"] is True
    assert data["version"] == plotter.__version__
    assert data["csrfCookie"].startswith("csrf_token")


def test_env_json_passes_the_octoprint_language_of_the_user(env):
    env.plugin._user_language = lambda user: {"alice": "ru"}.get(user)
    env.plugin._default_language = lambda: "de"
    assert env.client.get("/plugin/plotter/env.json").get_json()["language"] == "ru"
    env.who.user = "bob"  # no own language: the instance default applies
    assert env.client.get("/plugin/plotter/env.json").get_json()["language"] == "de"


def test_env_json_language_is_null_when_nothing_is_chosen(env):
    env.plugin._user_language = lambda user: None
    env.plugin._default_language = lambda: None
    assert env.client.get("/plugin/plotter/env.json").get_json()["language"] is None


@pytest.mark.parametrize("value, expected", [("ru", "ru"), ("en", "en"), ("pt_BR", "pt_BR"), ("_default", None), ("", None), ("  ", None), (None, None), (5, None)])
def test_real_language_ignores_default_and_garbage(value, expected):
    assert plotter.PlotterPlugin._real_language(value) == expected


def test_language_lookup_uses_user_setting_then_instance_default(env, monkeypatch):
    import octoprint.server

    class Users:
        def __init__(self):
            self.settings = {"alice": "ru", "bob": "_default"}

        def get_user_setting(self, user, key):
            assert key == ("interface", "language")
            if user not in self.settings:
                raise KeyError(user)
            return self.settings[user]

    monkeypatch.setattr(octoprint.server, "userManager", Users(), raising=False)
    plugin = env.plugin
    plugin._default_language = lambda: "en"
    assert plugin.ui_language("alice") == "ru"
    assert plugin.ui_language("bob") == "en"
    assert plugin.ui_language("nobody") == "en"
    assert plugin.ui_language("_anonymous") == "en"


def test_language_lookup_survives_missing_octoprint_state(env, monkeypatch):
    import octoprint.server

    monkeypatch.setattr(octoprint.server, "userManager", None, raising=False)
    assert env.plugin._user_language("alice") is None
    assert env.plugin._default_language() is None  # settings are not initialized in unit tests: no config files are touched


@pytest.mark.parametrize("environ, expected", [
    ({"SERVER_PORT": "5000"}, "csrf_token_P5000"),
    ({"SERVER_PORT": "5001"}, "csrf_token_P5001"),
    ({"SERVER_PORT": "80", "SCRIPT_NAME": "/octoprint"}, "csrf_token_P80_R|octoprint"),
])
def test_csrf_cookie_name_matches_octoprint_rules(environ, expected):
    from octoprint.server.util.flask import OctoPrintFlaskRequest

    req = OctoPrintFlaskRequest({"REQUEST_METHOD": "GET", "PATH_INFO": "/", "wsgi.url_scheme": "http", "SERVER_NAME": "h", **environ, "wsgi.input": None})
    assert plotter.csrf_cookie_name(req) == expected


def test_env_json_uses_script_root(env):
    r = env.client.get("/plugin/plotter/env.json", environ_overrides={"SCRIPT_NAME": "/octoprint"})
    data = r.get_json()
    assert data["baseUrl"] == "/octoprint" and data["octoprintUrl"] == "/octoprint/"
    assert data["settingsUrl"] == "/octoprint/plugin/plotter/api/settings"


# ~~ settings API

def test_unknown_section_is_400(env):
    assert env.client.get("/plugin/plotter/api/settings/nope").status_code == 400
    assert put(env, "nope", {}).status_code == 400
    assert put(env, "users", {}).status_code == 400


def test_get_empty_section_is_null(env):
    r = env.client.get("/plugin/plotter/api/settings/job")
    assert r.status_code == 200 and r.get_json() is None


def test_put_without_csrf_is_refused_and_nothing_changes(env):
    r = put(env, "job", {"a": 1}, token=None)
    assert r.status_code == 400
    r = put(env, "job", {"a": 1}, token="forged")
    assert r.status_code == 400
    assert env.plugin._settings.saved == 0
    assert env.plugin._settings.data["users"] == {}


def test_body_must_be_a_json_object(env):
    for body in ("[1]", "\"x\"", "not json", "3"):
        assert put(env, "job", body).status_code == 400


def test_too_large_section_is_413(env):
    big = {"blob": "x" * (1024 * 1024 + 10)}
    assert put(env, "job", big).status_code == 413
    assert env.plugin._settings.saved == 0
    ok = {"blob": "x" * (1024 * 1024 - 100)}
    assert put(env, "job", ok).status_code == 200


def test_job_and_presets_are_per_user(env):
    env.who.user = "alice"
    assert put(env, "presets", {"svg": {"a": 1}}).status_code == 200
    assert put(env, "job", {"marginMm": 3}).status_code == 200
    env.who.user = "bob"
    assert env.client.get("/plugin/plotter/api/settings/presets").get_json() is None
    assert put(env, "presets", {"svg": {"b": 2}}).status_code == 200
    assert env.client.get("/plugin/plotter/api/settings/presets").get_json() == {"svg": {"b": 2}}
    env.who.user = "alice"
    assert env.client.get("/plugin/plotter/api/settings/presets").get_json() == {"svg": {"a": 1}}
    assert env.client.get("/plugin/plotter/api/settings/job").get_json() == {"marginMm": 3}


def test_profile_needs_permission_but_anyone_reads(env):
    assert put(env, "profile", {"fDraw": 1}).status_code == 403
    assert env.plugin._settings.data["profile"] is None
    assert env.client.get("/plugin/plotter/api/settings/profile").status_code == 200
    env.who.rights = {plotter.NEEDS_PROFILE}
    assert put(env, "profile", {"fDraw": 1}).status_code == 200
    env.who.user = "bob"
    env.who.rights = set()
    assert env.client.get("/plugin/plotter/api/settings/profile").get_json() == {"fDraw": 1}  # shared
    assert put(env, "profile", {"fDraw": 9}).status_code == 403
    assert env.plugin._settings.data["profile"] == {"fDraw": 1}


def test_calibration_needs_control(env):
    assert put(env, "calibration", {"cornerX": -5}).status_code == 403
    assert env.plugin._settings.data["calibration"] is None
    assert env.client.get("/plugin/plotter/api/settings/calibration").status_code == 200
    env.who.rights = {"CONTROL"}
    assert put(env, "calibration", {"cornerX": -5, "cornerY": 50, "zTouch": 8.0}).status_code == 200
    env.who.user = "bob"
    assert env.client.get("/plugin/plotter/api/settings/calibration").get_json()["cornerY"] == 50


def test_profile_permission_alone_does_not_allow_calibration(env):
    env.who.rights = {plotter.NEEDS_PROFILE}
    assert put(env, "calibration", {}).status_code == 403


# ~~ plugin metadata

def test_blueprint_policy_and_permission_hook():
    p = plotter.PlotterPlugin()
    assert p.is_blueprint_csrf_protected() is True
    assert p.is_blueprint_protected() is False
    perm, = p.get_additional_permissions()
    assert perm["key"] == "MACHINE_PROFILE"
    from octoprint.access import ADMIN_GROUP
    assert perm["default_groups"] == [ADMIN_GROUP]
    assert plotter.__plugin_hooks__["octoprint.access.permissions"] == p.get_additional_permissions or callable(plotter.__plugin_hooks__["octoprint.access.permissions"])
    assert p.on_settings_load() == {}


def test_body_size_hook_allows_sections_up_to_limit():
    (method, route, size), = plotter.PlotterPlugin().body_size_limits([])
    import re
    assert method == "PUT" and re.fullmatch(route, "api/settings/profile") and size > plotter.MAX_SECTION_BYTES


def test_navbar_template_declared():
    cfg, = plotter.PlotterPlugin().get_template_configs()
    assert cfg["type"] == "navbar" and cfg["template"] == "plotter_navbar.jinja2"
    assert os.path.isfile(os.path.join(os.path.dirname(plotter.__file__), "templates", cfg["template"]))
