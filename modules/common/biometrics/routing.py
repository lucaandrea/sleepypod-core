"""Single-sleeper arbitration shared by live processing and replay.

The caller supplies recorded/current mode, clock, and output sink. Candidates
are opaque except for physical side and quality. This module cannot read
current occupancy, query a database, or select a canonical output destination.
"""
from typing import Callable, Generic, Optional, Protocol, Sequence, TypeVar

VITALS_INTERVAL_S = 60


class Candidate(Protocol):
    side: str
    quality_score: float


class SleeperMode(Protocol):
    def home_side(self) -> Optional[str]: ...
    def active_sides(self) -> Sequence[str]: ...


CandidateT = TypeVar("CandidateT", bound=Candidate)


class SingleSleeperRouter(Generic[CandidateT]):
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

    def __init__(self, mode: SleeperMode, writer: Callable[[CandidateT, Optional[str]], bool],
                 *, clock: Callable[[], float]):
        self._writer = writer
        self._mode = mode
        self._clock = clock
        self._pending: Optional[CandidateT] = None
        self._retry: Optional[CandidateT] = None
        self._retry_home: Optional[str] = None
        self._pending_home: Optional[str] = None
        self._pending_at = 0.0

    def submit(self, cand: CandidateT) -> bool:
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
            return self._writer(cand, None)
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
        if self._writer(self._retry, self._retry_home):
            self._retry = None
            return True
        self._pending_at = self._clock()
        return False

