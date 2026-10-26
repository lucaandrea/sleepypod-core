"""Fresh, ordered firmware time for the live estimator, never for replay."""
import math
import time

FIRMWARE_TIMESTAMP_BASIS = "firmware_event_time_v1"
MAX_SOURCE_AGE_S = 10.0
MAX_FRAME_GAP_S = 1.5  # piezo-dual carries one second of samples per frame


class LiveFrameClock:
    """Reject backlog and clock errors; mark gaps so rolling buffers restart.

    An accepted timestamp is the firmware frame's time, not its arrival time.
    The watermark survives rejected frames so a duplicate cannot become fresh
    on the next attempt. A disconnected stream must warm up again on recovery.
    """
    def __init__(self, wall=time.time, monotonic=time.monotonic):
        self.wall = wall
        self.monotonic = monotonic
        self.timestamp = None
        self.last_arrival = None
        self.discontinuous = True
        self.problem = None
        self._broken = True

    def __call__(self):
        if self.timestamp is None:
            raise RuntimeError("No accepted live firmware timestamp")
        return self.timestamp

    def break_continuity(self):
        self._broken = True

    def admit(self, timestamp):
        now, arrival = self.wall(), self.monotonic()
        reason = None
        if (type(timestamp) not in (int, float) or not 0 < timestamp <= 253_402_300_799
                or not math.isfinite(timestamp) or not math.isfinite(now) or not math.isfinite(arrival)):
            reason = "Live piezo frame has no valid firmware timestamp."
        elif timestamp > now:
            reason = "Live piezo frame is ahead of the Pod clock."
        elif now - timestamp > MAX_SOURCE_AGE_S:
            reason = "Live piezo frame is too old; waiting for current sensor data."
        elif self.timestamp is not None and timestamp <= self.timestamp:
            reason = "Live piezo frame is duplicated or out of order."
        if reason:
            self.problem = reason
            self.break_continuity()
            return False
        self.discontinuous = (self._broken or self.timestamp is None
                              or timestamp - self.timestamp > MAX_FRAME_GAP_S
                              or self.last_arrival is None
                              or arrival < self.last_arrival)
        self.timestamp, self.last_arrival = timestamp, arrival
        self.problem = None
        self._broken = False
        return True
