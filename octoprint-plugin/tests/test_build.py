"""tools/build_plugin.py: the zip contains the app and the plugin, nothing else; git keeps a single copy of the app."""

import importlib.util
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def load_build():
    spec = importlib.util.spec_from_file_location("build_plugin", ROOT / "tools" / "build_plugin.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def test_zip_contains_app_and_plugin(tmp_path, monkeypatch):
    build = load_build()
    monkeypatch.setattr(build, "DIST", tmp_path)
    build.copy_app()
    target = build.build_zip("9.9.9")
    assert target.name == "OctoPrint-Plotter-9.9.9.zip"
    names = zipfile.ZipFile(target).namelist()
    top = "OctoPrint-Plotter-9.9.9/"
    assert all(n.startswith(top) for n in names)
    for expected in (
        "pyproject.toml",
        "octoprint_plotter/__init__.py",
        "octoprint_plotter/templates/plotter_navbar.jinja2",
        "octoprint_plotter/static/app/index.html",
        "octoprint_plotter/static/app/src/app/main.js",
        "octoprint_plotter/static/app/src/transport/auth-session.js",
        # style engine: workers, completion manifest and the vendored plotterfun (with its licence and version file)
        "octoprint_plotter/static/app/src/styles/plotterfun-host.js",
        "octoprint_plotter/static/app/src/styles/plotterfun-completion.json",
        "octoprint_plotter/static/app/src/styles/own/worker.js",
        "octoprint_plotter/static/app/vendor/plotterfun/LICENSE",
        "octoprint_plotter/static/app/vendor/plotterfun/UPSTREAM",
        "octoprint_plotter/static/app/vendor/plotterfun/helpers.js",
        "octoprint_plotter/static/app/vendor/plotterfun/squiggle.js",
        "octoprint_plotter/static/app/vendor/plotterfun/external/stackblur.min.js",
    ):
        assert top + expected in names, expected
    assert not any("__pycache__" in n or "/tests/" in n or n.endswith(".pyc") for n in names)
    # the standalone env.json must not shadow the plugin's dynamic one
    assert not any(n.endswith("static/app/env.json") for n in names)


def test_zip_contains_current_app_file(tmp_path, monkeypatch):
    build = load_build()
    monkeypatch.setattr(build, "DIST", tmp_path)
    build.copy_app()
    target = build.build_zip("9.9.9")
    inside = zipfile.ZipFile(target).read("OctoPrint-Plotter-9.9.9/octoprint_plotter/static/app/src/app/main.js")
    assert inside == (ROOT / "src" / "app" / "main.js").read_bytes()


def test_zip_build_bumps_the_patch_version(tmp_path, monkeypatch):
    build = load_build()
    version_file = tmp_path / "_version.py"
    version_file.write_text('__version__ = "0.1.7"\n')
    monkeypatch.setattr(build, "VERSION_FILE", version_file)
    monkeypatch.setattr(build, "DIST", tmp_path / "dist")
    monkeypatch.setattr(build, "copy_app", lambda: [])
    build.main([])
    assert build.read_version() == "0.1.8"
    assert (tmp_path / "dist" / "OctoPrint-Plotter-0.1.8.zip").exists()
    build.main(["--no-zip"])
    build.main(["--no-bump"])
    assert build.read_version() == "0.1.8", "copy-only and --no-bump keep the version"
    build.main(["--version", "0.2.0"])
    assert build.read_version() == "0.2.0"
    assert build.bump_patch("1.2.9.post3") == "1.2.10"
