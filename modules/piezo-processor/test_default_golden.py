"""Pre-refactor baseline captured from dev 3e9027ed with the locked environment.

A synthetic fixture establishes deterministic numerical parity, not clinical
accuracy. Existing artifact/presence/pump fixtures cover gating separately.
"""
import json
from pathlib import Path

import numpy as np
import pytest

from main import HRTracker, compute_breathing_rate, compute_hrv, subharmonic_summation_hr


def test_default_processing_golden():
    fixture = json.loads(Path(__file__).with_name("fixtures").joinpath("default-processing-v1.json").read_text())
    fs = fixture["sampleRateHz"]
    t = np.arange(fs * 300) / fs
    rng = np.random.default_rng(fixture["seed"])
    phase = 2 * np.pi * (1.1 * t + .2 * np.sin(2 * np.pi * t / 40))
    samples = ((1 + .2 * np.sin(2 * np.pi * .25 * t))
               * (np.sin(phase) + .5 * np.sin(2 * phase) + .25 * np.sin(3 * phase))
               + rng.normal(0, .08, len(t)))
    assert subharmonic_summation_hr(samples[-30 * fs:]) == pytest.approx(fixture["hr"], abs=1e-9)
    assert compute_breathing_rate(samples[-60 * fs:]) == pytest.approx(fixture["breathing"], abs=1e-9)
    assert compute_hrv(samples) == pytest.approx(fixture["hrvIndex"], abs=1e-9)
    tracker = HRTracker()
    actual = [tracker.update(hr, 1.0) for hr in [60, 61, 120, 62, 130, 65, 100, 100, 100, 101, None, 50]]
    assert actual == fixture["tracker"]
