# Biometric calibration API

The `biometricTuning` tRPC router and `/api/biometric-tuning/*` OpenAPI routes
share the same services. They use the existing LAN trust model. Supplied
requester names are attribution, not authenticated identities.

## Inspect and create profiles

- `getManifest` returns the versioned default, parameter schema and current
  manifest hash.
- `getProfileOverview` separates desired configuration, the existing stage
  view, sensor-calibration freshness, and observed runtime receipts. No receipt
  means unreported, not applied. A legacy stage customization awaiting migration
  remains visible.
- `resolveProfile` validates explicit leaf/ordered-array overrides and returns
  the resolved snapshot, hash and override provenance without saving anything.
  Omit a path to restore inheritance; null does not mean remove.
- `createProfileRevision`, `getProfileRevision`, and `listProfileRevisions`
  create and inspect immutable candidates. Creating one does not bind it or
  write an activation outbox event. Public origins are manual or agent;
  migration/system origins are reserved for server workflows.

Manual activation is available. Desired profile state must not be presented as
actual runtime adoption; availability means requests can be queued, not that a
processor is currently healthy or has adopted a particular revision.

## Retain data and submit work

`listSessions` is cursor-paginated and side-specific. `getSessionCapabilities`
reports actual processed timestamp coverage, gaps, reference metric counts,
and unknown processing provenance. Raw waveforms are marked not inventoried;
the presence of processed readings does not imply signal replay capability.
Reference counts include revisions, so dataset creation requires explicit
import IDs and accepts only one revision per family.

`createDataset` takes side, asserted sleeper ID, session IDs, reference import
IDs, and an idempotency key. The server pins the configured device timezone.
`getDataset` and `listDatasets` return metadata/manifests, not the retained raw
rows. Snapshot integrity is verified on a dataset read. Reference deletion and
observation retention do not change an existing snapshot.

`createExperiment` pins a dataset and descriptive protocol: evaluation mode,
explicit assumed stage-calibration quality, and fixed alignment tolerance and
clock offset. `enqueueBacktest` takes the experiment ID, exact candidate
revision ID, expected binding generation, split, and idempotency key. Callers
cannot supply default/current snapshots, evaluator hashes, or executable paths.
The server resolves them. The current stage baseline comes from the actual
retrospective view, not a pending desired vitals profile.

The current evaluation scopes are original-reading comparison and stage rules
on original readings. Waveform parameter changes are not evaluated by these
scopes. The job descriptor states this explicitly.

`listBacktests`, `getBacktest`, `cancelBacktest`, and `getBacktestResult` expose
bounded job history, progress, cancellation and verified results. Enqueue
persists work; an admitted worker host must execute it. A queued response is
not a completed result or an activation. Result reads include the current
holdout exposure count. Existing successful retries return the original job
when the same public submission key and payload are supplied.

`getBacktestSummary` (`GET /biometric-tuning/backtests/{id}/summary`) is the
interactive review path. It verifies the complete report in the coordinator,
then omits stage-trace rows before IPC and HTTP serialization. All scores,
per-night comparisons, support, provenance, and operational measurements remain.
Its `projection` is `scores_without_stage_trace_rows_v1`; `contentHashScope` is
`complete_retained_report`. The hash identifies the retained full artifact,
not the summary's serialized bytes. Summaries exceeding 2 MiB fail explicitly
rather than silently truncating nights or scores. `getBacktestResult` continues
to return the full verified report, and `getBacktestTrace` pages exact trace
rows using that same retained hash. The UI and MCP report reader use the summary
path; release and holdout exposure semantics are unchanged.

The backtest host loop, measured resource admission, richer promotion reports,
and full client UI/MCP integration remain separate implementation steps. The API does not claim that these are enabled merely because job
submission exists.

Profile diffs report both changed resolved values and changed override intent,
including explicit-default overrides whose numerical output is unchanged.
`validateProfileRevision` checks schema/engine compatibility only; it explicitly
leaves evaluation evidence unchecked.

Experiment creation requires an idempotency key. `getExperiment` and
`listExperiments` preserve access to its frozen protocol and audit identity.

`releaseDataset` is explicit and idempotent. It refuses release while queued,
running, cancellation-pending, or interrupted jobs still need the inputs.
After cancellation or completion, release removes the retained input snapshot,
keeps its manifest/hash and holdout audit metadata, and marks it unavailable.
Existing reports remain separate retained results. New runs cannot use a
released dataset; a fresh snapshot requires a fresh creation key. Storage
accounting continues to include the retained manifest. Active configuration
lives in the configuration database and is unaffected.

Canonical dataset/report hashing uses the same finite-number encoding as
configuration hashing, with a separate bounded budget for realistic multi-night
rows. Configuration limits remain unchanged. Dataset hashes are checked when
reading retained input data, and metadata reads verify available snapshots;
released metadata remains readable without pretending inputs still exist.

Activation history is available through `listActivationHistory` (side and
optional `beforeGeneration` cursor). Pages contain at most fifty events and
include fallback/default-update evidence. Profile overview separates its
historical receipts from `runtimeHealth`, which reports current numerical
heartbeat freshness and configuration consistency. General and legacy stage
settings use the same versioned intent and acknowledgment protocol.

## Manual activation and observation

- `activateProfile` / `POST /biometric-tuning/activate` selects an exact revision.
- `resetProfile` / `POST /biometric-tuning/reset` selects current shipped defaults
  without deleting revisions or audit history. Malformed unmigratable legacy
  stage settings are retained in the legacy row and reset audit evidence; valid
  unmigrated customizations must first be preserved as a revision.
- `rollbackProfile` / `POST /biometric-tuning/rollback` selects the previous
  binding, including its exact revision identity (null means the default binding).

All three require side, expected binding generation, expected resolved hash,
immediate/next-session boundary, requester, idempotency key, and explicit
`allowUnvalidated: true`. These are deliberate manual changes, recorded as
`manual_unvalidated`. They do not assert that a backtest established improvement.
A stale binding, changed idempotent request or mismatched hash is a conflict.
Creating or evaluating a candidate never calls these mutations implicitly.

`getActivationStatus` / `GET /biometric-tuning/activation-status` accepts a side
and optional event ID. It returns the persisted audit event, observed delivery
and matching-receipt state, receipt freshness and whether the event still
belongs to the desired generation. Polling is read-only and cannot acknowledge
the stage consumer. The persisted event can lag observed receipts until the
five-second reconciliation pass. An applied old event is history, not proof it
is still selected; check `isCurrent` and the overview's current runtime health.

The cross-runtime integration test uses temporary fixture databases and the
locked piezo environment. Prepare it with
`cd modules/piezo-processor && uv sync --locked --no-install-project`, then run
`pnpm exec vitest run src/biometrics/profiles/tests/runtime-integration.test.ts`
from the repository root. The JS unit-test CI job installs that same environment.
The test runs the shipped Python adapter with a synthetic frame, verifies the
next-session boundary, TypeScript stage receipt, restart restoration and rollback;
it neither starts a sensor follower nor accesses hardware.

## Releasing completed reports

`releaseBacktestResult` (`POST /biometric-tuning/backtests/{id}/result/release`)
requires the job ID and `expectedContentHash`. It applies only to successful
jobs and rejects a mismatched hash. Repeating the same release is idempotent.
The result endpoint now includes `available` and nullable `releasedAtMs`.
After release it returns `available: false`, `report: null` and the original
content hash, completion time, winning fencing token and current holdout count.
A released report is distinct from a job that has not completed (which still
returns null as the whole result).

Release removes inline payload bytes or detaches an artifact descriptor in a
transaction before deleting the file. It does not erase experiments, jobs,
holdout exposure, profile revisions or activation history. A retried enqueue
with the same idempotency key still resolves to the original successful job;
it cannot recreate released bytes or erase previous holdout use. A new replay
requires a new request key and available retained inputs.

The additive biometrics migration `0027_release_backtest_reports` preserves
existing reports with a null release timestamp. Older readers cannot validate
a released payload against the original hash, so they report an unavailable or
corrupt result rather than silently displaying different data. UI/MCP clients
must use the explicit availability fields when presenting released evidence.

## Paginated stage traces

`getBacktestTrace` (`GET /biometric-tuning/backtests/{id}/trace`) requires
`expectedContentHash` and `configuration` (`default`, `current`, or `candidate`).
It accepts an optional `cohortId`, an `offset` (default zero), and `limit`
(default 200, maximum 500). The hash must match the verified retained result.
Unfinished jobs reject trace requests, changed hashes return a conflict, released
reports return not found, and comparison-only runs report that no stage replay
was produced. Missing cohorts/configurations and cursors beyond the selected
trace are errors rather than fabricated empty results.

The response includes exact intervals, configuration hashes/revisions, cohort
and source-window identities, the total selected interval count, and
`nextCursor: { offset, contentHash }` or null. Reuse that offset and hash as
`offset` and `expectedContentHash`, keeping the selection unchanged. No
intervals are downsampled or interpolated. Trace timestamps precede the fixed
reference-alignment offset, which is returned separately as `clockOffsetMs`.
The provenance is explicitly `versioned_stage_replay`, not original observed
stages. Filtering/pagination never changes evaluation scores.

This bounds response detail, not artifact-read cost: the service currently
verifies the entire retained report before selecting a page. Parent-process
artifact parsing and hashing remain part of the target performance qualification.


## Retained waveform discovery and publication

`getReplayAdmission` (`GET /biometric-tuning/replay-admission`) reports whether
server policy is configured, its operator-supplied qualification ID, and current
admission reasons. `SLEEPYPOD_BIOMETRICS_ADMISSION_POLICY` is server-owned JSON
matching `admissionPolicySchema`; missing or malformed policy denies admission.
Supplying an ID does not itself qualify hardware. Each check uses fresh process,
storage, thermal, and live piezo receipt evidence; no caller can supply health
samples or override admission through an RPC parameter.

`inspectRawSource` (`POST /biometric-tuning/raw-sources/inspect`) accepts only
`afterName`, initially null, and inspects at most one server-owned archive.
Persisted evidence is a mutation even though scanning does not modify the
archive. Reuse `nextCursor` until `complete`; `source_unavailable` advances past
an unreadable source, and `archive_unavailable` reports a missing archive root.
`deferred` preserves the cursor and means no new scan was admitted. This API
accepts neither filesystem paths nor executable code.

`listRawSources` (`GET /biometric-tuning/raw-sources`) accepts `startMs`, `endMs`,
and optional `afterId`, returning at most fifty descriptors and a cursor. Query
all selected cohort windows including five minutes of pre-roll. Catalog event
bounds indicate possible overlap, not continuous support. Descriptors explicitly
say `requires_reverification`; inventory alone has not retained any waveforms.

`createWaveformDataset` (`POST /biometric-tuning/waveform-datasets`) accepts a
parent dataset ID, its exact `expectedContentHash`, an idempotency key, and
`cohorts: [{ cohortId, sourceIds }]`. The server derives context from that frozen
parent, re-verifies selected archives, and atomically retains inputs and publishes
the immutable dataset. New publication requires ongoing admission; a `deferred`
response contains no dataset. A retry of already committed publication returns
the original descriptor even when current admission is unavailable or original
archives have disappeared. Changed selections under the same key conflict.
Released descriptors remain released; retries never recreate their bytes.

Create a `signal_replay` experiment using the published dataset, then submit and
poll a durable backtest. Publication does not start a worker host or activate a
profile. Host qualification and scheduling remain separate operational gates.


The retained-dataset UI exposes **Select recorded waveforms** on available
processed datasets. It inspects one archive per explicit request, keeps scan
cursors on deferral, and preserves source selections across pages and nights.
Every parent cohort requires a selection, with at most 64 source IDs per cohort.
Publication pins the parent content hash and reuses its request key after a lost
reply or deferral. Released publication retries are shown as unavailable.

Published waveform datasets offer **Replay retained waveforms** in the protocol
editor. Sleep-stage replay is optional and requires an explicit calibration
quality assumption; numerical-only replay does not. Protocol creation and queued
submission still depend on the separate worker host for execution. The browser
demo contains no RAW archive fixture or qualified pod telemetry, so its waveform
operations remain explicitly deferred.

### Numeric objective policies

Signal-replay protocols may pin an `objectivePolicy` with version
`numeric-objective-v1`. Its metric, minimum supported nights and paired references,
maximum lost-observation fraction, minimum MAE improvement, night and subgroup
regression tolerances, required subgroup names, and operational limits are included
in the protocol hash. Processed-reading protocols reject numeric objectives.
Reports retain the thresholds and per-baseline `objectiveAssessments`.

Caller-supplied thresholds are not a designated promotion policy. The current
production evaluator has no designated policy and does not yet attach measured
operational or subgroup evidence, so its assessments remain insufficient evidence.
The pure assessor checks an independent first-use holdout, supported whole nights,
uncertainty, coverage, subgroup regressions, and measured operational limits before
it can award improvement under a designated policy. Test-only thresholds exercise
boundaries; they are not release defaults or evidence of clinical validation.
