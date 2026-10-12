"""Routing parity with an experiment-only sink and recorded mode/time."""
from dataclasses import dataclass

from common.biometrics.routing import SingleSleeperRouter


@dataclass(frozen=True)
class Reading:
    side: str
    quality_score: float
    sequence: int


class Mode:
    home = 'left'
    active = ('left',)

    def home_side(self):
        return self.home

    def active_sides(self):
        return self.active


def setup_router():
    now = [0.0]
    mode = Mode()
    output = []
    accepted = [True]

    def write(candidate, destination):
        if not accepted[0]:
            return False
        output.append((candidate, destination))
        return True

    router = SingleSleeperRouter(mode, write, clock=lambda: now[0])
    return router, now, mode, output, accepted


def test_pairing_prefers_quality_and_preserves_first_candidate_on_ties():
    router, _, _, output, _ = setup_router()
    left, right = Reading('left', 0.3, 1), Reading('right', 0.8, 1)
    assert router.submit(left)
    assert not output
    assert router.submit(right)
    assert output == [(right, 'left')]
    tied_left, tied_right = Reading('left', 0.8, 2), Reading('right', 0.8, 2)
    assert router.submit(tied_left)
    assert router.submit(tied_right)
    assert output[-1] == (tied_left, 'left')


def test_recorded_clock_expires_unpaired_reading_at_exact_cadence():
    router, now, _, output, _ = setup_router()
    reading = Reading('right', 0.8, 1)
    assert router.submit(reading)
    now[0] = 59.999
    router.tick()
    assert not output
    now[0] = 60.0
    router.tick()
    assert output == [(reading, 'left')]
    router.tick()
    assert len(output) == 1


def test_failed_pair_cannot_be_overwritten_or_relabelled_after_mode_change():
    router, _, mode, output, accepted = setup_router()
    winner = Reading('right', 0.8, 1)
    router.submit(Reading('left', 0.3, 1))
    accepted[0] = False
    assert router.submit(winner)
    mode.home, mode.active = 'right', ('right',)
    later = Reading('left', 0.9, 2)
    assert not router.submit(later)
    assert not output
    accepted[0] = True
    assert router.submit(later)
    assert output == [(winner, 'left')]
    assert router.flush()
    assert output[-1] == (later, 'right')


def test_two_sleepers_and_empty_bed_use_recorded_mode_only():
    router, now, mode, output, _ = setup_router()
    router.submit(Reading('left', 0.5, 1))
    mode.active = ()
    now[0] = 60
    router.tick()
    assert router.flush()
    assert not output
    mode.home, mode.active = None, ('left', 'right')
    reading = Reading('right', 0.4, 2)
    assert router.submit(reading)
    assert output == [(reading, None)]
