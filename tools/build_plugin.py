#!/usr/bin/env python3
"""Copy the app (index.html, src/, vendor/) into the OctoPrint plugin package and build a zip for Plugin Manager.

    python3 tools/build_plugin.py [--version X.Y.Z | --no-bump] [--no-zip]

Every zip build bumps the patch version in octoprint_plotter/_version.py (0.1.0 -> 0.1.1), so Plugin Manager installs the
new zip over the old one; commit the changed _version.py with the build. --version sets an exact version instead,
--no-bump keeps the current one; --no-zip (copy only) never changes the version.

The app sources are never duplicated in git: octoprint_plotter/static/app/ is generated and git-ignored.
Standard library only.
"""

import argparse
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLUGIN = ROOT / "octoprint-plugin"
PACKAGE = PLUGIN / "octoprint_plotter"
STATIC_APP = PACKAGE / "static" / "app"
VERSION_FILE = PACKAGE / "_version.py"
DIST = ROOT / "dist"

APP_FILES = ["index.html"]
APP_DIRS = ["src", "vendor"]  # vendor/ holds third-party code (plotterfun, with LICENSE and UPSTREAM); copied when present
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


def rel(path):
    """A path for messages: relative to the repo when inside it."""
    try:
        return path.relative_to(ROOT)
    except ValueError:
        return path


def read_version():
    m = re.search(r'__version__\s*=\s*"([^"]+)"', VERSION_FILE.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"cannot read the version from {VERSION_FILE}")
    return m.group(1)


def write_version(version):
    if not re.fullmatch(r"\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-+]*)?", version):
        raise SystemExit(f"bad version: {version}")
    VERSION_FILE.write_text(f'__version__ = "{version}"\n', encoding="utf-8")


def bump_patch(version):
    """0.1.7 -> 0.1.8; a suffix after the patch (0.1.7.post1, 0.1.7-rc1) is dropped."""
    m = re.match(r"(\d+)\.(\d+)\.(\d+)", version)
    if not m:
        raise SystemExit(f"cannot bump the version: {version}")
    major, minor, patch = (int(g) for g in m.groups())
    return f"{major}.{minor}.{patch + 1}"


def copy_app():
    if STATIC_APP.exists():
        shutil.rmtree(STATIC_APP)
    STATIC_APP.mkdir(parents=True)
    for name in APP_FILES:
        shutil.copy2(ROOT / name, STATIC_APP / name)
    copied = list(APP_FILES)
    for name in APP_DIRS:
        src = ROOT / name
        if src.is_dir():
            shutil.copytree(src, STATIC_APP / name, ignore=SKIP)
            copied.append(name + "/")
    # env.json is served dynamically by the plugin, the static standalone one must not shadow it
    return copied


def build_zip(version):
    DIST.mkdir(exist_ok=True)
    name = f"OctoPrint-Plotter-{version}"
    target = DIST / f"{name}.zip"
    if target.exists():
        target.unlink()
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
        for path in sorted(PLUGIN.rglob("*")):
            rel = path.relative_to(PLUGIN)
            parts = rel.parts
            if path.is_dir() or "__pycache__" in parts or any(p.endswith(".egg-info") for p in parts):
                continue
            if parts[0] in ("tests", ".pytest_cache") or path.suffix == ".pyc":
                continue
            z.write(path, f"{name}/{rel.as_posix()}")
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="set the plugin version before building (instead of the patch bump)")
    ap.add_argument("--no-bump", action="store_true", help="build the zip with the current version")
    ap.add_argument("--no-zip", action="store_true", help="only copy the app into the package")
    args = ap.parse_args(argv)
    if args.version:
        write_version(args.version)
    elif not args.no_zip and not args.no_bump:
        old = read_version()
        write_version(bump_patch(old))
        print(f"version: {old} -> {read_version()} (commit {rel(VERSION_FILE)})")
    version = read_version()
    copied = copy_app()
    print(f"app copied to {rel(STATIC_APP)}: {', '.join(copied)}")
    if not args.no_zip:
        print(f"zip: {rel(build_zip(version))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
