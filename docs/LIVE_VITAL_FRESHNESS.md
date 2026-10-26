# Live vital timestamp boundary

The live piezo processor now timestamps new estimates with the accepted
firmware `piezo-dual.ts` value. Previously it used the processing clock, so a
delayed frame could produce a current-looking database row. This is a source
freshness fix, not validation of the heart-rate algorithm or sleep outcomes.

```mermaid
flowchart LR
  Frame[Firmware piezo frame] --> Gate[Fresh and ordered timestamp]
  Gate -->|accepted| Buffer[Continuous sample buffers]
  Gate -->|invalid or old| Reset[Discard unfinished estimates]
  Gap[Missing frame or pump artifact] --> Reset
  Buffer --> Estimate[Vital estimate at firmware time]
  Estimate --> Database[Vitals and matching quality row]
```

## Live behavior

- Require a finite positive firmware timestamp, no later than the Pod clock and
  no more than ten seconds old. Missing, boolean, malformed, future, stale,
  duplicate and reversed timestamps are rejected before samples enter buffers.
- The documented live format carries one second of samples per piezo frame.
  More than 1.5 seconds between source frames or between monotonic arrival
  times starts a new window. This intentionally favors missing estimates over
  silently concatenating disconnected samples.
- Rejected timestamps, empty channels and pump-gated frames clear unfinished
  HR, breathing and HRV buffers, trackers and presence state. Normal consecutive
  frames retain state. Completed candidates awaiting the other side or a
  database retry keep their original timestamp and existing retry behavior.
- New live run provenance declares `timestampBasis: firmware_event_time_v1`.
  Old `processing_clock` and unknown legacy rows are unchanged. Readers must
  check provenance before combining their time semantics.
- Timestamp failures report degraded module health; valid input and available
  configuration restore health. Fresh input alone does not establish signal
  quality, calibration, occupancy, or the absence of base/vibration artifacts.

## Compatibility and remaining work

This change does not enable personal comfort Active or its sensor-aware option.
The comfort adapter still needs explicit quality, whole-window artifact and
personal-baseline handling. Priming, vibration and base-motion exclusion needs
recorded evidence before those samples can train a personal baseline.

The prospective shadow candidate currently uses observed arrival time. Its
strict active reader rejects the new firmware-time provenance, rather than
quietly comparing different clock semantics. That experimental comparison must
gain a matching frame-clock and discontinuity adapter before it can run against
this new live processor. Retained waveform replay and historical records retain
their existing declared semantics. Previously admitted experimental evaluations
do not qualify this changed source bundle; its source hashes have changed.

Deployment requires a fresh pinned sensor package and runtime validation. The
working Pod remains on Free Sleep until the separate controller handoff and
attended qualification gates pass. Tests use synthetic fixtures and local
SQLite; they do not count as observed Preview nights or physical qualification.

## Regression coverage

Tests cover the ten-second boundary, event versus arrival time, missing and
malformed timestamps, duplicate/reversed frames, gaps and clock discontinuity,
recovery after stale input and a pump artifact, estimator buffer reset, and
preservation of event time and provenance through a delayed database write.
