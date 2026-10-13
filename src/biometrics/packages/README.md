# Algorithm package proposals

`manifest.ts` validates inert proposals for the algorithm-development workflow.
It does not import, execute, install, or approve their code. No API currently
accepts these proposals. The [off-pod experiment workflow](../../../scripts/algorithm-experiments/README.md)
provides Docker execution, deterministic/noise checks, managed whole-night
comparisons, resource assessments and combined external qualification evidence.
That evidence cannot install code. Promotion requires representative-fixture
review, matching target-pod and prospective evidence, and a reviewed release
into the shipped registry.

The versioned manifest declares engine identity, frame schema identifiers,
metric definitions and units, supported hardware/sample rates, causal or
retrospective behavior, deterministic initialization and reset, JSON state
serialization, resource requests, an entrypoint, and a dependency lock. Every
file is listed with its exact byte length and SHA-256 digest. Package identity
is SHA-256 over the complete manifest using `finite-binary64-json-v1` canonical
JSON. Artifact array order is part of that identity.

`verifyAlgorithmPackage` takes a map of bytes, avoiding filesystem resolution
or archive extraction. It rejects unexpected files, missing files, mismatched
sizes/hashes, traversal paths, duplicate identities, and oversized proposals.
The 32 MiB intake ceiling is a storage bound, not a qualified runtime budget.
A future transport must enforce size limits before buffering. Intake verifies
only the dependency-lock artifact identity. The external
executor additionally requires an exact Python environment lock and independently
probes its reviewed runtime image; see the executor README for that format.

Execution must use an external isolation boundary without pod credentials,
network access by default, writable input, or access to live sinks. Resource
requests must be checked against server-owned limits and enforced outside the
candidate process. Deterministic replay, artifact/noise fixtures, resource
measurements, held-out comparisons, and compatibility checks remain required.
An experiment result never grants installation rights: promotion goes through
code review and a release into the shipped registry.

## Streaming frame contract

`protocol.ts` defines the host-side exchange. A run names the exact package and
input hashes, hardware, sample rate, side, seed, and finite JSON configuration.
Its canonical hash binds all those choices. Create a fresh validator and reset
candidate state for each independent run; never carry state between nights or
qualification repetitions unless a future protocol explicitly declares it.

Frames carry increasing sequence numbers from zero, explicit sample-start
timestamps, one or both channels of at most 4096 finite samples, and explicit
nullable occupancy/pump context. Missing context is unknown, not false.
Channels must agree in length. Sample duration determines the next permissible
frame time; gaps are permitted, overlaps are rejected. The executor must call
`validateFrame` before exposing each frame to the candidate.

A response echoes the run hash, canonical input-frame hash, and sequence. It
contains bounded numeric/null metric readings and JSON state. The host checks
metric definitions, side, ranges, strictly increasing timestamps per metric,
observed time bounds, declared retrospective lookahead, state bytes, and the
cumulative canonical response-byte budget. Validation failure does not advance
the run. No response can authorize database or hardware writes.

The external executor must bound transport bytes before JSON decoding (including
whitespace), enforce process resources independently, and expose only the current
frame and previously returned state. The validator cannot prove that code obeys
causality, initialization, reset, or determinism; those need the executor and
repeated qualification runs. This protocol is not itself an isolation boundary.

A metric can optionally declare a structured `reference` contract for external
comparison: `metric` is one of `heart_rate`, `breathing_rate`,
`window_ibi_variability_v1`, `hrv_rmssd`, or `hrv_sdnn`; `windowMs` is required and
may be null only for non-HRV metrics. The declaration requires canonical units
and participates in package identity. Metrics without this declaration remain
valid experimental outputs but cannot enter reference comparison based on their
name or prose definition alone.
