#!/usr/bin/env python3
"""Copy the app (index.html, src/, vendor/) into the OctoPrint plugin package and build a zip for Plugin Manager.

    python3 tools/build_plugin.py [--version X.Y.Z] [--no-zip]

The zip's version comes from git, the tracked files are not changed: MAJOR.MINOR from octoprint_plotter/_version.py,
PATCH = the number of commits (`git rev-list --count HEAD`), so every commit gives a new, higher version and Plugin
Manager installs the zip over the old one. Uncommitted changes add `.post<UTC yyyymmddHHMM>` (still higher than the clean
build of the same commit). --version sets an exact version instead. Only the copy inside the zip gets the version.

The app sources are never duplicated in git: octoprint_plotter/static/app/ is generated and git-ignored.
Standard library only.
"""

import argparse
import re
import shutil
import subprocess
from datetime import datetime, timezone
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


def check_version(version):
    if not re.fullmatch(r"\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-+]*)?", version):
        raise SystemExit(f"bad version: {version}")
    return version


def git(*args):
    return subprocess.run(["git", "-C", str(ROOT), *args], capture_output=True, text=True, check=True).stdout.strip()


def git_version(base, *, count=None, dirty=None, now=None):
    """MAJOR.MINOR of base + commit count; uncommitted changes add .post<UTC minute>."""
    m = re.match(r"(\d+)\.(\d+)", base)
    if not m:
        raise SystemExit(f"cannot read MAJOR.MINOR from {base}")
    count = int(git("rev-list", "--count", "HEAD")) if count is None else count
    dirty = bool(git("status", "--porcelain")) if dirty is None else dirty
    version = f"{m.group(1)}.{m.group(2)}.{count}"
    if dirty:
        version += ".post" + (now or datetime.now(timezone.utc)).strftime("%Y%m%d%H%M")
    return version


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
            if path == VERSION_FILE:
                z.writestr(f"{name}/{rel.as_posix()}", f'__version__ = "{version}"\n')
            else:
                z.write(path, f"{name}/{rel.as_posix()}")
    return target


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--version", help="an exact zip version instead of the one from git")
    ap.add_argument("--no-zip", action="store_true", help="only copy the app into the package")
    args = ap.parse_args(argv)
    version = check_version(args.version) if args.version else None
    copied = copy_app()
    print(f"app copied to {rel(STATIC_APP)}: {', '.join(copied)}")
    if not args.no_zip:
        version = version or git_version(read_version())
        print(f"zip: {rel(build_zip(version))} (version {version})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
