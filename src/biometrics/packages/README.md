# Algorithm package proposals

`manifest.ts` validates inert proposals for the algorithm-development workflow.
It does not import, execute, install, or approve their code. No API currently
accepts these proposals, and there is no package runtime or isolated worker yet.

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
A future transport must enforce size limits before buffering. Dependency-lock
syntax and actual dependency resolution must be checked in the isolated worker;
intake only verifies its identity.

Execution must use an external isolation boundary without pod credentials,
network access by default, writable input, or access to live sinks. Resource
requests must be checked against server-owned limits and enforced outside the
candidate process. Deterministic replay, artifact/noise fixtures, resource
measurements, held-out comparisons, and compatibility checks remain required.
An experiment result never grants installation rights: promotion goes through
code review and a release into the shipped registry.
