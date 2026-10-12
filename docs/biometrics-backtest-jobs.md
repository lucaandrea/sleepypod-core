# Durable biometric backtest jobs

`BacktestJobStore` persists experiments, immutable evaluation inputs, leases,
progress, cancellation, results, and holdout exposure in `biometrics.db`.
It is the job repository; execution, API/UI integration, and production worker
resource validation are separate parts of the calibration implementation.

Enqueue pins the retained dataset hash, protocol hash, exact resolved
configurations, engine manifest hash, and selected split. Duplicate idempotency
keys return the original job, while changed requests fail. Hash or engine
mismatches are rejected. Configuration snapshots are limited to 64 KiB.

Only one unexpired running or cancellation-pending job can hold the worker
slot. Claim increments both the attempt and fencing token. Every heartbeat,
completion, failure, and cancellation acknowledgment verifies owner, token,
state, and expiry under a short SQLite transaction. An expired worker cannot
publish after replacement. Recovery marks abandoned work interrupted and
allows at most three attempts; abandoned cancellations become cancelled.

Cancellation of queued work is immediate. Running work exposes a cancellation
request through heartbeat, and cannot publish a successful result afterward.
The worker supervisor must terminate unresponsive execution after its grace
period. The repository itself does not execute code or control processes.

A result and its terminal job state commit atomically. Summaries are bounded
to 2 MiB each and 64 MiB total; job and experiment histories each stop at 1000
entries. These repository bounds do not replace worker CPU, memory, wall-time,
free-space, or live-ingest safeguards. They require target-pod measurement
before enabling production replay.

Holdout exposure is recorded on enqueue, conservatively including jobs later
cancelled or failed. It follows physical side and overlapping recorded time
ranges across datasets and experiments. Creating another dataset or changing
its asserted subject name does not erase exposure. Repeated access is labeled
`reused_holdout_is_validation`. Idempotent retries of the same enqueue do not
count twice. Future promotion must recheck current exposure, not rely solely
on the count captured in an older report.

The current evaluation protocol is explicitly descriptive. This repository
does not award validated improvement; that requires the complete evaluator,
reference support, coverage-aware policy, independent nights, and operational
validation. No backtest state activates a profile.
