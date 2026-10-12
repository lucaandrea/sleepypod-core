"""Contract tests run with common's stdlib-only test environment."""
import math

import pytest

from common.biometrics.config import canonical_json, config_hash, manifest, resolve_config, validate_config


def test_defaults_do_not_mutate_the_shipped_manifest():
    profile = resolve_config([])
    profile["resolved"]["heart_rate"]["trackingToleranceBpm"] = 25
    assert resolve_config([])["resolved"]["heart_rate"]["trackingToleranceBpm"] == 15
    assert manifest()["components"]["hrv_index"]["metricId"] == "window_ibi_variability_v1"
    assert manifest()["components"]["sleep_stages"]["causal"] is False


def test_false_zero_and_rule_order_are_preserved():
    resolved = resolve_config([
        {"path": "sleep_stages.ruleset.smoothIsolatedEpochs", "value": False},
        {"path": "sleep_stages.ruleset.lowSignalBelow", "value": 0}])
    assert resolved["resolved"]["sleep_stages"]["ruleset"]["lowSignalBelow"] == 0
    assert resolved["resolved"]["sleep_stages"]["ruleset"]["smoothIsolatedEpochs"] is False
    rules = [{"stage": "wake", "when": []}, {"stage": "light", "when": []}]
    forward = resolve_config([{"path": "sleep_stages.ruleset.rules", "value": rules}])
    reverse = resolve_config([{"path": "sleep_stages.ruleset.rules", "value": rules[::-1]}])
    assert forward["hash"] != reverse["hash"]


@pytest.mark.parametrize("path,value", [
    ("heart_rate.trackingToleranceBpm", True),
    ("heart_rate.trackingToleranceBpm", 0),
    ("heart_rate.trackingHistoryLength", 1.5),
    ("hrv_index.harmonicTolerance", math.nan),
    ("sleep_stages.ruleset.smoothIsolatedEpochs", 0),
    ("sleep_stages.ruleset.fallback", None),
    ("sleep_stages.ruleset.outliers.heartRate.min", 150),
    ("sleep_stages.ruleset.rules.0.stage", "wake"),
    ("sleep_stages.ruleset.rules", [{"stage": "unknown", "when": []}]),
    ("sleep_stages.ruleset", {}),
    ("sensor_calibration.noise_floor", 0),
])
def test_invalid_overrides_are_rejected(path, value):
    with pytest.raises(ValueError):
        resolve_config([{"path": path, "value": value}])


def test_unknown_fields_and_bases_are_rejected():
    with pytest.raises(ValueError, match="PROFILE_INCOMPATIBLE"):
        resolve_config([], "unknown")
    with pytest.raises(ValueError):
        resolve_config([{"path": "heart_rate.trackingToleranceBpm", "value": 15, "ignored": True}])
    value = manifest()["defaults"]
    value["calibration"] = {}
    with pytest.raises(ValueError):
        validate_config(value)
    with pytest.raises(ValueError, match="Duplicate"):
        resolve_config([{"path": "heart_rate.trackingToleranceBpm", "value": 15}] * 2)


def test_canonical_numeric_json():
    assert canonical_json({"b": -0.0, "a": .5}) == '{"a":0.5,"b":0}'
    assert canonical_json(.1) == "0.1000000000000000055511151231257827021181583404541015625"
    assert config_hash({"a": 1, "b": 2}) == config_hash({"b": 2, "a": 1})
    for bad in [math.inf, math.nan, {1: "key"}, "\ud800", object(), [None] * 20001]:
        with pytest.raises(ValueError):
            canonical_json(bad)
