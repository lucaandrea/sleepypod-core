# Prospective shadow storage

`ShadowStore` is the storage component for prospective monitoring. It uses only
`biometric_shadow_runs` and `biometric_shadow_samples`, added by a generated
additive biometrics migration. It does not write canonical vitals, activate a
profile, import algorithm code, or control hardware. It is not yet wired to a
live worker or public API.

A frozen plan binds subject and side, active/candidate configuration hashes, reviewed
qualification and engine-build identities, a prospective time window (at most
seven days), selected metric definitions, and explicit point/byte limits.
Identities alone do not establish qualification: the eventual controller must
resolve the release-installed build and qualification before admission.
No CPU, RSS, free-space reserve, or production storage defaults are inferred.

Create is idempotent for an exact plan. New plans cannot start in the past.
Claim invokes a trusted synchronous admission check inside the write transaction
and grants an expiring attempt lease. At most one live worker per side is allowed.
A replaced/expired worker cannot append, renew, or finish over its successor.
Retained samples survive replacement and carry the original attempt identity.
The controller must reset processing state at the new attempt boundary.

Append validates side, exact active/candidate configuration, input identity,
selected metrics, ordered sequence/time, and the prospective window. Candidate
and contemporaneous active readings are retained separately in each sample;
missing values remain null, never zero. Metrics use canonical units: heart rate
in bpm, breathing rate in breaths/min, and `window_ibi_variability_v1` in ms.
The variability index must not be interpreted as RMSSD or SDNN. Exact retries do
not consume quota; conflicting retries fail.

Per-run and global point/byte limits are checked in the same immediate SQLite
transaction as insertion. Exhaustion atomically stops that run with
`storage_quota`, preserving prior evidence. A run-count quota also bounds plan
metadata. Byte counts measure serialized sample payloads, not SQLite page/WAL
allocation; filesystem reserve and database maintenance remain host obligations.
There is no automatic deletion of reports, plans, or exposure history.

`stop` supports host/operator cancellation even after deadline or worker loss,
retaining the original terminal reason on retries. The controller must stop
elapsed windows and enforce execution budgets separately. Heartbeat and sample identity feed the reporting component below. The live
shadow processor, admission controller and public API are still to be connected.

## Health and reference reporting

Plans also freeze `monitoring`: expected sample interval, maximum gap, heartbeat
staleness, minimum candidate coverage, maximum coverage loss, minimum quality,
and the shared reference-alignment policy. There are no implicit quality or
production thresholds. Selecting `window_ibi_variability_v1` requires an explicit
`windowIbiWindowMs` contract; the eventual admitted processor must match it.

`snapshot(runId, limits)` reads the entire selected run in one SQLite snapshot,
checking row counts, actual payload bytes, per-sample hashes, sequence/time order,
side/configuration/metric identities and original attempt IDs. It refuses an
oversized or corrupted run rather than silently scoring a partial page. Callers
supply limits (at most 100,000 points and 32 MiB); small chart pages must never be
substituted for a report input.

`reportShadowRun` derives health, gaps, current/candidate coverage, attempt count
and typed reference agreement. Coverage counts distinct usable cadence slots
against slots elapsed in the frozen prospective window: a burst in one slot
cannot hide missing slots. Low-quality and null values remain missing. Reports
identify stale workers, processor failure, quota stops, observation gaps, clock
skew and coverage regressions. A completed/stopped run is not assumed healthy.

Optional reference imports must match subject and side. The shared normalization
and common-support comparison code handles alignment and metric/window
compatibility. RMSSD and SDNN are not scored against the window variability
index. Out-of-window/future reference rows and incompatibility reasons remain
visible. Reports carry plan/snapshot/report hashes and reference provenance;
they are descriptive prospective evidence, not clinical validation or activation
authorization. Whole-night uncertainty and promotion review remain separate.

## Shipped-core prospective adapter

`modules/common/biometrics/shadow.py` provides `ProspectiveShadow`, an in-memory
adapter around the shipped shared processor and routing/pump gates. It accepts
both channels plus complete observed context, keeps isolated candidate state,
and emits only the selected logical side through an injected shadow sink.
It does not open a database or source, load proposed code, activate a profile,
or import hardware control. The controller must still verify release-installed
qualification and connect it to the separate storage path.

The controller supplies observed arrival timestamps, matching the live core's
clock semantics; recorded replay retains its existing event-time mode. Cold
start, insufficient preroll and missing context remain explicit limitations.
Each output carries sequence, immutable reading/provenance and a rolling input
prefix hash over arrival timestamps, actual channel bytes and recorded context.
Arbitration may delay publication: this hash identifies the prefix observed at
publication, not a claim that a reading used every sample in that prefix.

Record/output quotas and cumulative CPU checks stop the adapter on excess.
Frame output remains provisional until the cooperative CPU check succeeds.
Sink errors stop further processing; the controller must resolve any uncertain
write through the storage idempotency contract. Cancellation does not flush
pending arbitration; normal finish flushes once. These checks cannot preempt an
individual numerical call. An isolated worker with host CPU/RSS/wall limits and
health supervision is still required before enabling live shadow processing.
The worker/source/controller/storage bridge is not yet connected.

## Subprocess transport

`python -m common.biometrics.shadow_worker` exposes the shipped adapter through
bounded JSON lines. Initialization binds run/attempt UUIDs, both configurations
and their canonical hashes, selected side, observation window, processor quotas,
and input/output transport ceilings. Frames have an ordered sequence, explicit
observed-arrival timestamp, record and context. Binary channel values are base64,
validated before conversion and bounded to the core's existing channel limit.

The worker replies once per frame, with the same run/attempt identity, input
sequence, candidate-only outputs and health. Output readings include metric,
canonical unit and explicit window definition (the shipped variability index's
window comes from the shared processor constant). It accepts explicit finish or
cancel; unexpected EOF, bad identities/order/encoding, or transport overflow
fails instead of publishing a completion acknowledgment. Lines are capped at
128 KiB and cumulative transport is bounded by the initialization request.

The worker does not receive database handles or hardware access and does not
open the configured biometrics database. The supervisor must supply actual
contemporaneous active readings separately, validate replies, enforce OS limits,
and persist through the fenced shadow store. This bridge and live source
supervision are still pending. CPU accounting now includes failed adapter calls;
missing, invalid or regressing CPU clocks terminate the adapter.

## Supervisor reply validation and fenced sink

`ShadowWorkerProtocol` validates the parent side of the worker protocol. It
requires the expected command/run/attempt/configuration identity, ordered frame
acknowledgments and candidate output, selected logical side, observation window,
all three metric/unit/window definitions, and consistent monotonic health/quota
receipts. Source side may differ from logical side under single-sleeper routing.
A rejected reply advances no counters; a terminal acknowledgment closes the
protocol. A real locked-Python subprocess test checks this TypeScript/Python
contract across 150 waveform frames.

`ShadowWorkerSink` maps validated candidate output into the leased shadow store.
Construct one sink per worker attempt. It preserves original source side,
worker output sequence, flags and limitations, including cold start and missing
context. The host supplies actual active readings with exact timestamp, side,
configuration and metric contracts. It must not synthesize active readings by
rerunning a baseline or move a nearby reading onto the candidate timestamp.
Absent active data stays null with `missing_contemporaneous_active_reading`.
Exact uncertain-write retries reuse the same candidate and active snapshot;
changed retries fail. Replaced leases remain unable to write.

This sink handles candidate output, not a complete live join: the supervisor
must also retain active-only observation times, manage bounded joining and late
arrival, and identify missing candidate output. Admission, live source capture,
OS process supervision and public API integration remain unfinished. Reports
must not be used as complete prospective evidence until those paths are wired.

## Bounded active/candidate stream union

`ShadowStreamJoin` is the complete timestamp-union sink for a worker attempt.
Plans using it must freeze `joining.maximumPendingPoints`, `maximumLatenessMs`,
and `drainGraceMs`. The grace must exceed lateness; pending points are capped at
10,000, lateness at two minutes and drain grace at five minutes. These are input
ceilings, not recommended pod defaults. Host measurement/admission must choose
appropriate smaller budgets.

Feed both actual active observations and validated candidate outputs, then call
`advance(nowMs)` after enqueuing arrivals. The join emits timestamps at or before
`nowMs - maximumLatenessMs` in order, retaining points present in only one stream
with nulls on the missing side. Nearby timestamps remain distinct. Exact pending
duplicates are harmless; changed duplicates, arrivals after a timestamp has been
sealed, clock regression and queue exhaustion fail the attempt explicitly. A
lost lease cannot fail or write over its replacement.

Storage acknowledgment is required before removing a buffered point or advancing
its durable sequence, so an uncertain committed write can be retried exactly.
Storage quota exhaustion closes the join. On restart, a new attempt begins after
the last retained timestamp; discarded in-memory observations are not invented.
The supervisor must collect both streams continuously and surface failures.

Leases for joined runs may remain valid until the frozen end plus drain grace,
allowing already-buffered samples to be stored after collection ends. Sample
timestamps must still be inside the original window; new worker claims cannot
start after its end. The supervisor stops feeding candidate input at the window
end, drains both sources within grace, and then finishes the run. Grace is not
permission to extend observation or processing indefinitely.

Joined samples identify whether each stream was present and whether their input
identity is a candidate prefix, active provenance, or unavailable. Active-only
readings with unavailable signal provenance retain a null input hash rather than
a fabricated one. Reports expose active-only/candidate-only counts and unknown
input identity. Live source capture, OS supervision, admission and API/UI wiring
remain required to turn this component into an enabled prospective service.

## Linux kernel-limit entrypoint

The production supervisor must launch `common.biometrics.shadow_process` with
explicit `--cpu-seconds` (1–3600) and `--address-space-bytes` budgets. This installs
CPU, core-dump, open-file, low-priority and numerical-thread limits using the
existing replay bootstrap, then a hard address-space limit, before importing the
numerical shadow worker or reading its initialization. Yocto without Python's
`resource` extension uses the fixed `/usr/bin/prlimit` utility; missing or refused
limits fail startup. Unsupported hosts fail rather than claim enforcement.
There are no production budget defaults. The direct `shadow_worker` module
remains a transport test entrypoint and does not install kernel limits.

The CPU cap includes import/startup and has a one-second hard-limit grace; it is
separate from the adapter's finer cooperative processing budget. Address space
bounds virtual allocations, not resident memory. The parent must still enforce
RSS, wall/idle deadlines, cancellation, lease loss and process cleanup. These
host controls and live admission remain unfinished. This entrypoint runs only
trusted shipped algorithms and is not a sandbox for external package proposals.
