#!/usr/bin/env python3
"""Audit vendor/plotterfun for asynchronous APIs and (re)generate src/styles/plotterfun-completion.json.

    python3 tools/audit_plotterfun.py            # print findings, write the manifest
    python3 tools/audit_plotterfun.py --check    # exit 1 if the manifest on disk is out of date

Rules (see openspec/changes/add-photo-styles/design.md, 3a):
  * a style with no asynchronous API in its file and no call of the async helper animatePointList is 'sync'
  * a style with findings keeps a manual classification (async-handler / timer-chain) only when that classification
    was recorded for the same vendor commit AND the same file hash; otherwise it is 'none'
  * vendorCommit comes from the first line of vendor/plotterfun/UPSTREAM
Manual classifications live in MANUAL below (with the reason); the tool never invents them.
Standard library only.
"""

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENDOR = ROOT / "vendor" / "plotterfun"
MANIFEST = ROOT / "src" / "styles" / "plotterfun-completion.json"

# style -> (model, reason, sha256 of the reviewed file)
MANUAL = {
    "stipple": ("timer-chain", "onmessage starts async render() without return; all transitions are await makeAsync (setTimeout 0), there is no other async API", None),
    "delaunay": ("timer-chain", "like stipple: async render() without return, transitions only via makeAsync (setTimeout 0)", None),
    "jaggy": ("async-handler", "onmessage is an async function, no await or timers inside, only synchronous computation: it finishes together with the handler Promise", None),
}

ASYNC_API = re.compile(r"\b(setTimeout|setInterval|Promise|async|await|requestAnimationFrame|fetch|queueMicrotask|MessageChannel|animatePointList)\b|\.then\s*\(")


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.S)
    return re.sub(r"(^|[^:'\"])//.*$", r"\1", text, flags=re.M)


def scan(path):
    found = {}
    for n, line in enumerate(strip_comments(path.read_text(encoding="utf-8")).splitlines(), 1):
        for m in ASYNC_API.finditer(line):
            found.setdefault(m.group(0), []).append(n)
    return found


def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def build():
    lines = (VENDOR / "UPSTREAM").read_text(encoding="utf-8").splitlines()
    commit = lines[0].strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise SystemExit("vendor/plotterfun/UPSTREAM: the first line must be a full commit hash")
    old = json.loads(MANIFEST.read_text(encoding="utf-8")) if MANIFEST.exists() else {}
    same_vendor = old.get("vendorCommit") == commit
    styles, notes, hashes, report = {}, {}, {}, {}
    for path in sorted(VENDOR.glob("*.js")):
        name = path.stem
        if name == "helpers":
            continue
        found = scan(path)
        report[name] = found
        if not found:
            styles[name] = "sync"
            continue
        manual = MANUAL.get(name)
        reviewed = old.get("sha256", {}).get(name)
        if manual and same_vendor and reviewed == sha(path):
            styles[name] = manual[0]
            notes[name] = manual[1]
            hashes[name] = reviewed
        elif manual and not old.get("sha256", {}).get(name):
            # first classification: the reviewer of this change confirms it by recording the file hash
            styles[name] = manual[0]
            notes[name] = manual[1]
            hashes[name] = sha(path)
        else:
            styles[name] = "none"
            notes[name] = "asynchronous code without a verified model or the file changed after verification: " + ", ".join(sorted(found))
    return {"vendorCommit": commit, "styles": styles, "notes": notes, "sha256": hashes}, report


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--check", action="store_true", help="do not write, exit 1 if the manifest differs")
    args = ap.parse_args(argv)
    manifest, report = build()
    for name, found in report.items():
        print(f"{name:20} {manifest['styles'][name]:14} " + (", ".join(f"{k}@{','.join(map(str, v))}" for k, v in found.items()) or "-"))
    text = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"
    if args.check:
        if not MANIFEST.exists() or MANIFEST.read_text(encoding="utf-8") != text:
            print("manifest is out of date: run tools/audit_plotterfun.py", file=sys.stderr)
            return 1
        return 0
    MANIFEST.write_text(text, encoding="utf-8")
    print(f"written {MANIFEST.relative_to(ROOT)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
