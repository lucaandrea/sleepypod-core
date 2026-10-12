# Biometric runtime activation protocol

`requestManualActivation` is the configuration transaction for an explicitly
unvalidated manual change. It checks side, exact revision/hash, expected binding
generation and idempotency key before committing the binding, audit event and
immutable outbox payload together. A missing legacy migration prevents a new
binding from discarding existing stage personalization. Reset selects the
current shipped default; rollback selects the previous binding and remains a
distinct audited action. Neither operation deletes revision history.

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

The Node services are not yet connected to startup or the stage reader.
Public activation remains unavailable until those consumers, fallback auditing
and full acknowledgment have been implemented and verified.
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
receipts are separate from the still-pending stage consumer. Heartbeats are
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
prevents custom adoption and preserves legacy writes. Persisted fallback audit
and the Node supervisor remain outstanding.
