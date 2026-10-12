#!/usr/bin/env python3
"""
SleepyPod piezo-processor module (v2).

Reads raw piezoelectric sensor data from /persistent/*.RAW (CBOR-encoded),
computes heart rate, HRV, and breathing rate, and writes results to biometrics.db.

One row is written to the `vitals` table approximately every 60 seconds per side
while a user is detected on the pod.

Signal processing pipeline (per side):
  1. PumpGate: dual-channel energy spike detection with 5s guard period
     (Shin et al. IEEE TBME 2009) — records arriving during pump activity
     are dropped before entering side buffers
  2. Buffer incoming 500 Hz piezo samples into rolling windows
  3. Presence detection: hysteresis state machine on median std of 1-10 Hz
     filtered signal in 5s sub-windows, with autocorrelation quality as
     secondary feature (Paalasmaa et al. 2012)
  4. Heart rate: 0.8-8.5 Hz SOS bandpass → subharmonic summation
     autocorrelation (Hermes 1988; Bruser et al. 2011) with inter-window
     Gaussian consistency tracking (max 15 BPM delta)
  5. Breathing rate: Hilbert envelope of 0.8-10 Hz cardiac band →
     0.1-0.7 Hz respiratory extraction → peak counting (PMC9354426)
  6. HR variability index: 10s sub-window autocorrelation IBI with 50%
     overlap → harmonic gate → Hampel filter → gap-aware successive
     differences (NOT clinical RMSSD — see #221)
"""

import os
import sys
import json
import time
import signal
import logging
import sqlite3
import threading
from pathlib import Path
from datetime import datetime, timezone
from collections import deque
from dataclasses import dataclass
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import cbor2
from common.nats_follower import create_follower
from common.dialect import KNOWN_RECORD_TYPES, warn_unknown_type_once
from common.side_mode import SingleSleeperMode
from common.bed_presence import BedPresence
import numpy as np
from runtime_adapter import RuntimeCoordinator, RunContext
from common.biometrics.gates import (
    FrzHealthPumpState as _FrzHealthPumpState, PumpGate as _PumpGate,
    PresenceDetector, PUMP_ENERGY_MULTIPLIER, PUMP_CORRELATION_MIN,
    PUMP_GUARD_S, PUMP_ACTIVE_RPM_MIN, PUMP_OFF_GUARD_S,
    PUMP_COUPLING_STD_FACTOR, PUMP_COUPLING_ACR_THRESHOLD,
)
from common.biometrics.signal import (
    _bandpass, _autocorr_quality, _compute_autocorr, subharmonic_summation_hr,
    HRTracker, compute_breathing_rate, compute_hrv,
    ProcessingParameters, DEFAULT_PARAMETERS, WindowEstimator,
)

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

RAW_DATA_DIR = Path(os.environ.get("RAW_DATA_DIR", "/persistent"))
BIOMETRICS_DB = Path(os.environ.get("BIOMETRICS_DATABASE_URL", "file:/persistent/sleepypod-data/biometrics.db").replace("file:", ""))
SLEEPYPOD_DB = Path(os.environ.get("DATABASE_URL", "file:/persistent/sleepypod-data/sleepypod.db").replace("file:", ""))
# The sleep-detector's saved state: its committed per-side presence.
SLEEP_DETECTOR_STATE = Path(os.environ.get(
    "SLEEP_DETECTOR_STATE_PATH", str(BIOMETRICS_DB.parent / "sleep-detector-state.json")))

SAMPLE_RATE = 500          # Hz — piezo sensor sample rate
VITALS_INTERVAL_S = 60     # write a vitals row every N seconds
HR_WINDOW_S = 30           # seconds of data for heart rate calculation
BREATHING_WINDOW_S = 60    # seconds of data for breathing rate calculation
HRV_WINDOW_S = 300         # seconds of data for the window-level HRV index

# HR band: 0.8 Hz preserves fundamental of 48+ BPM; 8.5 Hz per PMC7582983
HR_BAND = (0.8, 8.5)

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [piezo-processor] %(levelname)s %(message)s",
    datefmt="%Y-%m-%dT%H:%M:%S",
)
log = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Shutdown handling
# ---------------------------------------------------------------------------

_shutdown = threading.Event()

def _on_signal(signum, frame):
    log.info("Received signal %d, shutting down...", signum)
    _shutdown.set()

signal.signal(signal.SIGTERM, _on_signal)
signal.signal(signal.SIGINT, _on_signal)

# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

def open_biometrics_db() -> sqlite3.Connection:
    conn = sqlite3.connect(str(BIOMETRICS_DB), timeout=5.0, check_same_thread=False)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA busy_timeout=5000")
    conn.execute("PRAGMA synchronous=NORMAL")
    return conn


# After this many consecutive write failures, discard the connection and
# reopen on the next write attempt (#325).
_DB_RECONNECT_THRESHOLD = 5


class DBHolder:
    """Shared mutable reference to the biometrics connection.

    Both SideProcessor instances point at the same DBHolder so that when one
    side triggers a reconnect, the other automatically observes the new
    connection on its next write. Holding raw sqlite3.Connection refs on each
    processor orphaned the sibling after a reconnect — it kept writing to the
    closed handle (the exact bug sleep-detector's DBHolder docstring warns
    about).

    The consecutive-failure counter lives on the holder, making it
    per-connection: failures observed against a stale handle can no longer
    discard a healthy replacement.
    """
    __slots__ = ("conn", "write_failures")

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn
        self.write_failures = 0


def _reconnect_db(holder: "DBHolder") -> None:
    """Open a fresh connection, swap into *holder*, then close the old one.
    Open-first-then-swap means an open failure leaves the live handle in
    place; the close happens after the swap so writers always see a valid
    handle. Never raises."""
    old = holder.conn
    try:
        new = open_biometrics_db()
    except sqlite3.Error as e:
        log.error("Failed to reopen biometrics DB: %s", e)
        return
    holder.conn = new
    log.info("Reopened biometrics DB connection after write failures")
    try:
        old.close()
    except sqlite3.Error:
        pass


def write_vitals(holder: "DBHolder", side: str, ts: datetime,
                 heart_rate: Optional[float], hrv: Optional[float],
                 breathing_rate: Optional[float],
                 quality_score: float,
                 flags: Optional[list] = None,
                 hr_raw: Optional[float] = None,
                 run_context: Optional[RunContext] = None) -> bool:
    """Insert one vitals row + paired vitals_quality row. Logs and swallows
    sqlite3 errors so the main loop survives transient WAL/disk issues (#325).
    After _DB_RECONNECT_THRESHOLD consecutive failures, the holder's
    connection is replaced in place.

    Returns True only when both inserts committed so callers don't advance
    their downsample cursor on a failed write.
    """
    conn = holder.conn
    ts_unix = int(ts.timestamp())
    now_unix = int(time.time())
    flags_json = json.dumps(flags) if flags else None
    try:
        with conn:
            if run_context is not None:
                # Keep the profile and source channel that computed the value,
                # even if single-sleeper mode changed while this row was held.
                if side != run_context.side:
                    raise sqlite3.IntegrityError("Vitals routing disagrees with processing provenance")
                run_context.ensure(conn)
                cur = conn.execute(
                    "INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate, processing_run_id) VALUES (?, ?, ?, ?, ?, ?)",
                    (side, ts_unix, heart_rate, hrv, breathing_rate, run_context.id),
                )
            else:
                cur = conn.execute(
                    "INSERT INTO vitals (side, timestamp, heart_rate, hrv, breathing_rate) VALUES (?, ?, ?, ?, ?)",
                    (side, ts_unix, heart_rate, hrv, breathing_rate),
                )
            conn.execute(
                "INSERT INTO vitals_quality (vitals_id, side, timestamp, quality_score, flags, hr_raw, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (cur.lastrowid, side, ts_unix, quality_score, flags_json, hr_raw, now_unix),
            )
        holder.write_failures = 0
        return True
    except sqlite3.Error as e:
        holder.write_failures += 1
        log.warning("write_vitals failed (%d consecutive): %s",
                    holder.write_failures, e)
        if holder.write_failures >= _DB_RECONNECT_THRESHOLD:
            _reconnect_db(holder)
            holder.write_failures = 0
        return False


@dataclass
class VitalsCandidate:
    """One side's computed vitals for one VITALS_INTERVAL_S cycle."""
    side: str
    ts: datetime
    heart_rate: Optional[float]
    hrv: Optional[float]
    breathing_rate: Optional[float]
    quality_score: float
    flags: Optional[list]
    hr_raw: Optional[float]
    run_context: Optional[RunContext] = None

    def write(self, holder: "DBHolder", side: Optional[str] = None) -> bool:
        # Provenance captures the logical side at computation, not at retry.
        destination = self.run_context.side if self.run_context else side or self.side
        kwargs = {"run_context": self.run_context} if self.run_context else {}
        return write_vitals(holder, destination, self.ts, self.heart_rate,
                            self.hrv, self.breathing_rate,
                            quality_score=self.quality_score, flags=self.flags,
                            hr_raw=self.hr_raw, **kwargs)


class SingleSleeperVitals:
    """Routes vitals rows when one side is in away mode (single sleeper).

    A solo sleeper who rolls onto the away side is picked up by that side's
    piezo too — the same heartbeat, within a few bpm. Each cycle's
    candidates from the two sides are paired and
    only the higher-quality one is written, under the home side, so the
    home session shows one heart-rate series with no gaps or duplicates.
    A candidate whose partner doesn't arrive within VITALS_INTERVAL_S (the
    other side saw no one) is written alone under the home side.

    Outside single-sleeper mode rows are written under their own side.
    """

    def __init__(self, holder: "DBHolder", mode: SingleSleeperMode,
                 clock: Callable[[], float] = time.monotonic):
        self._holder = holder
        self._mode = mode
        self._clock = clock
        self._pending: Optional[VitalsCandidate] = None
        self._retry: Optional[VitalsCandidate] = None
        self._retry_home: Optional[str] = None
        self._pending_home: Optional[str] = None
        self._pending_at = 0.0

    def submit(self, cand: VitalsCandidate) -> bool:
        """Accept one side's candidate. True means the side may advance its
        write cursor: the row was written, or is held (for pairing or a
        write retry). A held candidate is only dropped once written."""
        # Completed intervals must never pair with a later candidate.
        if self._retry is not None and not self.flush():
            return False
        home = self._mode.home_side()
        if not self._mode.active_sides():
            self._pending = self._retry = None
            return True
        if home is None:
            if not self.flush():
                return False
            return cand.write(self._holder)
        pending = self._pending
        if pending is not None and pending.side != cand.side and self._pending_home == home:
            best = cand if cand.quality_score > pending.quality_score else pending
            self._pending = best
            self.flush()
            return True
        # A same-side repeat means its partner never arrived: write the
        # older one first. If that fails, refuse the new candidate so its
        # side keeps it and resubmits, rather than dropping the older row.
        if not self.flush():
            return False
        self._pending, self._pending_home, self._pending_at = cand, home, self._clock()
        return True

    def tick(self) -> None:
        """Write a held candidate whose partner didn't arrive in time."""
        if not self._mode.active_sides():
            self._pending = self._retry = None
            return
        held = self._pending is not None or self._retry is not None
        if held and self._clock() - self._pending_at >= VITALS_INTERVAL_S:
            self.flush()

    def flush(self) -> bool:
        """Write the held candidate, if any. On failure it stays held and
        idle retries wait VITALS_INTERVAL_S; a new submission retries first.
        True when nothing is left held."""
        if self._retry is None:
            self._retry, self._retry_home = self._pending, self._pending_home
            self._pending = None
        if self._retry is None:
            return True
        if self._retry.write(self._holder, side=self._retry_home):
            self._retry = None
            return True
        self._pending_at = self._clock()
        return False


def report_health(status: str, message: str) -> None:
    """Write module health to sleepypod.db system_health table."""
    try:
        conn = sqlite3.connect(str(SLEEPYPOD_DB), timeout=2.0)
        try:
            with conn:
                conn.execute(
                    """INSERT INTO system_health (component, status, message, last_checked)
                       VALUES ('piezo-processor', ?, ?, ?)
                       ON CONFLICT(component) DO UPDATE SET
                         status=excluded.status,
                         message=excluded.message,
                         last_checked=excluded.last_checked""",
                    (status, message, int(time.time())),
                )
        finally:
            conn.close()
    except Exception as e:
        log.warning("Could not write health status: %s", e)

# ---------------------------------------------------------------------------
# Pump gating — streaming adaptation (Shin et al. IEEE TBME 2009)
# ---------------------------------------------------------------------------

class FrzHealthPumpState(_FrzHealthPumpState):
    """Live adapter; replay imports the shared gate with its event clock."""
    def __init__(self, *, clock=None):
        super().__init__(clock=clock if clock is not None else lambda: time.monotonic())


class PumpGate(_PumpGate):
    """Live adapter retaining the historical no-argument constructor."""
    def __init__(self, fs: float = SAMPLE_RATE, *, clock=None):
        super().__init__(fs, clock=clock if clock is not None else lambda: time.monotonic())


# ---------------------------------------------------------------------------
# Per-side processor
# ---------------------------------------------------------------------------

class SideProcessor:
    def __init__(self, side: str, db_holder: DBHolder,
                 pump_state: Optional[FrzHealthPumpState] = None,
                 parameters: ProcessingParameters = DEFAULT_PARAMETERS):
        self.side = side
        self.db_holder = db_holder
        self._hr_buf: deque = deque(maxlen=HR_WINDOW_S * SAMPLE_RATE)
        self._hrv_buf: deque = deque(maxlen=HRV_WINDOW_S * SAMPLE_RATE)
        self._br_buf: deque = deque(maxlen=BREATHING_WINDOW_S * SAMPLE_RATE)
        self._last_write = 0.0
        self._presence = PresenceDetector()
        self.parameters = parameters
        self.run_context: Optional[RunContext] = None
        self._estimator = WindowEstimator(parameters)
        self._hr_tracker = self._estimator.hr_tracker
        self._other: Optional['SideProcessor'] = None  # set after both sides created
        self._last_med_std: float = 0.0  # cached for cross-channel comparison
        self._last_acr_qual: float = 0.0
        self._pump_state = pump_state
        # Where computed vitals go; None writes them under this side.
        # main() routes both sides through SingleSleeperVitals.submit.
        self.sink: Optional[Callable[[VitalsCandidate], bool]] = None
        # The bed's own answer to "is anyone here" (sleep-detector presence):
        # False vetoes piezo presence, None (unknown) leaves it alone.
        self.bed_occupied: Optional[Callable[[], Optional[bool]]] = None
        # Single-sleeper home side (None in per-side mode). The sleep-detector
        # merges both zones into the home side, so only the home side's
        # processor may treat `bed_occupied() is True` as its own evidence.
        self.home_side: Optional[Callable[[], Optional[str]]] = None

    def install_runtime(self, parameters, run_context, reset_side=False):
        if parameters != self.parameters or reset_side:
            self._hr_buf.clear()
            self._hrv_buf.clear()
            self._br_buf.clear()
            self._estimator = WindowEstimator(parameters)
            self._hr_tracker = self._estimator.hr_tracker
            self._last_write = 0.0
            self._last_med_std = self._last_acr_qual = 0.0
            self._presence = PresenceDetector()
        self.parameters = parameters
        self.run_context = run_context

    def ingest(self, samples: np.ndarray) -> None:
        self._hr_buf.extend(samples)
        self._hrv_buf.extend(samples)
        self._br_buf.extend(samples)
        self._maybe_write()

    def _maybe_write(self) -> None:
        now = time.time()
        if now - self._last_write < VITALS_INTERVAL_S:
            return

        hr_arr = np.array(self._hr_buf)
        if len(hr_arr) < int(10 * SAMPLE_RATE):
            return  # Not enough data yet

        # --- Presence detection (hysteresis + autocorrelation quality) ---
        filt = _bandpass(hr_arr, 1.0, 10.0, SAMPLE_RATE)
        w = int(5 * SAMPLE_RATE)
        stds = [np.std(filt[j:j + w])
                for j in range(0, len(filt) - w + 1, w)]
        med_std = float(np.median(stds)) if stds else 0.0
        acr_qual = _autocorr_quality(hr_arr)
        cross_channel_rejected = False

        # Cross-channel rejection: if the other side has stronger or similar
        # signal AND strong autocorrelation (someone is actually there), this
        # side's signal is likely vibration coupling, not a person.
        # A real person produces ~3-5x stronger signal on their side.
        #
        # Note: due to sequential processing in main() (left before right),
        # left sees right's values from the previous cycle (~60s stale).
        # This is acceptable — coupling produces similar energy regardless
        # of which side checks first.
        if self._other is not None and self._other._last_med_std > 0:
            other_std = self._other._last_med_std
            other_acr = self._other._last_acr_qual
            # Only suppress if: other side has real periodicity (someone there),
            # other side's energy is >= ours, and our energy is below threshold
            if (other_acr > 0.3
                    and other_std > med_std * 0.7
                    and med_std < self._presence.enter_threshold):
                acr_qual = 0.0
                cross_channel_rejected = True

        # Cache AFTER suppression so the other side sees post-suppression values
        self._last_med_std = med_std
        self._last_acr_qual = acr_qual

        # The bed's own answer to "is anyone here" (sleep-detector capacitance
        # presence), read once per cycle: True relaxes re-entry below, False
        # vetoes piezo presence, None (unknown) leaves the piezo alone.
        bed = self.bed_occupied() if self.bed_occupied is not None else None
        # Only occupancy measured on this side may relax the piezo. With one
        # side away the reading is merged under the home side, so the away
        # side inherits a True it cannot attribute to its own zone and keeps
        # the strict path. A side whose energy cross-channel rejection has
        # already attributed to the other sleeper keeps it too.
        own_side = self.home_side is None or self.home_side() in (None, self.side)
        relaxed = bed is True and own_side and not cross_channel_rejected

        # Pump-coupling guard. PumpGate handles symmetric spikes (ramps)
        # but misses two steady-state modes: asymmetric (own-pump-on with
        # opposite idle — vibration couples into same-side piezo, no
        # competing signal for cross-channel rejection) and symmetric
        # (both pumps on at mismatched RPMs — beat frequency lands in the
        # cardiac band, both sides look "real"). In both, require elevated
        # energy AND strong autocorrelation to enter PRESENT; coupling
        # rarely produces both, only a real person does.
        #
        # The guard answers "is this vibration a person or the pump". When
        # the capacitance sensor says a person is in bed on this side and
        # the energy is not the other sleeper's, that question is settled;
        # on Pod 5 both pumps run all night, so without this bypass a
        # sleeper who drifted to a weak-signal position stayed ABSENT for
        # an hour at a time (05:57-07:01 on 2026-10-11) until a hard
        # movement cleared the raised bar.
        if (self._pump_state is not None and not relaxed
                and self._presence.state == PresenceDetector.ABSENT):
            symmetric = self._pump_state.is_symmetric_active()
            asymmetric = self._pump_state.is_asymmetric_for(self.side)
            if symmetric or asymmetric:
                std_threshold = self._presence.enter_threshold * PUMP_COUPLING_STD_FACTOR
                if not (med_std > std_threshold and acr_qual > PUMP_COUPLING_ACR_THRESHOLD):
                    log.debug(
                        "%s: pump-coupling guard suppressed presence "
                        "(med_std=%.0f, acr=%.2f, mode=%s)",
                        self.side, med_std, acr_qual,
                        "symmetric" if symmetric else "asymmetric",
                    )
                    return

        if relaxed and self._presence.state == PresenceDetector.ABSENT:
            log.debug("%s: bed reads occupied, relaxed piezo re-entry (med_std=%.0f, acr=%.2f)",
                      self.side, med_std, acr_qual)
        if cross_channel_rejected:
            # The other side owns this energy. Zeroing acr alone cannot end
            # presence (exit needs weak energy too), so count the window as
            # weak and let the normal hysteresis exit instead of latching,
            # and never submit vitals computed from it meanwhile.
            self._presence.update(0.0, 0.0)
            present = False
        else:
            present = self._presence.update(med_std, acr_qual, relaxed=relaxed)
        # Piezo presence is vibration energy and rhythm; a prime or the pump
        # shaking an empty bed passes it. Trust the capacitance-based
        # presence when the sleep-detector says nobody is there.
        if present and bed is False:
            present = False

        if not present:
            # Reset the interval cursor so a return from extended absence
            # doesn't trigger burst processing on every ingest until the
            # first write completes (#325).
            self._last_write = now
            return  # No user detected — skip

        # Shared numerical estimator. Gating and live sinks remain in this adapter.
        estimate = self._estimator.estimate(now, hr_arr, np.array(self._br_buf),
                                             np.array(self._hrv_buf))
        hr, hrv, br = estimate.heart_rate, estimate.hrv_index, estimate.breathing_rate
        hr_raw, hr_score = estimate.hr_raw, estimate.hr_score

        if hr is not None or hrv is not None or br is not None:
            ts = datetime.now(timezone.utc)
            snr = max(0.0, min(1.0, acr_qual))
            hr_conf = max(0.0, min(1.0, hr_score)) if hr is not None else 0.0
            quality = round(0.55 * snr + 0.45 * hr_conf, 3)
            flags = []
            if hr is None:
                flags.append("no_hr")
            if hrv is None:
                flags.append("no_hrv")
            if br is None:
                flags.append("no_br")
            if med_std < self._presence.enter_threshold:
                flags.append("low_signal")
            cand = VitalsCandidate(self.side, ts, hr, hrv, br, quality, flags or None, hr_raw, self.run_context)
            wrote = self.sink(cand) if self.sink is not None else cand.write(self.db_holder)
            log.info("vitals %s — HR=%.1f HRV=%.1f BR=%.1f q=%.2f", self.side,
                     hr or 0, hrv or 0, br or 0, quality)
            # Only advance the downsample cursor when the write actually
            # committed — otherwise a transient sqlite error would skip
            # VITALS_INTERVAL_S of valid samples.
            if wrote:
                self._last_write = now
        else:
            # No metric to write — advance so we don't recompute on every ingest.
            self._last_write = now

# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

# frankenfirmware writes INT32_MAX in place of a sample it lost ("[sensor]
# sample lost" in its log): one sample, on all four piezo channels at once,
# in a few percent of records. Taken as data it is a spike ~450x any real
# signal: the pump gate drops the record (and 5 s after it), and the beat
# tracker restarts.
LOST_SAMPLE = np.iinfo(np.int32).max


def _int32_samples(buf) -> np.ndarray:
    """Decode an int32 sample buffer, tolerating truncated tails and
    repairing lost-sample markers.

    A RAW record cut mid-write can carry a payload whose length is not a
    multiple of 4; np.frombuffer would raise ValueError and kill the module.
    Truncate to whole samples instead. A LOST_SAMPLE marker is replaced by
    linear interpolation between its neighbours (the nearest valid sample at
    a record edge); a record with no valid sample decodes as empty.
    """
    if not isinstance(buf, (bytes, bytearray, memoryview)):
        return np.empty(0, dtype=np.int32)
    usable = len(buf) - (len(buf) % 4)
    if usable == 0:
        return np.empty(0, dtype=np.int32)
    samples = np.frombuffer(buf[:usable], dtype=np.int32)
    lost = samples == LOST_SAMPLE
    if not lost.any():
        return samples
    if lost.all():
        return np.empty(0, dtype=np.int32)
    idx = np.arange(samples.size)
    repaired = samples.astype(np.float64)
    repaired[lost] = np.interp(idx[lost], idx[~lost], repaired[~lost])
    return np.round(repaired).astype(np.int32)


def main() -> None:
    log.info("Starting piezo-processor v2 (biometrics.db=%s)", BIOMETRICS_DB)

    if not BIOMETRICS_DB.parent.exists():
        log.error("Biometrics DB directory does not exist: %s", BIOMETRICS_DB.parent)
        sys.exit(1)

    db_holder = DBHolder(open_biometrics_db())
    pump_gate = PumpGate()
    pump_state = FrzHealthPumpState()
    left = SideProcessor("left", db_holder, pump_state=pump_state)
    right = SideProcessor("right", db_holder, pump_state=pump_state)
    left._other = right
    right._other = left
    # One side in away mode: a single sleeper — the away side's readings
    # (rolled over, leg across) are merged into the home side's series.
    bed_mode = SingleSleeperMode(SLEEPYPOD_DB)
    vitals_router = SingleSleeperVitals(db_holder, bed_mode)
    left.sink = right.sink = vitals_router.submit
    # Vitals only while the bed reads occupied — on the side they're stored
    # under, which is the home side with one side away.
    bed = BedPresence(SLEEP_DETECTOR_STATE)
    left.bed_occupied = lambda: bed.occupied(bed_mode.home_side() or "left")
    right.bed_occupied = lambda: bed.occupied(bed_mode.home_side() or "right")
    left.home_side = right.home_side = bed_mode.home_side
    runtime = RuntimeCoordinator(db_holder, {"left": left, "right": right})
    runtime_problem = None
    # Source selected once at startup: NatsFollower on new-firmware pods (NATS
    # reachable), else the unchanged .RAW tailer. Same decoded-record contract.
    follower = create_follower(RAW_DATA_DIR, _shutdown, poll_interval=0.01)

    report_health("healthy", "piezo-processor v2 started")

    try:
        for record in follower.read_records(on_poll=vitals_router.tick):
            rtype = record.get("type")

            # Surface genuinely-new firmware types once (blanketReadings, log,
            # …) instead of dropping them silently; known types this module
            # doesn't consume fall through to the checks below.
            if not isinstance(rtype, str):
                continue
            if rtype not in KNOWN_RECORD_TYPES:
                warn_unknown_type_once(record, "piezo-processor")
                continue

            # Track per-side pump state for the asymmetric pump-coupling guard
            if rtype == "frzHealth":
                pump_state.update(record)
                continue

            if rtype != "piezo-dual":
                continue

            # Each record contains ~500 int32 samples per channel
            l_samples = _int32_samples(record.get("left1", b""))
            r_samples = _int32_samples(record.get("right1", b""))

            if l_samples.size == 0 or r_samples.size == 0:
                continue

            # Pump gating — drop entire record if pump detected or guard active
            if pump_gate.check(l_samples, r_samples):
                continue

            frame_time_ms = int(time.time() * 1000)
            runtime.before_frame(bed_mode.home_side(), bed.occupied, frame_time_ms)
            left.ingest(l_samples)
            right.ingest(r_samples)
            runtime.after_frame(frame_time_ms)
            if runtime.problem != runtime_problem:
                runtime_problem = runtime.problem
                report_health("degraded" if runtime_problem else "healthy",
                              "Biometric configuration fallback: " + runtime_problem if runtime_problem
                              else "Biometric runtime configuration available")

    except Exception as e:
        log.exception("Fatal error in main loop: %s", e)
        report_health("down", str(e))
        sys.exit(1)
    finally:
        vitals_router.flush()
        db_holder.conn.close()
        log.info("Shutdown complete")

    # Only reached on clean shutdown (not via sys.exit)
    report_health("down", "piezo-processor stopped")


if __name__ == "__main__":
    main()
