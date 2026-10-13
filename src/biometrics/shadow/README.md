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
individual numerical call. The kernel entrypoint and parent supervisor below
provide CPU/RSS/wall enforcement. The live source/controller/storage bridge is
not yet connected.

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
and persist through the fenced shadow store. The components below provide reply
validation, persistence and process supervision; live controller wiring is pending. CPU accounting now includes failed adapter calls;
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
arrival, and identify missing candidate output, using `ShadowStreamJoin` below.
Admission, live source capture and public API integration remain unfinished. Reports
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
input identity. Live source capture, admission and API/UI wiring
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
bounds virtual allocations, not resident memory. The parent supervisor below
enforces RSS, wall/idle deadlines, cancellation and process cleanup. The live
controller must signal lease loss and perform admission. This entrypoint runs only
trusted shipped algorithms and is not a sandbox for external package proposals.

## Parent process supervision

`runShadowChild` launches that fixed Linux entrypoint in a detached process group,
with trusted host paths, a sanitized environment, and explicit resource budgets.
It validates the frozen configurations and hashes before launch. Input comes from
an async frame iterator, with one frame in flight and one validated acknowledgment
per command. The caller must bound any buffering in its source adapter. Each
candidate batch passes `ShadowWorkerProtocol`; the supervisor waits for each sink
callback before pulling the next frame. The callback must use the leased store
or join and propagate storage/lease errors.

The supervisor enforces cumulative transport bytes, 128 KiB lines, record counts,
16 KiB diagnostics, source-idle and acknowledgment deadlines, and a separate wall
deadline that also bounds stalled sinks. Unsolicited output, malformed UTF-8/JSON,
missing terminal acknowledgment, nonzero exit and pipe errors fail the run.
Diagnostics are discarded rather than copied into logs. Normal completion
requires both a validated finished receipt and a clean process exit.

Bounded procfs observations sample the entire detached process group's RSS.
Unavailable, timed-out or excessive observations fail closed. A successful receipt
includes the observed peak, sample count, maximum observation gap, configured
budgets and explicit sampled-memory scope; it does not claim an exact kernel RSS
peak. The address-space kernel cap is a separate limit. There are no pod resource
defaults in this component.

Cancellation (including a host lease-loss signal), source/sink failures and every
exit path kill the process group and wait for the direct child to close, with a
bounded cleanup deadline. A descendant retaining the worker's pipes is killed as
well. There is no canonical worker state to flush. Iterator cleanup is requested
without allowing a stalled iterator to keep the process alive. A pending host
sink cannot be forcibly cancelled; its writes must remain attempt-fenced.

This implements process supervision, not service admission or restart recovery.
The live controller must still bind the installed build/qualification and active
profile, manage leases, capture bounded sensor/active streams, renew or cancel on
binding changes, recover after host crashes, and expose the requested API/UI.

## Fenced attempt lifecycle

`runShadowAttempt` connects the store, stream join and subprocess supervisor for
one attempt. Its trusted host supplies shipped configurations, explicit execution
budgets, synchronous admission and bounded source adapters. Admission must resolve
the installed qualification/build, active profile and host resource/source health;
it is checked at claim, on every incoming reading/frame and on each heartbeat.
The heartbeat interval is at most one third of the lease, one second, and the
plan's heartbeat-staleness threshold. An asynchronous admission result is refused.

The source factory registers both streams and exposes a synchronous unsubscribe.
It must unwind partially registered subscriptions if opening throws, and call
`fail()` when either stream disconnects or overflows. Frames must carry their real
observed arrival times. The controller assigns fresh per-attempt sequence numbers,
refuses future arrivals, and ends the iterator at the frozen window boundary even
if its next read is stalled. A source ending early is a failure. Active readings
may continue arriving during the bounded final drain; timestamps remain in the
original observation window. The controller requires a worker completion receipt,
waits through the allowed lateness interval, flushes the join, closes both sources
and only then records completion. Source cleanup failure prevents completion.

Admission changes, lease loss, source/worker/sink failures and operator cancellation
abort the worker and stop accepting callbacks. Worker cleanup finishes before the
terminal store transition. Existing operator/quota/join termination is preserved.
If its lease expired during cleanup, `failExpired` can mark that same attempt
failed; it cannot affect a replacement, unexpired lease or already terminal run.

The host adapter is still to be implemented and wired to service/API lifecycle.
The controller does not invent qualification, choose production budgets, subscribe
to hardware on its own, recover orphan workers after host crashes, or persist the
returned worker resource receipt. Those integration obligations remain before
prospective runs can be enabled or treated as production-qualified evidence.

## Live waveform source adapter

`openShadowFrameSource` subscribes to the shared RAW/NATS dispatch through the
separate `prospectiveFrameTap`. The tap lives on `globalThis`, has at most four
subscribers, excludes ingestion backlogs and unrelated sensor types, and isolates
consumer failures from canonical live ingestion. Current-source NATS termination
and server shutdown notify subscribers of failure. Admission/idle monitoring must
still detect silent sources and temporary disconnects.

The adapter freezes each frame's actual host arrival timestamp and the trusted
host's contemporaneous occupancy/active-side/pump-availability context. It encodes
signed little-endian int32 channels (at most 5,000 samples each) for the Python
worker, and copies only the bounded pump fields used by the shared gate. It never
retains mutable decoder arrays or invents missing context. Explicit event-age and
future-skew budgets reject delayed live delivery even when it was not labelled as
a backlog. Only the shipped 500 Hz waveform format is accepted when a frequency
is present; hardware compatibility still belongs to admission.

Frame-count and serialized-byte queue budgets are mandatory. Overflow, invalid
samples/context/clocks, and unread queued frames at collection end fail the
attempt; there is no silent drop or unbounded catch-up. A single consumer reads
in arrival order. Abort, window end and iterator return unsubscribe and settle
pending reads. This adapter supplies candidate input only. The active-reading
adapter, context provider, installed qualification/admission and service wiring
remain required before enabling prospective shadow runs.

## Read-only active observation capture

`ShadowActiveReader` polls an existing read-only biometrics SQLite connection.
It starts at the current vitals ID and accepts only subsequently inserted rows
for the selected side and observation window. Each poll reads one consistent
snapshot with an explicit row quota (at most 100); overflow refuses the whole
batch. Bundle and input metadata are bounded in SQL before materialization.
The cursor advances only after the complete batch validates. A deleted or changed
cursor anchor fails rather than silently continuing through a reset or rewrite.
The host must close/reopen its connection on database replacement and treat any
capture failure as an attempt failure.

Every accepted row must have exactly one matching quality record and a live
processing run with the expected configuration, validated resolved parameters,
shipped manifest, component and source identities, side and time boundaries.
Legacy/unknown, replay, corrupt, mismatched, missing-quality and future observations
are refused. Null metric values remain null, quality is copied from the committed
quality row, and original second-resolution timestamps remain unchanged. Physical
source side can differ from the logical side under single-sleeper routing.

The existing daemon explicitly records `rawIdentity: not_retained`, so this reader
returns a null input hash. It preserves processing-run ID, physical source side,
generation and manifest identity as `activeProvenance`; the join and candidate
sink retain these fields in the separate shadow sample payload. This is an
additive JSON field, requiring no schema migration or canonical-vitals write.
Polling cadence, final-drain polling, runtime admission/context, connection
replacement detection, resource receipts and service/API wiring remain host
integration work; this reader alone does not enable a prospective run.

## Composed live sources and drain polling

`openShadowLiveSources` establishes the active-reader watermark before subscribing
to prospective waveform input. It polls the read-only reader on an explicit
10–1000 ms cadence, strictly shorter than the frozen join lateness, and exposes
`flush()` for synchronous polling before the controller seals join timestamps.
`runShadowAttempt` invokes that flush on every heartbeat and at final drain;
commits arriving between the last timer poll and completion are included. Flush,
active delivery and database-identity checks must be synchronous. Their failures
terminate the attempt rather than acknowledge an incomplete read.

Waveform collection ends at the observation boundary while active polling remains
available during drain. Abort, source disconnect, poll failure and explicit close
remove both subscriptions/timers. Source teardown does not own the SQLite handle.
The host closes that handle afterward.

`openShadowActiveDatabase` opens an existing regular file read-only with an
explicit bounded busy timeout. It checks the path's device/inode identity before
and after opening and supplies `assertCurrent` to the composed source. Replacement,
removal, a symlink or a closed connection stops capture instead of reading the old
file indefinitely. Paths remain trusted host configuration, never caller input.

These pieces still require the production context provider, installed build and
qualification admission, frozen execution budgets/receipts, orphan recovery and
service/API registration. No production defaults or qualified registry entries
are inferred by composing the sources.

## Committed context snapshots

`ShadowContextReader` supplies the frame adapter's `(frame, observedAtMs)` context
callback. It reads sleeper configuration through a read-only connection using the
shared `activeSleeperSides` logic. Both side rows and a valid bed mode are required;
missing or corrupt settings produce unknown mode instead of invented defaults.
The host's database identity guard is checked before and after capture.

Occupancy comes from the sleep detector's version-1 committed presence file,
matching the evidence fields used by Python `BedPresence`: `vitals_presence` and
`vitals_evidence_ts`. File and per-side evidence freshness are both checked against
the observed arrival time with an explicit limit no greater than the daemon's
five-minute ceiling. Missing, stale, future, malformed, oversized, symlinked or
changing files produce unknown presence. Reads are bounded, no-follow, regular-file
only; unknown on one side does not erase valid evidence on the other. The virtual
web/HomeKit occupancy estimate is not substituted for this committed evidence.

Pump availability starts unknown for each attempt. Only observed `frzHealth`
records with usable pump fields on both sides establish it; incomplete updates
invalidate availability, and an explicit age limit expires it. This does not
invent pre-attempt pump state or remove the processor's pump gates.

These are current host observations, not proof of the active daemon's exact
cached view: Python independently reloads sleeper settings and committed presence.
Reports explicitly identify that context evidence limitation. Production admission
and qualification must account for those timing differences. The provider does
not itself qualify a run, persist execution policy, or register a live service.
