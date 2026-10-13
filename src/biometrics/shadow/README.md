# Prospective shadow monitoring

`ShadowStore` is the storage component for prospective monitoring. It uses only
`biometric_shadow_runs` and `biometric_shadow_samples`, added by a generated
additive biometrics migration. It does not write canonical vitals, activate a
profile, import algorithm code, or control hardware. The installed application
service connects it to the shipped worker, bounded live sources and public
inspection/submission APIs. Execution requires explicit deployment configuration
and a matching release-installed qualification registry; neither is inferred
from a synthetic benchmark. The sections below describe each layer.

A frozen plan binds subject and side, active/candidate configuration hashes, reviewed
qualification and engine-build identities, a prospective time window (at most
seven days), selected metric definitions, and explicit point/byte limits.
Identities alone do not establish qualification: the installed controller must
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
shadow processor, admission controller and public API use the installed service
composition described below.

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
provide CPU/RSS/wall enforcement. The planned source factory and owned attempt host below connect the live
source/controller/storage bridge.

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
one attempt. Its trusted host supplies shipped configurations, synchronous
admission and bounded source adapters; execution budgets come from the saved plan. Admission must resolve
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

The owned attempt host and application service below provide the host adapter
and service/API lifecycle.
The controller does not invent qualification, choose production budgets, subscribe
to hardware on its own or recover orphan workers after host crashes. Completion
now persists the validated worker receipt atomically with terminal state. Those integration obligations remain before
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
replacement detection and receipt persistence are provided by the composed
components below; production service/API wiring remains host integration work; this reader alone does not enable a prospective run.

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

These pieces use the context provider, frozen budgets and receipt persistence
described below. Production installed-build/qualification wiring, orphan recovery
and service/API registration remain. No production defaults or qualified registry entries
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

## Frozen execution policy

Executable plans now require `execution` (`shadow-execution-policy-v1`). It binds
both physical-channel configuration hashes, record/output/transport/CPU quotas,
process CPU/address-space/RSS/deadline limits, lease and heartbeat cadence, active
polling/row/busy-timeout limits, waveform queue/freshness limits and committed
context freshness/file limits. Schemas are shared with the worker, waveform and
context components; there are no implicit production defaults.

The complete policy participates in the plan hash and create-idempotency contract.
The store validates heartbeat/lease and polling/lateness compatibility. Reports
expose `executionPolicyHash`. Old plans lacking execution policy remain inspectable
and reportable, but `runShadowAttempt` refuses to execute them. No migration or
backfilled claim of past resource enforcement is needed.

The attempt reads execution limits only from a private copy of the stored plan;
the host no longer supplies alternative worker limits. Both channel configs must
match before claim, since the opposite channel influences routing and rejection.
Source factories receive their own policy copy for configuring capture, and
cannot change the worker's copy. The production factory must apply those source
limits and the installed qualification must match the complete policy. Selecting
this policy does not establish qualification or record observed worker resources;
admission/service integration remains, while completion records receipts below.

## Planned source factory

`plannedShadowSourceFactory` is the concrete `openSources` implementation for an
attempt. It snapshots and validates the saved plan and trusted installation paths,
then refuses a different execution policy or collection end at invocation. It
opens both databases read-only with the saved busy timeout, creates a fresh
committed-context reader, and applies the saved active polling, waveform queue,
freshness and context limits to the composed sources. There are no alternate
numeric limits at this layer.

The factory owns both connections. It unsubscribes before closing handles on
normal close, abort, source failure, direct flush failure and partial startup.
Configuration and biometrics path identities are both checked during capture.
Tests exercise real SQLite connections and the sensor tap, including frozen
policy substitution, saved queue overflow, cancellation and failed second-database
startup. Installed qualification/build/current-binding admission, orphan recovery
and public service registration remain separate requirements; constructing sources does not authorize a candidate to run.

## Installed shadow admission

`installedShadowAdmitter` checks a separate, release-installed
`shadow-qualifications.json` beside the trusted worker. Replay promotion evidence
does not authorize prospective execution. The bounded, regular, no-follow file is
read on every check, so removing an entry revokes subsequent admission. Exactly
one entry must match the saved qualification hash, current manifest, installed
engine/Python/hardware identity, sample rate, active configuration and complete
execution policy. Evidence includes reviewed fixture, pod and held-out artifacts
and explicitly acknowledges the host-context timing limitation.

Admission also requires an applied, fresh selected-side runtime receipt matching
the generation captured before the attempt, plus fresh memory, disk, CPU load,
event-loop, ingestion and temperature observations under the entry's health
policy. A same-hash reset still changes generation and stops admission. Missing,
ambiguous, stale or asynchronous observations refuse execution.

The callbacks are trusted host collectors, not request fields. Concrete collectors
must verify installed artifacts and aggregate all relevant daemon receipts; the
current aggregate receipt contract is not itself proof that those components ran.
Production integration must also guard relevant opposite-side binding changes.
No production entry or collector is installed here, and the admission module
does not authorize activation or provide an API for writing qualification files.

`shadowRuntimeBindingReader` supplies the aggregate binding observation from
read-only configuration and biometrics handles. It freezes expected generations
and hashes for both physical channels, validates desired activation hashes and
bounded runtime projections against the shipped manifest and resolved config,
then requires the latest heart-rate, breathing-rate and HRV receipts to be applied
at those exact generations. It never falls back to an older applied generation.
Missing or pending receipts, future boundaries/heartbeats, and changed opposite-side
bindings refuse observation. The minimum of all six heartbeats lets the admission
policy enforce freshness for every component. Sleep-stage receipts are on-demand,
so they are not evidence of continuous numerical health.

The collector uses nested read snapshots and checks caller-owned database identity
before and after capture. These are observations, not a cross-database lock or a
promise that activation cannot occur after a read; the attempt must keep checking
admission. It opens no files and writes no runtime state. Host construction still
needs to capture both expected baselines, provide file-identity guards, and connect
this collector with installed build identity and resource-health observations.


## Durable completion receipt

Migration 0030 adds nullable receipt and receipt-hash fields without inventing
measurements for old runs. Completing an executable plan requires a validated
worker receipt in the same fenced transaction as terminal state. The bounded
16 KiB envelope binds run, attempt, plan hash and completion time, and retains
worker health/counters, CPU time, transport bytes, sampled process-group RSS,
sampling count/gap and frozen child budgets. Its storage is bounded per run in
addition to sample-byte quotas and the existing run-count limit.

Store reads verify the envelope hash and identities and recheck measurements
against the saved execution policy. Snapshots and reports retain this evidence.
RSS remains a sampled sum across the process group, not an exact kernel peak;
recording a receipt does not establish pod qualification or activation authority.
Failed/cancelled attempts currently have no successful worker receipt, and crash
recovery/partial resource evidence remains separate work. Receipt-validation
failure after cleanup marks the same attempt failed, including the expired-lease
fallback, without overwriting a replacement attempt.

## Host health sampling

`openShadowHealthMonitor` connects the existing Linux memory, filesystem space,
load, event-loop delay and thermal collector to a trusted live piezo receive-clock
callback supplied by the application.
The host supplies that callback, the database directory and installed qualification policy.
The monitor waits for an initial collection, then exposes a synchronous `read`
for admission. Every read re-evaluates health and freshness against that policy;
missing, stale, future or unhealthy evidence returns null.

Refresh cadence and collection deadline are each half the allowed sample age,
capped at one second. Only one collection can be in flight. A rejection or timeout
closes the monitor; uncancellable filesystem I/O is observed but never retried or
allowed to publish a late result. Abort/close cancels timers and invalidates cached
evidence. Successful null/unhealthy samples can be refreshed, but never admitted.
The attempt's next admission check stops it when the monitor cannot provide health.
Host service ownership, installed build identity and qualification selection still
need to wire this monitor into the complete attempt lifecycle.

## Shadow Python build identity

`probeShadowBuild` invokes the fixed `common.biometrics.shadow_build` probe using
the same interpreter and module directory as the worker, with sanitized thread
settings, a ten-second deadline and a 64 KiB output bound. It checks the canonical
identity hash and requires the shadow-specific source entries. Replay fingerprints
alone cannot qualify a shadow worker.

The Python fingerprint uses `shadow-python-build-v1` and covers all shared replay
sources and locked dependency metadata plus `shadow.py`, `shadow_worker.py`,
`shadow_process.py` and the probe itself. Thus prospective processing, JSONL
transport and kernel-limit changes invalidate qualification. The probe neither
imports the numerical processor nor opens live sources. Dependency RECORD/WHEEL
hashes identify installation metadata, not every installed binary's contents.
Production composition must still bind the shipped Node host bundle, capture
hardware identity, and revalidate installation identity during execution.

## Owned attempt host

`openPlannedShadowHost` composes the installed qualification, both-side runtime
binding collector, live health monitor and saved-policy source factory. It owns
separate read-only admission connections with file-identity guards and the saved
busy timeout. Qualification lookup precedes health sampling, and initial admission
must pass before the host is returned. Subsequent admission also requires the
entire saved plan to match. Installation paths, candidate configs and expected
baseline identities are privately copied; they are trusted host inputs, never
arbitrary RPC executable paths or identity assertions.

`runPlannedShadowAttempt` passes this host to the leased controller and closes its
resources on success or failure. Closing aborts the attempt first, then closes
health and admission connections. Partial startup and cancellation while waiting
for initial health also unwind ownership, including a late returned health handle.
The source factory separately owns its capture connections and subscriptions.

This composition still requires production code to resolve candidate/baseline
configs, capture hardware and shipped Node/Python identity, and supply a synchronous
identity collector that detects changes. It does not recover orphan workers,
register APIs/UI, install qualification entries or create production budgets.

## Resolving candidate profiles and active baselines

`resolveShadowProfiles` reads the saved candidate revision through the existing
immutable profile validator, including side, pinned manifest, override rebuild and
dependency checks. A null revision explicitly requests the shipped default. The
resolved candidate must match the saved candidate hash.

Both active baselines come from desired activation generations and their bounded
runtime projections in nested read snapshots. The full runtime binding collector
then verifies all numerical receipts and projection identities; no unacknowledged
fallback is allowed. The selected active hash and both candidate execution hashes
must match the plan. The opposite channel retains its acknowledged configuration.
This operation requires read-only handles and pre/post file-identity guards and
writes no activation, receipt, repair or canonical measurement.

`runProfiledShadowAttempt` owns temporary profile-resolution handles and closes
them before constructing the admission host. Admission checks the captured
identities again, so changes between resolution and execution are rejected. This
entry point accepts a saved revision ID rather than caller-asserted configs or
active generations. Trusted installed build/hardware identity, service ownership,
crash recovery, qualification and public API/UI integration remain required.


## Packaged host identity

The standard biometrics build also produces `shadow-host.cjs` and its dependency
manifest. This CommonJS module exports the profiled attempt runner, store/plan
schemas, installed qualification reader and build probe; importing it starts no
service. The build rejects hardware, automation, scheduler, HomeKit, live database
singletons and streaming entrypoints. Only the passive `prospectiveFrameTap` is
allowed from streaming. The application supplies the actual receive-clock callback,
so the bundle does not initialize another stream or hardware controller.

`shadowEngineBuildIdentity` hashes the exact host bundle bytes, prospective Python
fingerprint and Node runtime identity. The real-package test loads the exported
API, inspects its dependency graph, compares packaged/source probe identities and
proves changing the host artifact changes the engine fingerprint. Production must
load and execute this same bundle and guard installation changes during a run;
fingerprinting an unused file would not establish execution identity. Hardware
capture, recovery, service/API/UI registration and current-build qualification
remain required before production runs.

## Loading the verified package

`loadInstalledShadowHost` reads a trusted regular-file artifact with no-follow
semantics and a 16 MiB bound, hashes its bytes, and checks its device/inode, size,
mtime and ctime before and after loading. It rejects an unsupported API version,
unverified existing Node cache entry, changed installation or different bundle
path after the first load. The verified package is held on `globalThis`, avoiding
multiple independent loader instances under the application bundler. Parent paths
are canonicalized for Node's cache key while leaf symlinks remain forbidden.

The returned `assertCurrent` checks both canonical and requested paths; replacement
with identical bytes still requires restart. `inspectInstalledShadowHost` probes
through that loaded API, rechecks the artifact after the asynchronous Python probe,
and verifies the reported host hash matches the loaded bytes. These guards cover
the Node artifact. Python source/dependency change monitoring and hardware capture
remain separate requirements, and the application must actually use this loader
and its guard when registering production execution.

## Python installation change guard

The shadow probe now supplies absolute RECORD/WHEEL locations for the installed
NumPy and SciPy distributions; ambiguous or missing metadata paths refuse the
probe. Locations remain outside the portable build hash. The identity still
contains source and metadata content hashes.

`guardShadowPythonInstallation` validates every listed source and dependency
metadata file against the probe with bounded reads (16 MiB per artifact), rejects
traversing source paths and relative dependency paths, and records requested and
canonical file identities. Metadata text normalization matches Python's text
hashing. Subsequent checks detect device/inode, mode, size, mtime/ctime or link-target
changes without rehashing all content each heartbeat. The interpreter link and
resolved target are watched too. `inspectInstalledShadowHost` now returns a
combined Node/Python guard after verifying the actual loaded package.

This covers shipped source, installed wheel metadata, and interpreter replacement;
it is not a full native-library binary attestation. The guard must still be called
by production admission alongside actual hardware identity. Service registration,
crash recovery and current-build qualification remain outstanding.

## Observed hardware identity

`observedShadowHardware` reads the existing DAC monitor without starting it or
sending commands. It requires running status, a successful poll timestamp within
the qualification's explicit `maximumHardwareObservationAgeMs`, and a recognized
H/I/J sensor revision consistent with the reported pod version. Unknown labels do
not inherit the general status parser's Pod 3 fallback. The hardware ID contains
pod version and exact sensor revision, never a serial number. The 500 Hz value is
the shipped waveform protocol rate; frame admission separately rejects an explicit
incompatible frequency.

`installedShadowIdentity` combines that observation with the inspected Node/Python
fingerprints and invokes the combined artifact guard on every call. Build or
hardware mismatch rejects admission. This adapter lives on the application side
of the package boundary, so hardware services remain excluded from the passive
host bundle. Production service execution must still supply this collector and
register cancellation/recovery and user-facing operations.

## Installed application runner

`runInstalledShadowAttempt` connects the application to the verified package. It
inspects the installed host, opens an owned writable state connection to the
existing biometrics database, and constructs the package's own `ShadowStore`.
The state connection uses an explicit timeout no greater than the saved execution
policy and the same file-replacement guard as read-only capture connections.

The runner selects the exact installed qualification, builds the observed
hardware/artifact identity collector, supplies the actual shared piezo receive
clock, and invokes the loaded package's `runProfiledShadowAttempt`. Every identity
check also verifies the writable state database still refers to the owned file.
The state handle closes after completion, cancellation or any startup/execution
failure. Capture handles remain read-only; only the store owns shadow writes.

Service code supplies trusted installation paths, storage policy and timeout;
operations identify an existing run and saved candidate revision. This entry point
does not register background scheduling or public routes, and does not establish
cross-process orphan recovery or concurrent resource admission. Those lifecycle
requirements and current-build qualification remain before production enablement.

## Host-crash worker termination

The Node supervisor now passes its own PID to the fixed Python bootstrap. Before
resource-limit setup or numerical imports, the bootstrap requires Linux and arms
`PR_SET_PDEATHSIG` with `SIGKILL`. It checks the expected parent before and after
arming, so a host that dies during startup cannot leave an unprotected worker
processing frames. Missing ctypes/libc support or kernel refusal stops startup.
The expected PID is launch metadata, not a request field.

A real Linux test launches a detached worker, waits for it to arm protection,
kills its launcher and verifies that the worker terminates. Existing CPU and
address-space kernel tests also pass. This is process-local protection, not a
process-group inheritance guarantee: Linux clears it in forked children. The
shipped numerical worker does not launch candidate subprocess trees. Parent-side
group cleanup remains required, along with durable attempt recovery and resource
admission across concurrent service processes.

## Kernel-held replay/shadow execution slot

The shadow bootstrap and waveform replay CLI take a nonblocking exclusive flock on the fixed
`/run/sleepypod-shadow.lock` before numerical imports and holds its descriptor for
the worker lifetime. A second numerical worker fails startup even if its
SQLite lease was granted after a paused worker's lease expired. File creation is
private, no-follow and non-truncating; nonregular, linked, nonempty, wrong-owner or
publicly accessible files are refused. No request/CLI argument selects the path.

The runtime file is never unlinked during operation. Descriptor close or process
death releases kernel ownership without stale-file cleanup. A real Linux test
verifies exclusion while the owner is stopped with SIGSTOP and acquisition after
SIGKILL/reaping, including the actual replay CLI blocking a shadow contender.
Both entrypoints use the same shared implementation, included in their build
identities. The legacy runtime path is retained for shadow upgrade compatibility.
Build-description probes do not take the slot because they do not run numerical
processing. Lock contention fails startup rather than waiting with an active lease.

This serializes shipped waveform replay and shadow workers sharing the runtime
path. It does not serialize Node stage replay or archive collection, replace
qualified aggregate host admission, or prove expired-attempt process cleanup.
Before enabling a new installation, stop/reap old replay workers that predate
this lock; they cannot retroactively acquire it. Never delete the lock file to
force admission while any worker may still own its inode.

## Worker-local wall deadline

The supervisor passes the saved `wallMs` budget to the Python bootstrap, which
arms `ITIMER_REAL` before numerical imports. It installs the default terminating
SIGALRM action and explicitly unblocks that signal. This supplements the parent's
wall timer, so an idle worker does not depend on Node's event loop to enforce its
elapsed-time budget. No alternate production timeout is selected by the worker.

The real Linux test starts with SIGALRM blocked, arms a 100 ms deadline, sleeps,
verifies signal termination and then reacquires the execution lock. Parent-side
process-group cleanup remains necessary; a process explicitly stopped by SIGSTOP
cannot handle ordinary pending signals until resumed, and the lock continues to
exclude competing shadow workers in that condition.

## Bounded expired-run reconciliation

`ShadowStore.reconcileExpired` scans at most 100 runs per immediate transaction
using a primary-key cursor, including future and terminal rows so maintenance
cannot get stuck on the first unexpired window. It validates candidate plans and
compares state, attempt and lease when changing authority. A corrupt plan rolls
back the batch. Unexpired replacement attempts and terminal evidence are preserved;
final-drain authority remains valid until its lease/deadline expires.

Expired running attempts become failed with
`shadow_lease_expired_cleanup_unconfirmed`. This revokes append/renew authority
without claiming that an OS process was reaped. Retained samples and attempt IDs
remain available, reports flag unconfirmed cleanup, and the kernel slot continues
to exclude overlapping shadow workers. Pending runs whose observation window was
missed become failed with `shadow_observation_window_missed`; reports do not call
that a processor failure or fabricate observations.

`reconcileInstalledShadowRuns` exposes this maintenance through the loaded package's
store with owned state-handle cleanup and artifact/database guards. It starts no
Python probe, worker or hardware operation and needs no admission qualification.
Periodic service scheduling must retain the returned cursor until a sweep ends,
then start another sweep. Recovery revokes authority; process cleanup confirmation
and shared replay/shadow resource ownership are separate lifecycle requirements.

## Application service ownership

`startShadowService` creates one `globalThis` service using explicit installation,
storage and maintenance policy. Repeated starts reuse the same configuration;
configuration changes require stopping/restarting it. The service snapshots its
configuration, runs bounded recovery pages at the configured cadence, retains its
cursor after a failed transaction, and restarts the scan after a completed sweep.
Recovery continues during a prospective attempt.

Only one local attempt may execute. Cancellation and shutdown abort that attempt
and await the installed runner's cleanup before releasing its slot. Application
shutdown calls `stopShadowService` before database closure. The database lease and
Linux worker lock still enforce authority across processes; this local owner does
not replace them or serialize replay workers.

Application instrumentation starts this service after migrations and hardware
initialization when explicit deployment configuration is present. CI skips it
along with hardware initialization. No production resource thresholds or
qualification evidence are inferred by this service. The inspection, creation
and cancellation APIs and browser workflow use this service as described below.

### Deployment configuration

Set `SLEEPYPOD_BIOMETRICS_SHADOW_SERVICE` to a JSON object conforming to
`shadowServiceConfigurationSchema` in `startup.ts`. Only `planTemplates` is optional;
unknown fields and input larger than 16 KiB are rejected.

| Field | Meaning |
| --- | --- |
| `version` | Exactly `shadow-service-configuration-v1` |
| `pythonPath` | Absolute path to the installed locked Python interpreter |
| `modulesPath` | Absolute path to the installed shared Python modules |
| `presenceFile` | Absolute path to the producer's committed presence file |
| `storagePolicy` | Positive integer `maximumRuns`, `maximumPoints`, `maximumBytes` quotas |
| `busyTimeoutMs` | SQLite wait limit, 1–1000 ms, also bounded by each saved execution policy |
| `recoveryIntervalMs` | Recovery and scheduling cadence, 10–300000 ms |
| `recoveryMaximumRuns` | Maximum rows per recovery/scheduling page, 1–100 |
| `planTemplates` | Optional array of up to 8 uniquely named preparation templates; no templates are inferred |

These are schema bounds, not recommended pod budgets. Choose values from measured
qualification evidence. The two database paths come from the application's open
SQLite databases, and the Node host comes from the fixed packaged build location;
neither can be overridden in this configuration. Missing configuration does not
start the service. Invalid configuration, nonpersistent databases or a missing
package leave it unavailable with a generic diagnostic, without exposing paths or
environment values. Setting valid JSON never creates qualification evidence:
every attempt must still match the installed registry and pass fresh admission.

### Durable prospective scheduling

Plans now include `candidateRevisionId`: a saved revision UUID or explicit `null`
for the shipped default. This identity is covered by the plan hash and idempotency
check. Legacy plans remain readable, but the installed execution boundary rejects
missing or mismatched revision identities. Profile resolution still validates the
saved configuration hashes and both acknowledged physical-channel baselines.

The service scans bounded primary-key pages through the installed package's store
at its maintenance cadence, with a separate scheduling cursor. It selects only
pending executable plans with a saved revision whose observation window is open.
Future plans are revisited on later sweeps; terminal, running and legacy plans are
skipped. Each selected run goes through ordinary qualification, admission and lease
claim checks. A selection is not a reservation and cannot bypass cross-process
authority. Scheduled attempts are serialized locally while recovery continues.
Errors are observed and reported without disabling subsequent sweeps.

After restart, pending plans remain schedulable from their durable identity. Running
attempts are never resumed by this queue; expired ones retain their samples and are
failed by recovery. Scan cadence and queue size may delay a start, so coverage is
measured from actual samples and missed windows are recorded explicitly.

## Inspection and cancellation API

The `biometricShadow` tRPC router and corresponding LAN REST endpoints expose:

- `GET /api/biometric-tuning/shadow-runs`: required side, optional `afterId`
  primary-key cursor and `maximumRuns` (1–50, default 20).
- `POST /api/biometric-tuning/shadow-runs`: a complete proposed `plan` and
  `idempotencyKey`. The plan must include candidate revision (or explicit default),
  both active generations/hashes, execution policy and prospective window.
- `GET /api/biometric-tuning/shadow-runs/{id}`: integrity-checked metadata.
- `POST /api/biometric-tuning/shadow-runs/{id}/stop`: durable stop followed by
  awaited local attempt cancellation. Repeated calls preserve terminal evidence.
- `GET /api/biometric-tuning/shadow-runs/{id}/report`: aggregate health, coverage,
  pairing, resource receipt and evidence hashes.
- `POST /api/biometric-tuning/shadow-runs/{id}/compare`: the same report with an
  explicit `reference` import matching the saved sleeper and side. Submitted
  reference measurements are compared without persisting an import.

Inspection and stop use the application's database and remain available without
execution configuration, an installed worker, current health or qualification.
A store opened without storage policy cannot create, claim or append observations.
Metadata includes hashes, window, state, counts and saved candidate identity, but
not waveforms or deployment paths. Legacy missing revision identity is explicitly
distinguished from the shipped default through `candidateIdentitySaved`.

Stopping clears database authority before waiting for local worker cleanup. The
response's `localAttemptSettled` indicates whether a locally owned attempt was
awaited; it does not claim that another process's worker was reaped. Retained
samples and completed/failed results are preserved.

Reports execute in the shipped coordinator process's bounded read lane, leaving
the application's event loop free. They require a complete integrity-checked
snapshot of at most 100000 points and 32 MiB; larger evidence is refused rather
than sampled. The coordinator also enforces its 64 KiB request, 17 MiB response,
384 MiB Node heap and wall-clock limits. These bounds are not claims of measured
pod resource qualification. Reports require the installed coordinator package but
do not launch a waveform processor or require execution qualification.

The public response has an explicit schema. Reference summaries include the
shared normalized import content hash; the report hash covers that summary,
snapshot identity and comparison results. No raw samples or submitted reference
annotations are returned. Agreement remains descriptive, never activation
authorization or an independent holdout claim.

MCP uses these same router operations: `inspect_biometric_calibration` actions
`shadow_runs`, `shadow_run`, `shadow_report` and `shadow_compare` are read-only;
`stop_biometric_shadow` is an explicit idempotent mutation.
`schedule_biometric_shadow` submits a proposed plan through the same creation
operation.

The calibration screen's Observations tab lists runs for the selected side,
shows UTC windows and saved identities, and can record a stop request. Detail
polling ends for terminal runs; list polling continues to discover new work.
Reports are opened on request and refreshed explicitly rather than recomputed
every status poll. They distinguish unavailable coverage/resource receipts from
zero values and show operational issues without implying validated improvement.
The report UI also compares pasted CSV/JSON reference records for the run's saved
side and sleeper identity. It checks the serialized 64 KiB coordinator request
bound, invalidates old results on edits, and prevents overlapping comparisons.
Results show accepted/rejected counts, outside-window exclusions, alignment
offset/tolerance, shared reference pairs, shared-support MAE, each output's
reference coverage and lost/added observation timestamps. Missing scores remain
unavailable; coverage loss and incompatible definitions remain visible. The
comparison is a fresh snapshot, identified separately from the earlier health
report, and does not persist a reference import. Browser verification and
translation-catalog completion remain release work.

### Creation admission

Submitted hashes, generations and policy are assertions, not authority. Creation
loads the verified installed package, checks its Python identity and unique
installed qualification, resolves the stored candidate and acknowledged active
profiles, and observes current hardware and health. It opens admission resources
without claiming a lease, launching a numerical worker or subscribing to sensor
frames. Final admission runs synchronously inside the creation transaction;
failure leaves no queued run. Handles and health sampling close on every exit.
Execution repeats these checks at the actual observation window.

Both active generations are frozen in the plan. A same-hash reset/rollback on
either side invalidates subsequent profile resolution. Legacy plans lacking
candidate or generation identity remain inspectable but are not scheduled by the
installed execution path. Exact idempotent retries return existing evidence before
new Python/health probes; changed requests with the same key conflict. Creation
still requires explicit server deployment configuration and the installed package.
There are no caller-supplied executable paths, numerical configs or health flags.

### Server-side plan preparation

Deployment `planTemplates` supply a bounded ID/label, qualification hash, maximum
window, frozen execution and monitoring policy, joining limits, selected metrics,
optional IBI window and storage ceilings. Their maximum window plus final drain
must fit the worker wall budget; their point/byte ceilings must fit deployment
storage policy. These are explicit operator-installed values, not production
defaults or proof of qualification. No template ships enabled by default.

`GET /api/biometric-tuning/shadow-templates` returns only template IDs, labels and
maximum windows. `POST /api/biometric-tuning/shadow-plans/prepare` accepts template
ID, side, sleeper identity, saved candidate revision (or explicit default) and
start/end times. The verified package checks the template against the installed
qualification registry and manifest, then captures acknowledged active generations
and candidate configuration from owned read-only database handles. Both physical
channel config hashes and the active baseline must match the template's evidence.

The response contains the full frozen plan and hash with status
`prepared_not_admitted`. Preparation opens no waveform source, runs no Python
worker and queues nothing. Fresh installed-build, hardware and health admission
remain mandatory at creation and execution. Changed profiles or generations make
the prepared plan stale rather than silently replacing its inputs.

MCP exposes `shadow_templates` and `shadow_prepare` through the read-only
`inspect_biometric_calibration` tool. Scheduling remains the separate explicit
`schedule_biometric_shadow` operation with its immutable retry key.

The Observations UI now provides template selection, explicit default or saved
candidate selection with profile pagination, sleeper identity and UTC window
inputs. It preserves exact sleeper IDs and subsecond timestamps. Preparation is
a separate action from scheduling, and edits invalidate the prepared review.
The review shows the server-captured window, generations, candidate and plan hash.
No template is invented when deployment configuration is missing.

Scheduling freezes the prepared plan and a random request key. After an uncertain
response, the open form keeps those inputs locked and retries the same request
without re-preparing it. Explicit bad-request or quota rejection unlocks editing;
confirmed saves expose a separate new-plan action and refresh the run list. A
saved request is never presented as proof that execution started. Retry state is
saved before sending in same-origin, per-side session storage, bounded to 64 KiB.
Reloading this tab restores the exact plan and key without preparing or sending
automatically, even if template/profile discovery is unavailable. Confirmed saves
and definite rejections clear the record. A failed storage write prevents sending;
invalid or inaccessible recovery blocks new scheduling while preserving the record.
Closing the tab, clearing browser data, or moving to another origin does not carry
recovery forward. The record contains plan metadata, not reference rows or waveforms.


### Unconfirmed local cleanup

A process-group kill refusal or process cleanup confirmation deadline raises
`SHADOW_CLEANUP_UNCONFIRMED`, preserving the original worker failure as its cause.
This result takes precedence over an earlier cancellation or processing error;
the attempt writes `shadow_worker_cleanup_unconfirmed` when its fenced state
still permits a failure update. Existing terminal operator-stop evidence is not
rewritten. Reports label this failure as unconfirmed cleanup.

The local service quarantines numerical scheduling after that result, while
continuing bounded database recovery. Local cancellation returns false instead
of claiming settlement; ordinary task failures with settled cleanup still release
the slot. The marker is recognized across the separately packaged host boundary.
This is local service state, not durable proof of OS cleanup: restarting a host
must not be treated as verification that old processes are gone.

The supervisor now requires both the direct-child close event and `ESRCH` from
a signal-0 probe of the detached process group within a five-second deadline.
Surviving members, zombies, or persistent permission/observation failures leave
cleanup unconfirmed. Transient unknown observations are retried, never counted
as absence. No probe signals PID/group zero. These checks cover the original
detached group; they cannot prove cleanup of descendants that deliberately escape
into another group. Shipped numerical code must not create such descendants.
The shared kernel lock remains required across hosts.


### Browser demo

The demo implements all eight observation procedures in browser memory. Its
explicitly labeled synthetic heart-rate template supports preparation, scheduling,
exact idempotent retries, side-specific paginated inspection, stopping, reporting
and reference comparison. Plans are accepted only after preparation in this demo
session, and changed profile generations invalidate an unsubmitted plan. Bounds
are 100 prepared plans, 20 runs and 120 samples per run over at most ten minutes.

Synthetic active readings repeat 60/61/62 bpm; candidate readings are one bpm
lower and omit every fourth value. They do not execute the selected algorithm.
The demo shares production report calculations, normalization and reference
alignment, so missing coverage is penalized and incompatible records remain
unscored. Reports include a visible simulation issue, no worker resource receipt,
and no qualification or activation authorization. Synthetic plan identities are
not installed in a production registry. No waveform, hardware, DB or network
adapter is imported into the browser demo graph.

A stop freezes saved synthetic samples. Repeated stop preserves terminal state;
no local process settlement is claimed because the demo has no process. Reloading
resets demo state. A scheduling retry from a previous browser session receives an
explicit bad-request result instead of silently creating a replacement run.


### Partial resource evidence

After supervising cleanup, the child host reports a bounded snapshot even when
processing, input, cancellation or cleanup fails. The last protocol-validated
health reply is retained; it may be absent or stale and is not final CPU usage.
Input bytes count attempted serialized commands; output and diagnostic bytes
count observed transport chunks. RSS is sampled process-group RSS, not an exact
kernel peak; no successful sample is represented by null, never zero. Over-budget
observations remain evidence rather than failing completed-receipt validation.
The observation gap includes the unsampled cleanup tail.

Completed attempts retain the original `biometric-shadow-receipt-v1` format.
Failed/stopped attempts use `biometric-shadow-partial-receipt-v1` in the same
hash-protected receipt columns, tied to run, plan and attempt. Attachment requires
the exact terminal attempt, cannot change its state/reason/end time, and cannot
replace evidence. An identical retry is idempotent. A later receipt timestamp is
allowed because an operator can stop before process cleanup settles. Old attempts
cannot annotate replacement attempts or completed runs. Missing/rejected writes
remain failures; a cleanup-unconfirmed error still quarantines the host even if
storing its receipt also fails. A host crash can leave no receipt; recovery does
not fabricate measurements or proof of cleanup.

Reports expose partial receipts through the existing bounded report route and
show a partial-evidence notice; missing RSS is unavailable. Unconfirmed cleanup
is an issue even when an operator's stop reason remains authoritative. This does
not qualify a candidate, prove exact resource peaks, or authorize activation.


### Shared application background capacity

`runInstalledShadowAttempt` and the coordinator supervisor reserve the same
`globalThis` work slot before starting probes, processes, scans or a shadow claim.
The coordinator's exhaustive task/lane map is shared with its queue: stage and
waveform execution, dataset construction/release, experiment creation, RAW
inspection and artifact cleanup are work. One separately reserved read slot keeps
reports available. The existing queue still bounds requests and wait times;
capacity conflicts return `RESOURCE_LIMIT` before starting work. A busy shadow run
remains pending and the service retries it on a later scan; no historical samples
are invented if its window is ultimately missed.

Ownership lasts until the supervisor settles cleanup. Coordinator completion now
confirms disappearance of the original detached process group after child close,
using the same bounded signal-zero check as shadow cleanup. Unconfirmed cleanup
quarantines that lane instead of admitting replacement work. Ordinary errors
release ownership; cancellation alone does not. Read diagnostics remain available
when the work lane is quarantined. There is no API to clear quarantine: verify OS
cleanup before restarting the application.

This gate bounds the application process across duplicate module bundles; it is
not an OS-wide lock. The existing private kernel flock still excludes numerical
replay and shadow workers across processes. Deployment must retain a single
application owner and retire old worker processes before startup. Independently
launched Node coordinators in another application process do not share this gate.
Production qualification must measure live processing plus one read process and
one admitted work task, including peak RSS, ingestion delay and storage reserves;
this concurrency bound does not replace per-worker or live-health limits.
