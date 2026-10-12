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
to 16 MiB each and 64 MiB retained total; job and experiment histories each stop at 1000
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
reports up to 2 MiB remain inline. Larger reports use checksummed files beside
the biometrics database, with a small descriptor in SQLite. The complete report
is available through the same result reader, with both byte and canonical-data
hash verification; it is never truncated to fit the inline limit.

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

The runner heartbeats independently of the child's progress. It rechecks resource
admission every five seconds and before publication; denied or unavailable health
evidence aborts the child and records a resource interruption under the same
bounded retry policy. Checks never overlap. Shutdown leaves
owned unfinished jobs interrupted for bounded retry. Cancellation is
acknowledged only after the child has stopped, and old attempts cannot publish.
Result reads verify their hash and winning fencing token and return the current
holdout exposure count, so later reuse remains visible.

## Large report storage

`ReportArtifactStore` stages a uniquely named file, fsyncs it, atomically renames
it and fsyncs the directory before a fenced database transaction publishes the
descriptor and successful job state. File paths derive from the server-owned
database directory, job UUID, attempt token and content hash; request filenames
never select a path. An in-memory database needs an explicitly injected artifact
store for large-report tests. Existing inline results remain readable.

A failed database commit can leave an unpublished file, but cannot expose a
partial result. Staged files count toward storage checks. The collector removes
only owned files that are unreferenced and older than one hour; it preserves
committed descriptors and conservatively retains future-version named references
during downgrade. A separate SQLite publication lock serializes quota checks,
file publication, and collection across processes. File writes hold only this
sidecar lock; the live database transaction remains limited to fenced publication.
A terminated process releases the lock automatically. Identical staged retries
reuse the verified file without counting its bytes twice.

`BacktestHost` provides a serialized, recoverable five-second polling loop and
orphan collection every thirty minutes. Shutdown aborts and awaits the current
attempt before database closure. Its global singleton requires an explicit
admission callback. Production startup and measured resource admission remain
pending; merely importing the host does not start replay.

## Admission evidence

`admission.ts` defines a deployment-policy contract with a qualification ID and
explicit limits for memory reserve, free disk, one-minute load per available CPU,
current event-loop delay, piezo age, temperature and sample age. It has no shipped
threshold defaults yet. Missing or malformed policy yields `unqualified`; missing
or malformed health evidence yields `health_unavailable`. Fresh evidence must
meet every limit. Future timestamps and stale samples also defer replay, and the
decision returns all applicable pressure reasons for later API/UI exposure.

The Linux collector uses `MemAvailable`, filesystem `bavail`, normalized load,
thermal zone zero and a twenty-millisecond scheduling probe in the Node host.
The probe measures current scheduling delay rather than using the lifetime
performance histogram. Its supplied timestamp callback must read specifically
`getSensorFrameTimes()['piezo-dual']`, never the newest arbitrary sensor frame.
Unknown piezo freshness, missing thermal data, read failures or unsupported
platforms yield unavailable evidence. Collection makes no hardware commands or
database queries. These helpers are not yet connected to production startup;
measured thresholds and full publication-load qualification remain required.

## Explicit report release

Completed results support an exact-hash, idempotent release. The release
transaction replaces payload bytes with an empty stored object and records
`released_at_ms`, preserving the original content hash and completion/attempt
metadata. Readers return a null payload with explicit unavailability. Report
reads and releases share the publication lock, preventing file deletion between
descriptor lookup and byte verification. After commit, an unreferenced artifact
is unlinked; failed file deletion leaves an orphan counted against disk quota
until collection can remove it. A failed database transaction never deletes the
file. Referenced artifacts are retained conservatively, including future-format
named references. There is no automatic age-based expiry of committed reports;
release is an explicit user action through the shared API.

## Paired stage support

Each stage-replay night now includes comparisons of current versus default and,
when supplied, candidate versus default and current. Each window preserves the
configuration hashes and reports agreement, macro F1 and coverage on each
configuration's own support and on the exact intersection of their predicted
intervals. Conflicting or unknown reference intervals remain excluded by the
shared duration scorer. Common-support confusion matrices are retained; absent
paired support yields null metrics, never zero error. Fixed clock offsets apply
to both outputs for scoring without modifying the original displayed traces.

A separate coverage-reduction flag and duration/coverage differences expose
candidates that omit difficult intervals. For example, omitting the incorrect
half of a prediction may raise its own-support agreement from 50% to 100%, but
cannot produce an agreement gain on the remaining common support when its
labels are unchanged. This is descriptive reporting only. It does not yet
implement the frozen promotion policy, per-night uncertainty aggregation, or
validated activation. Numeric waveform candidates still require raw replay.

This comparison adds evaluator work and report bytes. Earlier target benchmark
numbers apply only to their recorded worker hash; repeat qualification with the
final worker before enabling production admission defaults.
