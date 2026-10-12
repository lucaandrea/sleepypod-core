"""Shared stateful pump and presence gates for live and waveform replay.

No hardware, filesystem, database, or wall-clock reads. Pump clocks are supplied
by the caller: monotonic time live, recorded event time during replay. Preserve
record ordering and the same clock domain throughout a processor lifetime.
"""
import logging
from typing import Callable, Optional

import numpy as np

log = logging.getLogger(__name__)

# Pump gating
PUMP_ENERGY_MULTIPLIER = 10.0
PUMP_CORRELATION_MIN = 0.5
PUMP_GUARD_S = 5.0

# Per-side pump activity threshold (frzHealth pump RPM). PumpGate catches
# broadband-symmetric energy spikes but misses two steady-state coupling
# modes: asymmetric (one pump on, observed 2026-05-02 Pod 3 — pump@2000RPM
# on right with left idle drove phantom HR/HRV/BR) and symmetric (both
# pumps on, observed 2026-05-05 Pod 5 — 1940/2004 rpm beat at 64/min lands
# in the cardiac band). Both are caught by the guard below.
PUMP_ACTIVE_RPM_MIN = 50          # pump considered "running" above this
PUMP_OFF_GUARD_S = 5.0            # trailing guard after own-side pump-off
PUMP_COUPLING_STD_FACTOR = 4.0    # raise enter_threshold by this factor
PUMP_COUPLING_ACR_THRESHOLD = 0.6 # require strong autocorr to enter

class FrzHealthPumpState:
    """Tracks per-side pump RPM from frzHealth records.

    Used by SideProcessor to suppress phantom presence detection when
    only the same side's pump is running (asymmetric pump-coupling
    artifact). Trailing guard period mirrors the post-pump-off ringing
    in the piezo channel.
    """

    def __init__(self, *, clock: Callable[[], float]):
        self._clock = clock
        self._pump_rpm = {"left": 0.0, "right": 0.0}
        # monotonic seconds when each side's pump last turned off; -inf =
        # never (0.0 would falsely assert the guard for the first
        # PUMP_OFF_GUARD_S when self._clock() has a near-zero origin)
        self._pump_off_at = {"left": float("-inf"), "right": float("-inf")}
        self._was_active = {"left": False, "right": False}

    def update(self, record: dict) -> None:
        if record.get("type") != "frzHealth":
            return
        for side in ("left", "right"):
            data = record.get(side)
            if not isinstance(data, dict):
                continue
            rpm = 0.0
            for key in ("pumpRpm", "pump_rpm", "pumpRPM", "rpm"):
                val = data.get(key)
                if val is not None:
                    try:
                        rpm = float(val)
                    except (TypeError, ValueError):
                        rpm = 0.0
                    break
            # New NATS firmware nests the same reading at side.pump.rpm.
            pump = data.get("pump")
            if rpm == 0 and isinstance(pump, dict):
                val = pump.get("rpm")
                if val is not None:
                    try:
                        rpm = float(val)
                    except (TypeError, ValueError):
                        rpm = 0.0
            if rpm == 0:
                duty = next((data.get(key) for key in
                             ("pumpDuty", "pump_duty", "duty")
                             if data.get(key) is not None), None)
                if duty is None and isinstance(pump, dict):
                    duty = next((pump.get(key) for key in ("duty", "power")
                                 if pump.get(key) is not None), None)
                if duty is not None:
                    try:
                        rpm = PUMP_ACTIVE_RPM_MIN + 1.0 if float(duty) > 0 else 0.0
                    except (TypeError, ValueError):
                        rpm = 0.0

            now_active = rpm >= PUMP_ACTIVE_RPM_MIN
            if self._was_active[side] and not now_active:
                self._pump_off_at[side] = self._clock()
            self._pump_rpm[side] = rpm
            self._was_active[side] = now_active

    def is_side_pump_active(self, side: str) -> bool:
        """Pump active = currently running OR within the trailing guard window."""
        if self._pump_rpm[side] >= PUMP_ACTIVE_RPM_MIN:
            return True
        return self._clock() - self._pump_off_at[side] < PUMP_OFF_GUARD_S

    def is_asymmetric_for(self, side: str) -> bool:
        """Own pump active, opposite pump idle (and outside its own guard).
        This is the configuration that produces phantom presence: pump
        vibration on the powered side without competing signal on the
        other side to balance/reject."""
        other = "right" if side == "left" else "left"
        return self.is_side_pump_active(side) and not self.is_side_pump_active(other)

    def is_symmetric_active(self) -> bool:
        """Both pumps active. RPM mismatch (Pod 5 live: 1940/2004) produces
        a beat frequency in the cardiac band, generating bilateral phantom
        vitals. PumpGate catches symmetric spikes but not steady-state."""
        return self.is_side_pump_active("left") and self.is_side_pump_active("right")


class PumpGate:
    """Detects pump activity from dual-channel energy spikes.

    In streaming mode, each incoming record's L+R chunks are checked.
    If a pump is detected, a guard period is set during which all
    subsequent records are dropped (not ingested into side buffers).
    """

    def __init__(self, fs: float = 500, *, clock: Callable[[], float]):
        self._clock = clock
        self._fs = fs
        self._baseline: Optional[float] = None
        self._pump_until: float = 0.0  # monotonic seconds when guard expires

    def is_pump_active(self) -> bool:
        return self._clock() < self._pump_until

    def check(self, left_chunk: np.ndarray, right_chunk: np.ndarray) -> bool:
        """Check a single record's L+R chunks for pump activity.

        Returns True if the record should be DROPPED (pump detected or
        guard period active), False if the record is clean.
        """
        # If we're still in the guard period, drop
        if self.is_pump_active():
            return True

        # Compute energy for both channels
        le = float(np.mean(left_chunk.astype(np.float64) ** 2))
        re = float(np.mean(right_chunk.astype(np.float64) ** 2))

        if le == 0 or re == 0:
            return False

        ratio = min(le, re) / max(le, re)

        if self._baseline is not None and self._baseline > 0:
            spike = max(le, re) / self._baseline
            if ratio > PUMP_CORRELATION_MIN and spike > PUMP_ENERGY_MULTIPLIER:
                # Pump detected — set guard period
                self._pump_until = self._clock() + PUMP_GUARD_S
                log.debug("Pump detected (spike=%.1f, ratio=%.2f), "
                          "guard until +%.0fs", spike, ratio, PUMP_GUARD_S)
                return True

        # Update baseline with exponential moving average (only on clean data).
        # Guard: if first record has unusually high energy (module started during
        # pump), don't initialize baseline from it — wait for a quieter sample.
        avg = (le + re) / 2
        if self._baseline is None:
            self._baseline = avg
            self._baseline_samples = 1
        elif avg < self._baseline * 3:
            self._baseline = 0.95 * self._baseline + 0.05 * avg
            self._baseline_samples = getattr(self, '_baseline_samples', 0) + 1
            # If early samples are settling, allow baseline to drop faster
            if self._baseline_samples < 10:
                self._baseline = min(self._baseline, avg)

        return False

# ---------------------------------------------------------------------------
# Presence detection — hysteresis state machine (Paalasmaa et al. 2012)
# ---------------------------------------------------------------------------

class PresenceDetector:
    """Hysteresis-based presence detection with autocorrelation quality.

    Uses median std of 1-10 Hz filtered signal in 5-second windows as
    the primary feature, with autocorrelation quality as secondary.
    Requires 3 consecutive low windows to exit PRESENT state.

    The enter/exit gap protects against an empty bed that vibrates (pump,
    prime). When the capacitance sensor already confirms a body is in bed
    (`relaxed=True`), that protection costs an hour of missed vitals per
    night: a sleeper who rolls into a weak-signal position exits after three
    windows and then has to move hard to re-enter. Relaxed re-entry uses the
    exit criteria, so presence resumes as soon as the signal stops being weak.
    """
    ABSENT = 0
    PRESENT = 1

    def __init__(self):
        self.state = self.ABSENT
        self.consecutive_low = 0
        self.enter_threshold = 400_000
        self.exit_threshold = 150_000
        self.exit_count = 3       # 3 consecutive low windows to declare absent
        self.acr_threshold = 0.45

    def _is_weak(self, window_std: float, acr_qual: float) -> bool:
        return window_std < self.exit_threshold and acr_qual < self.acr_threshold * 0.5

    def update(self, window_std: float, acr_qual: float, relaxed: bool = False) -> bool:
        """Update state and return True if user is present.

        `relaxed`: the bed is known occupied by another sensor; re-enter on
        anything that would not count as an exit window."""
        if self.state == self.ABSENT:
            if relaxed:
                entered = not self._is_weak(window_std, acr_qual)
            else:
                entered = window_std > self.enter_threshold or acr_qual > self.acr_threshold
            if entered:
                self.state = self.PRESENT
                self.consecutive_low = 0
                return True
            return False
        else:
            if self._is_weak(window_std, acr_qual):
                self.consecutive_low += 1
                if self.consecutive_low >= self.exit_count:
                    self.state = self.ABSENT
                    self.consecutive_low = 0
                    return False
                return True  # still present (hysteresis)
            else:
                self.consecutive_low = 0
                return True

