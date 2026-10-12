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

These services are not yet connected to startup, the stage reader, or Python
boundary adoption. Public activation remains unavailable until those consumers,
fallback behavior and actual acknowledgment have been implemented and verified.
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
These primitives are tested but are not yet wired into the live daemon.
