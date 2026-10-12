"""Event-time cadence, gates and output isolation of the shared processor."""
from collections import namedtuple
from pathlib import Path
from types import SimpleNamespace
import sys

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from common.biometrics.processing import StatefulSideProcessor

Candidate = namedtuple('Candidate', 'side ts heart_rate hrv breathing_rate quality_score flags hr_raw run_context')


def processor(side='left'):
    now = [1000.0]
    output = []
    accepted = [True]

    def write(candidate):
        output.append(candidate)
        return accepted[0]

    core = StatefulSideProcessor(side, clock=lambda: now[0], writer=write,
                                 candidate_factory=Candidate, autocorr_quality=lambda _: 1.0)
    core._estimator.estimate = lambda *args: SimpleNamespace(
        heart_rate=60.0, hrv_index=None, breathing_rate=12.0, hr_raw=60.0, hr_score=0.5)
    samples = np.sin(np.arange(5000) / 500 * 2 * np.pi * 1.2) * 1_000_000
    return core, now, output, accepted, samples


def test_warmup_and_cadence_use_only_explicit_event_time():
    core, now, output, _, samples = processor()
    core.ingest(samples[:-1])
    assert output == []
    core.ingest(samples[-1:])
    assert len(output) == 1
    assert output[0].ts.timestamp() == 1000
    assert output[0].quality_score == 0.775
    assert output[0].flags == ['no_hrv']
    now[0] = 1059.999
    core.ingest(samples)
    assert len(output) == 1
    now[0] = 1060
    core.ingest(samples)
    assert [row.ts.timestamp() for row in output] == [1000, 1060]


def test_failed_sink_preserves_cursor_and_success_starts_new_interval():
    core, now, output, accepted, samples = processor()
    accepted[0] = False
    core.ingest(samples)
    assert core._last_write == 0
    now[0] = 1001
    accepted[0] = True
    core.ingest(samples)
    assert core._last_write == 1001
    now[0] = 1060
    core.ingest(samples)
    assert len(output) == 2
    now[0] = 1061
    core.ingest(samples)
    assert len(output) == 3


def test_historical_empty_bed_context_vetoes_output_and_reset_clears_state():
    core, now, output, _, samples = processor()
    core.bed_occupied = lambda: False
    core.ingest(samples)
    assert not output
    assert core._last_write == now[0]
    core.install_runtime(core.parameters, None, reset_side=True)
    assert len(core._hr_buf) == len(core._br_buf) == len(core._hrv_buf) == 0
    assert core._last_med_std == core._last_acr_qual == core._last_write == 0
    core.bed_occupied = lambda: True
    now[0] += 1
    core.ingest(samples)
    assert len(output) == 1


def test_cross_channel_context_is_post_suppression_and_does_not_submit():
    core, _, output, _, samples = processor()
    other, *_ = processor('right')
    other._last_med_std, other._last_acr_qual = 1_000_000, 1.0
    core._other = other
    core.bed_occupied = lambda: True
    core.ingest(samples / 10)
    assert not output
    assert core._last_acr_qual == 0
    assert core._last_med_std > 0
