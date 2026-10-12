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

Activation is deliberately reported unavailable until processor projection,
acknowledgment and rollback are integrated. Desired profile state must not be
presented as actual runtime adoption.

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

The host loop, measured resource admission, richer promotion reports, live
activation, and client UI/MCP integration are still separate implementation
steps. The API does not claim that these are enabled merely because job
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
