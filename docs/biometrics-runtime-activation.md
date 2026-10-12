# Biometric runtime activation protocol

`requestManualActivation` is the configuration transaction for an explicitly
unvalidated manual change. It checks side, exact revision/hash, expected binding
generation and idempotency key before committing the binding, audit event and
immutable outbox payload together. A missing legacy migration prevents a new
binding from discarding existing stage personalization. Reset selects the
current shipped default; rollback selects the previous binding and remains a
distinct audited action. Neither operation deletes revision history.

An explicit reset can recover malformed legacy stage data that cannot pass the
stage-classifier schema. The original legacy row remains untouched, and the
reset event preserves its value as `evidence.preservedLegacyClassifier` with
`recovery: "invalid_legacy_reset"`. This is audit data, never an executable
profile revision. The binding, evidence and default outbox payload commit
atomically; a publication failure leaves the original state intact. Valid
legacy customizations still require migration before any new binding, including
reset. Recovery does not claim processor adoption.

For a bound revision whose engine is unavailable, the web recovery view shows
its preserved revision ID and the current default recovery hash. It cannot
produce a valid before/after diff of the unavailable engine and explicitly says
so. The user can request an acknowledged, generation-checked reset to defaults;
the old revision remains the previous binding. Rollback to that revision still
requires its engine to be compatible and never silently substitutes defaults.

`projectRuntimeConfig` validates the manifest/configuration identity and writes
an immutable side/generation projection into the biometrics database. Duplicate
identical delivery succeeds; a different payload for an existing generation
fails. `deliverRuntimeOutbox` acknowledges delivery only after projection.
Transient failures retry with capped exponential delay; invalid envelopes fail
visibly. These are separate database transactions, so a crash after projection
is handled by idempotent redelivery rather than assumed cross-database atomicity.

`repairCurrentRuntimeProjections` restores the latest authoritative delivered
payload after biometric history has been cleared. It preserves configuration
ownership and does not manufacture runtime receipts.

`reconcileActivation` considers only receipts matching the desired generation
and exact bundle hash. Heart-rate, breathing-rate, HRV-index and sleep-stage
components must all report applied with an effective timestamp before the
activation is marked applied. Old-generation or wrong-hash receipts cannot
acknowledge a newer binding. A final generation check fences concurrent intent
changes while reconciling.

The Node startup hook starts one `globalThis` coordinator after migrations.
Every five seconds it migrates legacy stage personalization, repairs delivered
projections, delivers pending intents and reconciles receipts. Shutdown stops
its timer. Public manual activation, reset and rollback submit exact intent;
status polling remains read-only. Availability does not assert processor health
or adoption. The cross-runtime fixture verifies the public request → Python
boundary → stage receipt → restart → rollback handoff.
There are no hardware-command paths in these services.

The Python `common.biometrics.runtime` reader independently validates the latest
projected payload, its envelope, shipped manifest and resolved hash. Reads are
bounded before materializing SQLite text. Missing tables, corrupt newest
generations and incompatible engines surface errors; the reader neither creates
schema nor silently selects an older generation. Snapshots retain immutable
configuration bytes and return fresh decoded values.

Its two-phase boundary selector allows immediate changes at the caller's next
sample boundary and next-session changes only when occupancy is explicitly
false. Unknown occupancy, including an uninitialized restart, does not count as
an empty bed. Newer requests supersede pending ones, stale generations fail, and
a late commit cannot acknowledge a superseded selection. The caller must install
the selected configuration before committing selection and writing receipts.
The live piezo daemon now uses these primitives through `runtime_adapter.py`.
It polls projections every five seconds, installs configurations before ingesting
an accepted dual-channel frame, and writes receipts only after both channel
buffers have accepted that frame. Heart-rate, breathing-rate and HRV-index
receipts are separate from the stage-view consumer's acknowledgment. Heartbeats are
bounded to once per thirty seconds unless the applied configuration changes.

In single-sleeper mode both physical channels use the home side's profile.
Each computed candidate carries its immutable processing context through
quality arbitration and write retries, including its original logical side and
physical source channel. The observation, quality row and processing bundle
commit in one SQLite transaction. Retained contexts recreate their processing
bundle after history reset. This does not imply raw input retention: provenance
explicitly labels raw identity unavailable and timestamps as processing-clock
based. Measured sensor calibration is not consumed by this numerical path and
its calibration hash remains null.

Numerical changes reset sample buffers, tracking and presence state; stage-only
changes preserve numerical state. Routing changes reset state to prevent mixing
sleepers. A restart restores only a compatible projection previously acknowledged
by all three numerical components, with fresh estimator warmup. Pending
next-session requests still require known empty occupancy. Invalid projections
retain the actual compatible configuration and report degraded module health;
an incompatible restored configuration falls back to defaults. Missing schema
prevents custom adoption and preserves legacy writes. The coordinator records
fallback intent separately from the consumer receipts proving its adoption.

The stage reader selects the newest projection for which all three numerical
components acknowledged the exact bundle hash and an effective boundary. Partial
adoption of a newer generation keeps the prior view. Reading the classifier for
use in the client or server records the stage-consumer receipt; merely inspecting
profile overview or enqueueing a backtest does not. No stage receipt is generated
by the background coordinator. Until a consumer requests the new view, the
activation can truthfully remain pending.

`getClassifier` exposes the applied classifier and provenance separately from a
pending desired classifier. The editor retains pending edits and polls for
adoption. `getSleepStages` includes the selected view with classified results;
its interpretation is explicitly `current_classifier_view`, since the rules
rescore original readings rather than replace historical observations. Backtest
current-stage baselines use this same applied view.

Legacy `setClassifier` writes now use the profile service and durable outbox.
They retain HR, breathing and HRV overrides, and null clears only stage overrides.
The response retains classifier/isDefault fields and adds pending activation
identity. Existing legacy columns remain migration baselines, never a second
writable authority. These changes are manual/unvalidated. Demo responses label
simulated adoption explicitly.

`recoverRuntimeIntent` handles obsolete defaults, missing intent and unavailable
pinned engines. It publishes a new generation and audit event atomically with
its outbox payload. Fallback preserves the desired pinned revision, immutable
revision history and the previous rollback target. Repeated recovery passes are
idempotent. If that same pinned engine becomes compatible again, restoration
waits for the next session. Repair of a lost custom boundary also defaults to the
next session. The fallback explanation survives acknowledgment and remains
visible in the stage view and desired-profile warning.

A conflicting biometric projection is retained for diagnosis and its delivery
marked failed. The next recovery pass creates a new generation; it does not
rewrite the conflicting immutable snapshot. Missing projections after history
reset are simply redelivered with their original identity.

Profile overview includes numerical processor health separately from historical
adoption. All three components must report the same generation/hash and a
heartbeat no more than 120 seconds old to be current. Missing components,
incomplete adoption, failures, future timestamps and mixed generations are
reported explicitly. The retrospective stage consumer is on demand and is not
subject to that continuous heartbeat test. This reports health; it does not
claim an old activation was never applied or automatically switch algorithms.

`biometricTuning.listActivationHistory` / `GET /biometric-tuning/activations`
returns side-scoped audit events, fifty per page using a generation cursor.
Results include exact hashes, revision identities, evidence and fallback reason;
internal request hashes and idempotency keys are omitted.
