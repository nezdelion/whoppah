"""Reading the head position through the printer's own answers.

OctoPrint's REST API does not return printer replies, so the reply to ``M114`` is picked out of the received lines.
Every request is wrapped in ``M118`` markers with a random id: only lines between the markers of the *current*
request count, so late replies of an earlier (timed out) request cannot complete a newer one.
"""

import re
import secrets
import threading

COORDS = re.compile(r"(?:^|[\s:])X:\s*(-?\d+(?:\.\d+)?)\s+Y:\s*(-?\d+(?:\.\d+)?)\s+Z:\s*(-?\d+(?:\.\d+)?)")
MARKER = re.compile(r"\bPLT_([BE]) ([0-9a-f]{8})\b")
UNKNOWN_M118 = re.compile(r"Unknown command.*M118", re.IGNORECASE)


def parse_coordinates(line):
    """(x, y, z) from an ``M114`` reply (the values before ``Count``), or None."""
    text = line.split("Count", 1)[0]
    m = COORDS.search(text)
    if not m:
        return None
    return float(m.group(1)), float(m.group(2)), float(m.group(3))


def parse_marker(line):
    """("B" | "E", rid) for a marker line, or None."""
    m = MARKER.search(line)
    return (m.group(1), m.group(2)) if m else None


def epoch_parts(cmd):
    """Which coordinate parts a sent command shifts: a subset of {"xy", "z"}.

    ``G28`` without axes homes everything (both parts); with axes only the named ones (X/Y -> xy, Z -> z);
    other parameters (O, R, L) are not axes. ``G92``: X/Y -> xy, Z -> z, only E (or other non-axis parameters) -> nothing,
    bare ``G92`` -> both. Anything else shifts nothing.
    """
    text = cmd.split(";", 1)[0].strip().upper() if isinstance(cmd, str) else ""
    m = re.match(r"^(?:N\d+\s+)?G0*(28|92)(?![0-9.])\s*(.*)$", text)
    if not m:
        return set()
    letters = set(re.findall(r"[A-Z]", m.group(2)))
    parts = set()
    if letters & {"X", "Y"}:
        parts.add("xy")
    if "Z" in letters:
        parts.add("z")
    if parts:
        return parts
    if m.group(1) == "92" and letters:
        return set()
    return {"xy", "z"}


def is_unknown_m118(line):
    return bool(UNKNOWN_M118.search(line))


class PositionReader:
    """One read at a time. ``feed`` is called for every received line; ``read`` blocks until the answer or a timeout."""

    def __init__(self, timeout=10.0):
        self.timeout = timeout
        self._cond = threading.Condition()
        self._busy = False
        self._rid = None
        self._state = "idle"  # idle | waiting_begin | collecting | done | unsupported
        self._coords = None
        self._result = None

    @property
    def busy(self):
        with self._cond:
            return self._busy

    def start(self):
        """Claim the reader; returns the new request id, or None when another read is running."""
        with self._cond:
            if self._busy:
                return None
            self._busy = True
            self._rid = secrets.token_hex(4)
            self._state = "waiting_begin"
            self._coords = None
            self._result = None
            return self._rid

    def commands(self, rid):
        return [f"M118 PLT_B {rid}", "M400", "M114", f"M118 PLT_E {rid}"]

    def wait(self, rid, timeout=None):
        """('ok', (x, y, z)) | ('unsupported', None) | ('nocoords', None) | ('timeout', None); always releases the reader."""
        deadline_timeout = self.timeout if timeout is None else timeout
        with self._cond:
            try:
                self._cond.wait_for(lambda: self._state in ("done", "unsupported") or self._rid != rid, deadline_timeout)
                if self._rid != rid:
                    return "timeout", None
                if self._state == "unsupported":
                    return "unsupported", None
                if self._state == "done":
                    return ("ok", self._result) if self._result else ("nocoords", None)
                return "timeout", None
            finally:
                if self._rid == rid:
                    self._rid = None
                    self._state = "idle"
                    self._busy = False

    def feed(self, line):
        try:
            self._feed(line)
        except Exception:  # pragma: no cover - the hook must never break the serial loop
            pass

    def _feed(self, line):
        if not isinstance(line, str):
            return
        with self._cond:
            if self._rid is None or self._state in ("idle", "done", "unsupported"):
                return
            if is_unknown_m118(line):
                self._state = "unsupported"
                self._cond.notify_all()
                return
            marker = parse_marker(line)
            if marker:
                kind, rid = marker
                if rid != self._rid:
                    return
                if kind == "B" and self._state == "waiting_begin":
                    self._state = "collecting"
                    self._coords = None
                elif kind == "E" and self._state == "collecting":
                    self._result = self._coords
                    self._state = "done"
                    self._cond.notify_all()
                return
            if self._state == "collecting":
                coords = parse_coordinates(line)
                if coords:
                    self._coords = coords
