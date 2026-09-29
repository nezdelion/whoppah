#!/usr/bin/env python3
"""Copy the app (index.html, src/, vendor/) into the OctoPrint plugin package and build a zip for Plugin Manager.

    python3 tools/build_plugin.py [--version X.Y.Z] [--no-zip]

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
APP_DIRS = ["src", "vendor"]  # vendor/ appears with third-party code (add-photo-styles); copied when present
SKIP = shutil.ignore_patterns("__pycache__", "*.pyc", ".DS_Store")


def read_version():
    m = re.search(r'__version__\s*=\s*"([^"]+)"', VERSION_FILE.read_text(encoding="utf-8"))
    if not m:
        raise SystemExit(f"cannot read the version from {VERSION_FILE}")
    return m.group(1)


def write_version(version):
    if not re.fullmatch(r"\d+\.\d+\.\d+([.\-+][0-9A-Za-z.\-+]*)?", version):
        raise SystemExit(f"bad version: {version}")
    VERSION_FILE.write_text(f'__version__ = "{version}"\n', encoding="utf-8")


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
    ap.add_argument("--version", help="set the plugin version before building")
    ap.add_argument("--no-zip", action="store_true", help="only copy the app into the package")
    args = ap.parse_args(argv)
    if args.version:
        write_version(args.version)
    version = read_version()
    copied = copy_app()
    print(f"app copied to {STATIC_APP.relative_to(ROOT)}: {', '.join(copied)}")
    if not args.no_zip:
        print(f"zip: {build_zip(version).relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
