"""Plugin settings on OctoPrint's real Settings/PluginSettings: undeclared keys are silently dropped there,
so every key the plugin writes must be in get_settings_defaults (FakeSettings in test_plugin.py accepts anything)."""

import logging
import threading

import pytest

import octoprint_plotter as plotter
from octoprint.plugin import PluginSettings
from octoprint.settings import Settings


@pytest.fixture
def plugin(tmp_path):
    config = tmp_path / "config.yaml"
    config.write_text("")
    settings = Settings(configfile=str(config), basedir=str(tmp_path))
    p = plotter.PlotterPlugin()
    p._settings = PluginSettings(settings, "plotter", defaults=p.get_settings_defaults())
    p._logger = logging.getLogger("test.plotter")
    p._epoch_lock = getattr(p, "_epoch_lock", threading.Lock())
    return p


def test_epoch_counters_are_persisted(plugin):
    assert plugin.current_epochs() == {"xy": 0, "z": 0}
    plugin.bump_epoch("G28")
    plugin.bump_epoch("connect", parts=("z",))
    assert plugin.current_epochs() == {"xy": 1, "z": 2}


def test_legacy_epoch_is_the_start_of_the_split_counters(plugin):
    plugin._settings.set(["positionEpoch"], 5)
    assert plugin.current_epochs() == {"xy": 5, "z": 5}
    plugin.bump_epoch("G28", parts=("xy",))
    assert plugin.current_epochs() == {"xy": 6, "z": 5}


@pytest.mark.parametrize("key", ["profile", "profiles", "calibration", "users", "positionEpoch", "positionEpochXY", "positionEpochZ"])
def test_every_stored_key_round_trips(plugin, key):
    plugin._settings.set([key], {"probe": 1} if key in ("profile", "profiles", "calibration", "users") else 7)
    assert plugin._settings.get([key]) is not None
