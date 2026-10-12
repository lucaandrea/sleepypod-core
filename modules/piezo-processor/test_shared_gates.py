"""Recorded-time gating regressions; run using piezo-processor's locked env."""
from pathlib import Path
import sys

import numpy as np
import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.gates import (
    FrzHealthPumpState, PumpGate, PresenceDetector, PUMP_GUARD_S,
    PUMP_OFF_GUARD_S,
)


def test_pump_off_guard_uses_recorded_time_and_exact_boundary():
    now = [1000.0]
    state = FrzHealthPumpState(clock=lambda: now[0])
    assert not state.is_side_pump_active('left')
    state.update({'type': 'frzHealth', 'left': {'pump': {'rpm': 2000}}})
    assert state.is_asymmetric_for('left')
    state.update({'type': 'frzHealth', 'right': {'pumpDuty': 1}})
    assert state.is_symmetric_active()
    state.update({'type': 'frzHealth', 'left': {'pumpRpm': 0}})
    now[0] += PUMP_OFF_GUARD_S - 0.001
    assert state.is_symmetric_active()
    now[0] += 0.001
    assert not state.is_side_pump_active('left')
    assert state.is_asymmetric_for('right')


def test_energy_guard_replays_without_waiting_or_reading_wall_time():
    now = [0.0]
    gate = PumpGate(clock=lambda: now[0])
    quiet = np.ones(500)
    assert not gate.check(quiet, quiet)
    assert gate.check(quiet * 100, quiet * 100)
    now[0] = PUMP_GUARD_S - 0.001
    assert gate.check(quiet, quiet)
    now[0] = PUMP_GUARD_S
    assert not gate.check(quiet, quiet)
    assert not gate.is_pump_active()


def test_repeated_replay_is_independent_of_clock_origin():
    def replay(origin):
        now = [origin]
        gate = PumpGate(clock=lambda: now[0])
        state = FrzHealthPumpState(clock=lambda: now[0])
        results = []
        for elapsed, energy, rpm in [(0, 1, 0), (1, 100, 2000),
                                     (2, 1, 0), (6, 1, 0), (7, 1, 0)]:
            now[0] = origin + elapsed
            state.update({'type': 'frzHealth', 'left': {'pumpRpm': rpm}})
            samples = np.full(500, energy, dtype=float)
            results.append((gate.check(samples, samples), state.is_side_pump_active('left')))
        return results
    assert replay(0) == replay(1_700_000_000) == [
        (False, False), (True, True), (True, True), (False, True), (False, False)]


def test_presence_reentry_and_three_window_hysteresis_are_shared():
    detector = PresenceDetector()
    assert detector.update(200_000, 0.1, relaxed=True)
    assert detector.update(0, 0)
    assert detector.update(0, 0)
    assert not detector.update(0, 0)
    assert not detector.update(200_000, 0.1)
    assert detector.update(200_000, 0.1, relaxed=True)


def test_shared_pump_gates_require_an_explicit_clock():
    with pytest.raises(TypeError):
        PumpGate()
    with pytest.raises(TypeError):
        FrzHealthPumpState()
