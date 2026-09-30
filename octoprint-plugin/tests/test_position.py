"""Position read (markers, timeouts, late replies), coordinate epoch, capture and confirm routes."""

import json
import threading
import time

import pytest

import octoprint_plotter as plotter
from octoprint_plotter.position import is_unknown_m118, parse_coordinates, parse_marker
from test_plugin import env, put  # noqa: F401  (fixture reuse)

HEADERS = lambda env: {"X-CSRF-Token": env.token}  # noqa: E731


# ~~ parsing

@pytest.mark.parametrize("line, expected", [
    ("X:-5.00 Y:50.00 Z:8.00 E:0.00 Count X:-400 Y:4000 Z:3200", (-5.0, 50.0, 8.0)),
    ("X:0.00 Y:0.00 Z:0.00 E:0.00 Count X: 0 Y:0 Z:0", (0.0, 0.0, 0.0)),
    ("ok X:12.5 Y:-3 Z:10.25 E:0.00 Count X:1 Y:2 Z:3", (12.5, -3.0, 10.25)),
    ("X:-15.00 Y:40.00 Z:8.20 E:0.00", (-15.0, 40.0, 8.2)),
])
def test_parse_coordinates(line, expected):
    assert parse_coordinates(line) == expected


@pytest.mark.parametrize("line", [
    "", "ok", "T:21.0 /0.0 B:20.0 /0.0", "echo:busy: processing", "Count X:1 Y:2 Z:3", "X:abc Y:1 Z:2", "PLT_B deadbeef",
])
def test_parse_coordinates_rejects_garbage(line):
    assert parse_coordinates(line) is None


def test_parse_marker_and_unknown_command():
    assert parse_marker("PLT_B 0a1b2c3d") == ("B", "0a1b2c3d")
    assert parse_marker("echo:PLT_E 0a1b2c3d") == ("E", "0a1b2c3d")
    assert parse_marker("PLT_B XYZ") is None and parse_marker("nothing") is None
    assert is_unknown_m118('echo:Unknown command: "M118 PLT_B 0a1b2c3d"')
    assert not is_unknown_m118('echo:Unknown command: "M999"')


# ~~ fake printer

class FakePrinter:
    """commands() answers like Marlin: from a script of received lines, optionally on another thread."""

    def __init__(self, plugin, reply=None):
        self.plugin = plugin
        self.operational = True
        self.printing = False
        self.sent = []
        self.reply = reply  # callable(lines) -> list of received lines, or None for the default answer
        self.defer = False

    def is_operational(self): return self.operational
    def is_printing(self): return self.printing
    def is_paused(self): return False
    def is_pausing(self): return False
    def is_cancelling(self): return False
    def is_finishing(self): return False

    @staticmethod
    def default(lines, coords="X:-5.00 Y:50.00 Z:8.00 E:0.00 Count X:-400 Y:4000 Z:3200"):
        b, _m400, _m114, e = lines
        return [b.replace("M118 ", ""), "ok", "ok", coords, "ok", e.replace("M118 ", ""), "ok"]

    def commands(self, lines, tags=None):
        self.sent.append(list(lines))
        received = self.reply(lines) if self.reply else self.default(lines)
        if self.defer:
            threading.Timer(0.05, lambda: [self.plugin.on_gcode_received(None, x) for x in received]).start()
        else:
            for x in received:
                self.plugin.on_gcode_received(None, x)


@pytest.fixture
def printer(env):  # noqa: F811
    env.who.rights = {"CONTROL"}
    p = FakePrinter(env.plugin)
    env.plugin._printer = p
    env.plugin._reader.timeout = 0.3
    return p


def read(env):
    return env.client.post("/plugin/plotter/api/position", headers=HEADERS(env))


def post(env, path, body=None):
    return env.client.post(f"/plugin/plotter/api/calibration/{path}", data=json.dumps(body or {}), headers=HEADERS(env), content_type="application/json")


def calibration(env):
    return env.client.get("/plugin/plotter/api/settings/calibration").get_json()


def epochs(env):
    return env.client.get("/plugin/plotter/api/position/epoch").get_json()


def epoch(env, part="xy"):
    return epochs(env)[part]


def sent(env, cmd):
    env.plugin.on_gcode_sent(None, "sent", cmd, None, cmd.split()[0].upper())


def g28(env, args=""):
    sent(env, f"G28 {args}".strip())


# ~~ position read

def test_read_success_sends_markers_in_order(env, printer):
    r = read(env)
    assert r.status_code == 200
    data = r.get_json()
    assert (data["x"], data["y"], data["z"], data["epochXY"], data["epochZ"]) == (-5.0, 50.0, 8.0, 0, 0)
    b, m400, m114, e = printer.sent[0]
    rid = b.split()[-1]
    assert (b, m400, m114, e) == (f"M118 PLT_B {rid}", "M400", "M114", f"M118 PLT_E {rid}") and len(rid) == 8


def test_read_works_when_answers_arrive_later(env, printer):
    printer.defer = True
    assert read(env).get_json()["x"] == -5.0


def test_read_needs_control_and_login(env, printer):
    env.who.rights = set()
    assert read(env).status_code == 403
    env.who.rights = {"CONTROL"}
    env.who.user = None
    assert read(env).status_code == 403
    assert printer.sent == []


def test_read_offline_and_busy(env, printer):
    printer.operational = False
    r = read(env)
    assert r.status_code == 409 and r.get_json()["code"] == "offline"
    printer.operational, printer.printing = True, True
    r = read(env)
    assert r.status_code == 409 and r.get_json()["code"] == "busy"
    assert printer.sent == []


def test_read_timeout_is_504_and_state_is_released(env, printer):
    printer.reply = lambda lines: []
    r = read(env)
    assert r.status_code == 504 and r.get_json()["code"] == "timeout"
    printer.reply = None
    assert read(env).status_code == 200


def test_coordinates_before_begin_marker_are_ignored(env, printer):
    def reply(lines):
        b, _, _, e = lines
        return ["X:1.00 Y:1.00 Z:1.00 E:0.00 Count X:1 Y:1 Z:1", b.replace("M118 ", ""), "X:-5.00 Y:50.00 Z:8.00 E:0.00 Count X:1 Y:1 Z:1", e.replace("M118 ", "")]
    printer.reply = reply
    assert read(env).get_json()["x"] == -5.0


def test_last_coordinates_in_the_window_win(env, printer):
    def reply(lines):
        b, _, _, e = lines
        return [b.replace("M118 ", ""), "X:1.00 Y:2.00 Z:3.00 E:0 Count X:1 Y:1 Z:1", "X:4.00 Y:5.00 Z:6.00 E:0 Count X:1 Y:1 Z:1", e.replace("M118 ", "")]
    printer.reply = reply
    d = read(env).get_json()
    assert (d["x"], d["y"], d["z"]) == (4.0, 5.0, 6.0)


def test_late_markers_of_an_aborted_request_do_not_finish_the_next(env, printer):
    printer.reply = lambda lines: []
    assert read(env).status_code == 504
    old_rid = printer.sent[0][0].split()[-1]

    def reply(lines):
        b, _, _, e = lines
        # the late answers of the first request arrive first, then the second request's own answer
        return [f"PLT_B {old_rid}", "X:99.00 Y:99.00 Z:99.00 E:0 Count X:1 Y:1 Z:1", f"PLT_E {old_rid}",
                b.replace("M118 ", ""), "X:-5.00 Y:50.00 Z:8.00 E:0 Count X:1 Y:1 Z:1", e.replace("M118 ", "")]
    printer.reply = reply
    d = read(env).get_json()
    assert (d["x"], d["y"], d["z"]) == (-5.0, 50.0, 8.0)


def test_late_end_marker_alone_does_not_complete_the_second_request(env, printer):
    printer.reply = lambda lines: []
    read(env)
    old_rid = printer.sent[0][0].split()[-1]
    printer.reply = lambda lines: [f"PLT_E {old_rid}", "X:99 Y:99 Z:99 E:0 Count X:1 Y:1 Z:1"]
    assert read(env).status_code == 504


def test_second_read_while_first_runs_is_busy(env, printer):
    printer.reply = lambda lines: []
    env.plugin._reader.timeout = 1.0
    first = {}
    t = threading.Thread(target=lambda: first.setdefault("r", read(env)))
    t.start()
    for _ in range(100):
        if env.plugin._reader.busy:
            break
        time.sleep(0.01)
    r = read(env)
    assert r.status_code == 409 and r.get_json()["code"] == "busy"
    t.join()
    assert first["r"].status_code == 504


def test_unknown_m118_is_501(env, printer):
    printer.reply = lambda lines: [f'echo:Unknown command: "{lines[0]}"', "ok"]
    r = read(env)
    assert r.status_code == 501 and r.get_json()["code"] == "unsupported"


def test_no_coordinates_between_markers(env, printer):
    printer.reply = lambda lines: [lines[0].replace("M118 ", ""), lines[3].replace("M118 ", "")]
    r = read(env)
    assert r.status_code == 502 and r.get_json()["code"] == "nocoords"


def test_g28_during_the_read_makes_it_stale(env, printer):
    def reply(lines):
        g28(env)
        return FakePrinter.default(lines)
    printer.reply = reply
    r = read(env)
    assert r.status_code == 409 and r.get_json()["code"] == "stale"


# ~~ epoch

def test_epoch_changes_on_g28_and_connect(env):
    assert epochs(env) == {"xy": 0, "z": 0}
    g28(env)
    assert epochs(env) == {"xy": 1, "z": 1}
    env.plugin.on_gcode_sent(None, "sent", "G1 X1", None, "G1")
    env.plugin.on_gcode_sent(None, "sent", "M114", None, "M114")
    assert epochs(env) == {"xy": 1, "z": 1}
    env.plugin.on_event("Connected", {})
    env.plugin.on_event("Disconnected", {})
    assert epochs(env) == {"xy": 2, "z": 2}
    data = env.plugin._settings.data  # persisted in the plugin settings
    assert (data["positionEpochXY"], data["positionEpochZ"]) == (2, 2)


@pytest.mark.parametrize("cmd, expected", [
    ("G28", {"xy": 1, "z": 1}),
    ("G28 O", {"xy": 1, "z": 1}),  # O is not an axis: same as a bare G28
    ("G28 X Y", {"xy": 1, "z": 0}),
    ("G28 X", {"xy": 1, "z": 0}),
    ("G28 Z", {"xy": 0, "z": 1}),
    ("G28 X Z", {"xy": 1, "z": 1}),
    ("G28 O Z", {"xy": 0, "z": 1}),
    ("G92 E0", {"xy": 0, "z": 0}),
    ("G92 Z5", {"xy": 0, "z": 1}),
    ("G92 X0 Y0", {"xy": 1, "z": 0}),
    ("G92 X0 E0", {"xy": 1, "z": 0}),
    ("G92", {"xy": 1, "z": 1}),
    ("G1 X10 Z5", {"xy": 0, "z": 0}),
])
def test_epoch_parts_per_command(env, cmd, expected):
    sent(env, cmd)
    assert epochs(env) == expected


def test_g28_xy_keeps_touch_fresh_and_stales_corner(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    assert fresh(env) == {"xy": True, "z": True}
    g28(env, "X Y")
    assert fresh(env) == {"xy": False, "z": True}


def test_g28_z_keeps_corner_fresh_and_stales_touch(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    g28(env, "Z")
    assert fresh(env) == {"xy": True, "z": False}


def test_bare_g28_and_g28_o_stale_both_and_g92_e_neither(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    sent(env, "G92 E0")
    assert fresh(env) == {"xy": True, "z": True}
    g28(env, "O")
    assert fresh(env) == {"xy": False, "z": False}


def test_connect_stales_both(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    env.plugin.on_event("Connected", {})
    assert fresh(env) == {"xy": False, "z": False}


def test_capture_uses_the_counter_of_its_own_part(env):
    env.who.rights = {"CONTROL"}
    g28(env, "Z")  # xy stays 0, z is 1
    assert post(env, "xy", {"x": 1, "y": 2, "epoch": 0}).status_code == 200
    assert post(env, "z", {"zTouch": 7, "epoch": 0}).status_code == 409  # z counter is 1 now
    assert post(env, "z", {"zTouch": 7, "epoch": 1}).status_code == 200
    c = calibration(env)
    assert (c["epochXY"], c["epochZ"]) == (0, 1)


def test_position_read_is_stale_when_either_counter_changes(env, printer):
    def reply(lines):
        g28(env, "Z")
        return FakePrinter.default(lines)
    printer.reply = reply
    r = read(env)
    assert r.status_code == 409 and r.get_json()["code"] == "stale"


def test_migration_counters_start_from_the_single_position_epoch(env):
    env.plugin._settings.data["positionEpoch"] = 5  # settings of the version before the split
    env.plugin._settings.data["calibration"] = {"cornerX": 1, "cornerY": 2, "zTouch": 7, "epochXY": 5, "epochZ": 5}
    assert epochs(env) == {"xy": 5, "z": 5}
    assert fresh(env) == {"xy": True, "z": True}
    g28(env, "X Y")
    assert epochs(env) == {"xy": 6, "z": 5}
    assert fresh(env) == {"xy": False, "z": True}


def test_epoch_needs_login_not_control(env):
    assert env.client.get("/plugin/plotter/api/position/epoch").status_code == 200
    env.who.user = None
    assert env.client.get("/plugin/plotter/api/position/epoch").status_code == 403


def test_hooks_are_registered_and_pass_lines_through():
    assert callable(plotter.__plugin_hooks__["octoprint.comm.protocol.gcode.received"])
    assert callable(plotter.__plugin_hooks__["octoprint.comm.protocol.gcode.sent"])
    assert plotter.PlotterPlugin().on_gcode_received(None, "ok T:1") == "ok T:1"


# ~~ capture and confirm

def fresh(env):
    c, now = calibration(env), epochs(env)
    return {"xy": c.get("epochXY") == now["xy"], "z": c.get("epochZ") == now["z"]}


def test_capture_xy_and_z_store_values_and_epochs(env):
    env.who.rights = {"CONTROL"}
    g28(env)
    r = post(env, "xy", {"x": -5, "y": 50.5, "epoch": 1})
    assert r.status_code == 200
    c = calibration(env)
    assert (c["cornerX"], c["cornerY"], c["epochXY"]) == (-5, 50.5, 1) and c["updatedAt"]
    assert "epochZ" not in c
    assert post(env, "z", {"zTouch": 8.2, "epoch": 1}).status_code == 200
    c = calibration(env)
    assert (c["zTouch"], c["epochZ"], c["cornerX"]) == (8.2, 1, -5)
    assert fresh(env) == {"xy": True, "z": True}


def test_g28_between_read_and_save_rejects_and_keeps_calibration(env):
    env.who.rights = {"CONTROL"}
    assert post(env, "xy", {"x": 1, "y": 2, "epoch": 0}).status_code == 200
    before = calibration(env)
    g28(env)
    r = post(env, "xy", {"x": 9, "y": 9, "epoch": 0})
    assert r.status_code == 409 and r.get_json()["code"] == "stale"
    assert calibration(env) == before
    r = post(env, "z", {"zTouch": 9, "epoch": 0})
    assert r.status_code == 409 and calibration(env) == before


def test_after_g28_capturing_only_the_corner_keeps_z_stale(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    assert fresh(env) == {"xy": True, "z": True}
    g28(env)
    assert fresh(env) == {"xy": False, "z": False}
    post(env, "xy", {"x": 3, "y": 4, "epoch": 1})
    assert fresh(env) == {"xy": True, "z": False}


def test_confirm_makes_a_part_fresh_without_changing_values(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    g28(env)
    post(env, "xy", {"x": 3, "y": 4, "epoch": 1})
    before = calibration(env)
    assert post(env, "z/confirm").status_code == 200
    after = calibration(env)
    assert fresh(env) == {"xy": True, "z": True}
    assert {k: v for k, v in after.items() if k != "epochZ"} == {k: v for k, v in before.items() if k != "epochZ"}


def test_confirm_on_empty_calibration_creates_defaults(env):
    env.who.rights = {"CONTROL"}
    g28(env)
    assert post(env, "xy/confirm").status_code == 200
    c = calibration(env)
    assert (c["cornerX"], c["cornerY"], c["zTouch"], c["epochXY"]) == (-5, 50, 8, 1) and "epochZ" not in c


def test_capture_and_confirm_need_control(env):
    for path, body in (("xy", {"x": 1, "y": 2, "epoch": 0}), ("z", {"zTouch": 1, "epoch": 0}), ("xy/confirm", {}), ("z/confirm", {})):
        assert post(env, path, body).status_code == 403
    assert env.plugin._settings.data["calibration"] is None
    env.who.rights = {"CONTROL"}
    env.who.user = None
    assert post(env, "xy/confirm").status_code == 403


@pytest.mark.parametrize("path, body", [
    ("xy", {"x": "1", "y": 2, "epoch": 0}), ("xy", {"x": 1, "epoch": 0}), ("xy", {"x": 1, "y": 2}),
    ("z", {"zTouch": None, "epoch": 0}), ("z", {"zTouch": 1, "epoch": "0"}), ("z", {"zTouch": True, "epoch": 0}),
])
def test_capture_validates_the_body(env, path, body):
    env.who.rights = {"CONTROL"}
    assert post(env, path, body).status_code == 400
    assert env.plugin._settings.data["calibration"] is None


def test_manual_input_updates_only_changed_parts(env):
    env.who.rights = {"CONTROL"}
    post(env, "xy", {"x": 1, "y": 2, "epoch": 0})
    post(env, "z", {"zTouch": 7, "epoch": 0})
    g28(env)  # epoch 1, both stale
    doc = calibration(env)
    doc["zTouch"] = 7.5
    doc["epochXY"] = 1  # a client cannot claim freshness for a part it did not change
    assert put(env, "calibration", doc).status_code == 200
    c = calibration(env)
    assert c["epochZ"] == 1 and c["epochXY"] == 0 and c["zTouch"] == 7.5
    assert fresh(env) == {"xy": False, "z": True}
    doc = dict(c, cornerX=4)
    put(env, "calibration", doc)
    assert fresh(env) == {"xy": True, "z": True}


def test_manual_input_without_changes_keeps_epochs_and_first_edit_uses_defaults(env):
    env.who.rights = {"CONTROL"}
    g28(env)
    put(env, "calibration", {"cornerX": -5, "cornerY": 50, "zTouch": 9})  # only Z differs from the app defaults
    c = calibration(env)
    assert c["epochZ"] == 1 and "epochXY" not in c
    put(env, "calibration", {"cornerX": -5, "cornerY": 50, "zTouch": 9})
    assert calibration(env)["epochZ"] == 1


# ~~ recorded lines

def test_recorded_virtual_printer_exchange_yields_the_position():
    import os
    from octoprint_plotter.position import PositionReader

    path = os.path.join(os.path.dirname(__file__), "fixtures", "virtual_printer_m118_m114.txt")
    lines = [l.rstrip("\n") for l in open(path, encoding="utf-8") if l.startswith("Recv: ")]
    reader = PositionReader(timeout=0.5)
    rid = reader.start()
    for line in lines[:-1]:  # up to the printer's answer to the recorded request
        reader.feed(line[len("Recv: "):].replace("608aaaba", rid))
    assert reader.wait(rid, 0.5) == ("ok", (-15.0, 40.0, 8.2))
    assert parse_coordinates(lines[-1][len("Recv: "):]) == (-5.0, 50.0, 8.0)
