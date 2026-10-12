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

## Shipped processed-data worker

`evaluator.ts` executes comparison and stage replay over the frozen selected
split. Overlapping session rows are deduplicated by original ID; overlapping
windows merge and disconnected sessions are classified separately. It calls
the existing retrospective classifier with the exact resolved rules and the
protocol's explicitly assumed calibration quality. Default/current snapshots
with identical hashes execute once. Fixed clock offsets also apply to stage
scoring. Original unshifted stage traces remain available in the report.

Numeric comparisons use original stored readings. They do not evaluate a
candidate's waveform-processing parameters. Stage comparisons report
interval-duration agreement, not the chart's older midpoint agreement.
Reports remain descriptive/insufficient-evidence until the promotion policy,
reference support, common-support checks and operational qualification are
complete. Merged replay windows are currently limited to one day, and complete
reports must fit the repository's 2 MiB bound; larger trace artifacts still
need the dedicated artifact publication path.

`pnpm build` now bundles the worker into
`.next/standalone/biometrics-worker/worker.cjs`; `pnpm build:biometrics-worker`
builds it independently. Packaging rejects database, hardware, automation,
scheduler, HomeKit and streaming dependencies. Shared schemas live in the pure
`contracts.ts` module so the worker does not import repositories. Enqueue pins
the SHA-256 of the actual worker bundle, and the runner checks it before launch.

`executeNextBacktest` runs one leased attempt after an injected host admission
check. It does not start itself or enable production replay. The host must wire
measured resource/ingest admission and lifecycle handling. `runBacktestChild`
uses a separate low-priority Node process, a clean environment without pod
credentials, a 128 MiB JavaScript heap limit, bounded stdin/stdout/stderr, a
wall-time watchdog, and cancellation with SIGTERM followed by SIGKILL. This is
isolation for shipped trusted code; it is not the external sandbox required
for user-proposed algorithm packages. The heap limit is not a total RSS cap.
The child records evaluation runtime and peak RSS for operational inspection.

The runner heartbeats independently of the child's progress. Shutdown leaves
owned unfinished jobs interrupted for bounded retry. Cancellation is
acknowledged only after the child has stopped, and old attempts cannot publish.
Result reads verify their hash and winning fencing token and return the current
holdout exposure count, so later reuse remains visible.
