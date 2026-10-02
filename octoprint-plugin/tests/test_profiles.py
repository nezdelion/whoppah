"""Machine profiles API: permissions, validation, revisions, server migration, the old profile address, calibration stamps."""

import json
import threading

import octoprint_plotter as plotter
from test_plugin import env, put  # noqa: F401  (fixture reuse)

BASE = "/plugin/plotter/api/profiles"


def headers(env):
    return {"X-CSRF-Token": env.token}


def get(env):
    return env.client.get(BASE)


def put_profile(env, pid, body):
    return env.client.put(f"{BASE}/{pid}", data=json.dumps(body), headers=headers(env), content_type="application/json")


def put_active(env, pid):
    return env.client.put(f"{BASE}/active", data=json.dumps({"id": pid}), headers=headers(env), content_type="application/json")


def delete(env, pid):
    return env.client.delete(f"{BASE}/{pid}", headers=headers(env))


def put_all(env, col):
    return env.client.put(BASE, data=json.dumps(col), headers=headers(env), content_type="application/json")


def admin(env):
    env.who.rights = {plotter.NEEDS_PROFILE, "CONTROL"}


def pid(n):
    return f"p_{n:08x}"


def stored(env):
    return env.plugin._settings.data.get("profiles")


# ~~ migration

def test_first_read_by_a_user_without_permission_migrates_the_old_profile(env):
    env.plugin._settings.data["profile"] = {"fDraw": 2500}
    env.plugin._settings.data["calibration"] = {"cornerX": -3, "cornerY": 48, "zTouch": 8, "epochXY": 1, "epochZ": 1}
    r = get(env)
    assert r.status_code == 200
    col = r.get_json()
    (item,) = col["items"]
    assert item["name"] == "Neptune 3 Pro" and col["activeId"] == item["id"]
    assert item["values"]["fDraw"] == 2500 and item["values"]["bedX0"] is None and item["values"]["bedW"] == 235
    assert stored(env) == col
    assert env.plugin._settings.data["profile"] == {"fDraw": 2500}, "the old section stays for a rollback"
    cal = env.plugin._settings.data["calibration"]
    assert cal["profileXY"] == item["id"] and cal["profileZ"] == item["id"], "the calibration belongs to the migrated profile"


def test_migration_runs_once_also_on_concurrent_first_reads(env):
    results = []
    threads = [threading.Thread(target=lambda: results.append(env.plugin._ensure_profiles()["activeId"])) for _ in range(4)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert len(set(results)) == 1
    assert get(env).get_json()["activeId"] == results[0]
    assert len(stored(env)["items"]) == 1


def test_migration_without_an_old_profile_gives_defaults(env):
    col = get(env).get_json()
    assert col["items"][0]["name"] == "Neptune 3 Pro"
    assert col["items"][0]["values"]["bedUrNominal"] is False


def test_profiles_need_login(env):
    env.who.user = None
    assert get(env).status_code == 403
    assert put_active(env, pid(1)).status_code == 403


# ~~ the old address of the profile section

def test_old_address_reads_and_writes_the_active_profile_only(env):
    admin(env)
    first = get(env).get_json()["activeId"]
    assert put_profile(env, pid(2), {"name": "B", "values": {"fDraw": 1000}}).status_code == 200
    assert put(env, "profile", {"fDraw": 1234}).status_code == 200
    col = get(env).get_json()
    values = {p["id"]: p["values"] for p in col["items"]}
    assert values[first]["fDraw"] == 1234 and values[pid(2)]["fDraw"] == 1000
    assert env.client.get("/plugin/plotter/api/settings/profile").get_json()["fDraw"] == 1234
    put_active(env, pid(2))
    assert env.client.get("/plugin/plotter/api/settings/profile").get_json()["fDraw"] == 1000
    assert env.plugin._settings.data["profile"] is None, "the old section itself is not written"


# ~~ permissions

def test_every_write_needs_the_profile_permission(env):
    env.who.rights = {"CONTROL"}
    col = get(env).get_json()
    first = col["activeId"]
    before = json.dumps(stored(env), sort_keys=True)
    assert put_profile(env, pid(2), {"name": "B", "values": {}}).status_code == 403
    assert put_profile(env, first, {"name": "X", "values": {}}).status_code == 403
    assert delete(env, first).status_code == 403
    assert put_active(env, first).status_code == 403
    assert put_all(env, col).status_code == 403
    assert put(env, "profile", {"fDraw": 1}).status_code == 403
    assert json.dumps(stored(env), sort_keys=True) == before


def test_choosing_the_active_profile_without_permission_is_refused(env):
    admin(env)
    put_profile(env, pid(2), {"name": "B", "values": {}})
    first = get(env).get_json()["activeId"]
    env.who.rights = set()
    assert put_active(env, pid(2)).status_code == 403
    assert get(env).get_json()["activeId"] == first
    env.who.rights = {plotter.NEEDS_PROFILE}
    assert put_active(env, pid(2)).get_json()["activeId"] == pid(2)
    assert put_active(env, pid(9)).status_code == 404


def test_csrf_is_required(env):
    admin(env)
    r = env.client.put(f"{BASE}/active", data=json.dumps({"id": pid(1)}), content_type="application/json")
    assert r.status_code == 400


# ~~ operations and validation

def test_create_rename_delete_and_active_neighbour(env):
    admin(env)
    first = get(env).get_json()["activeId"]
    put_profile(env, pid(2), {"name": "B", "values": {"fDraw": 1}})
    put_profile(env, pid(3), {"name": "C", "values": {}})
    assert put_profile(env, pid(2), {"name": "b2", "values": {"fDraw": 1}, "rev": 1}).get_json()["items"][1]["name"] == "b2"
    put_active(env, pid(3))
    col = delete(env, pid(3)).get_json()
    assert col["activeId"] == pid(2), "the previous one becomes active"
    put_active(env, first)
    col = delete(env, first).get_json()
    assert col["activeId"] == pid(2), "no previous one: the next one"
    r = delete(env, pid(2))
    assert r.status_code == 409 and r.get_json()["code"] == "last"
    assert len(get(env).get_json()["items"]) == 1
    assert delete(env, pid(7)).status_code == 404


def test_names_are_checked(env):
    admin(env)
    get(env)
    assert put_profile(env, pid(2), {"name": "neptune 3 PRO", "values": {}}).status_code == 400
    assert put_profile(env, pid(2), {"name": "  ", "values": {}}).status_code == 400
    assert put_profile(env, pid(2), {"name": "x" * 65, "values": {}}).status_code == 400
    assert put_profile(env, "Neptune", {"name": "x", "values": {}}).status_code == 400
    assert len(stored(env)["items"]) == 1


def test_the_21st_profile_is_refused(env):
    admin(env)
    get(env)
    for n in range(2, 21):
        assert put_profile(env, pid(n), {"name": f"P{n}", "values": {}}).status_code == 200
    assert len(stored(env)["items"]) == 20
    assert put_profile(env, pid(21), {"name": "P21", "values": {}}).status_code == 400
    assert len(stored(env)["items"]) == 20


def test_degenerate_or_partial_bed_is_refused(env):
    admin(env)
    first = get(env).get_json()["activeId"]
    before = json.dumps(stored(env), sort_keys=True)
    bad = {"bedX0": 100, "bedY0": 0, "bedX1": 50, "bedY1": 10}
    assert put_profile(env, first, {"name": "Neptune 3 Pro", "values": bad}).status_code == 400
    assert put_profile(env, first, {"name": "Neptune 3 Pro", "values": {"bedX0": -12, "bedY0": -3}}).status_code == 400
    assert put(env, "profile", bad).status_code == 400
    assert json.dumps(stored(env), sort_keys=True) == before
    ok = {"bedX0": -12, "bedY0": -3, "bedX1": 221, "bedY1": 230}
    assert put_profile(env, first, {"name": "Neptune 3 Pro", "values": ok}).status_code == 200


def test_revision_conflict_returns_the_current_profile(env):
    admin(env)
    first = get(env).get_json()["activeId"]
    a = put_profile(env, first, {"name": "Neptune 3 Pro", "values": {"fDraw": 2000}, "rev": 1})
    assert a.status_code == 200 and a.get_json()["items"][0]["rev"] == 2
    b = put_profile(env, first, {"name": "Neptune 3 Pro", "values": {"penWidthMm": 0.3}, "rev": 1})
    assert b.status_code == 409
    body = b.get_json()
    assert body["code"] == "conflict" and body["profile"]["values"] == {"fDraw": 2000} and body["profile"]["rev"] == 2
    assert stored(env)["items"][0]["values"] == {"fDraw": 2000}


def test_import_replaces_the_collection_after_checks(env):
    admin(env)
    get(env)
    col = {"version": 1, "rev": 1, "activeId": pid(5), "items": [
        {"id": pid(4), "name": "A", "values": {"fDraw": 1}},
        {"id": pid(5), "name": "B", "values": {}},
    ]}
    r = put_all(env, col)
    assert r.status_code == 200
    got = get(env).get_json()
    assert got["activeId"] == pid(5) and [p["name"] for p in got["items"]] == ["A", "B"]
    for bad in ({**col, "activeId": pid(9)}, {**col, "items": col["items"] * 11}, {**col, "items": [{"id": pid(4), "name": "a"}, {"id": pid(5), "name": "A", "values": {}}]}):
        assert put_all(env, bad).status_code == 400
    assert get(env).get_json()["activeId"] == pid(5)


def test_too_large_profile_is_413(env):
    admin(env)
    first = get(env).get_json()["activeId"]
    assert put_profile(env, first, {"name": "N", "values": {"blob": "x" * (1024 * 1024 + 10)}}).status_code == 413


# ~~ calibration stamps: the active profile on capture, confirmation and manual input

def post(env, path, body=None):
    return env.client.post(f"/plugin/plotter/api/calibration/{path}", data=json.dumps(body or {}), headers=headers(env), content_type="application/json")


def calibration(env):
    return env.client.get("/plugin/plotter/api/settings/calibration").get_json()


def test_capture_confirm_and_manual_input_stamp_the_active_profile(env):
    admin(env)
    first = get(env).get_json()["activeId"]
    put_profile(env, pid(2), {"name": "B", "values": {}})
    assert post(env, "xy", {"x": -5, "y": 50, "epoch": 0}).status_code == 200
    assert post(env, "z", {"zTouch": 8, "epoch": 0}).status_code == 200
    c = calibration(env)
    assert (c["profileXY"], c["profileZ"]) == (first, first)
    put_active(env, pid(2))
    assert post(env, "xy/confirm").status_code == 200
    c = calibration(env)
    assert (c["profileXY"], c["profileZ"]) == (pid(2), first)
    doc = dict(c, zTouch=8.5, profileZ="p_ffffffff")  # a client cannot choose the profile of a part
    assert put(env, "calibration", doc).status_code == 200
    c = calibration(env)
    assert (c["profileXY"], c["profileZ"]) == (pid(2), pid(2))
    put_active(env, first)
    assert put(env, "calibration", dict(c, cornerX=-4)).status_code == 200
    c = calibration(env)
    assert (c["profileXY"], c["profileZ"]) == (first, pid(2)), "only the changed part takes the active profile"


def test_env_json_has_the_profiles_address(env):
    assert env.client.get("/plugin/plotter/env.json").get_json()["profilesUrl"] == "/plugin/plotter/api/profiles"
