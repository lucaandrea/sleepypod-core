# Off-pod algorithm experiments

`executePackageExperiment` runs an inert, hash-verified package in a reviewed
local Docker image selected by an operator policy. It is development tooling,
not a pod API, installation service, or qualification decision. Known pod DAC
socket paths are rejected. Never bundle this runner into the pod web server.

The image must be operator-reviewed and selected by immutable local `sha256:`
ID. The package's dependency-lock artifact uses the
`biometric-python-environment-v1` JSON schema: exact image ID, Python version,
implementation, OS, architecture and the complete sorted installed distribution
inventory. A restricted probe container with no package files mounted collects
that inventory before candidate execution. Any mismatch rejects the experiment.
The result carries the exact lock-byte hash and observed environment hash.
Do not pass a candidate-selected image or policy.

Use `inspectPythonEnvironment(imageId)` to capture a lock from a reviewed image,
then include those JSON bytes as a hashed package artifact. This is an
**environment lock**, not a pip or uv dependency-resolution file; existing uv
locks may also be retained as package artifacts for review. Preparing an image
from the source dependency lock remains an operator's reviewed build step. The
runner never installs dependencies or executes build hooks. The immutable image
ID binds the configuration and layers; inventory verification additionally
makes interpreter/platform/package-version mismatches explicit. See
[Docker image identities](https://docs.docker.com/reference/cli/docker/image/pull/)
and [Python distribution metadata](https://docs.python.org/3.12/library/importlib.metadata.html).
A matching lock does not establish that dependencies or the image are safe.

The process runs as UID 65534 with no network, capabilities, privilege elevation,
or writable root filesystem. Only a fresh verified copy of the package is
mounted, read-only. No pod files, host credentials, Docker socket, or database
are mounted. Docker's default seccomp profile remains enabled. Memory, swap,
PID count, stdout/stderr bytes, input bytes, and a deadline are bounded. The
runner checks that the daemon reports the required limit and seccomp support.
These controls use Docker's [documented container options](https://docs.docker.com/engine/containers/run/).

CPU is restricted to one core and the deadline is the smaller of requested CPU
and wall time, conservatively charging idle time against CPU budget. Scheduler
and kill latency can overshoot the deadline; execution metadata is not a CPU or
peak-memory qualification receipt. Experiments still require measured resource
qualification before any promotion. Use a dedicated external Docker host or VM
with no pod credentials; containers share its kernel and are not a substitute
for maintaining that host's isolation and security updates.

The package entrypoint is a Python executable implementing JSON Lines:

1. Read one `initialize` object with `request` and `runHash`; reset all state and
   initialize deterministically from the explicit seed/configuration.
2. Read each `frame` object with `frame` and `frameHash`.
3. Write exactly one `biometric-metric-frame-v1` response line per input frame.
4. Exit successfully at stdin EOF. Logs may go to stderr within the same total
   output budget. Additional stdout is an error.

Only one frame is in flight. Host validation runs before sending a frame and
before retaining its response. The caller supplies a trusted synchronous frame iterator. Before starting the
candidate, the runner writes canonical frames to a private bounded file and
checks their domain-separated SHA-256 hash against the request's `inputHash`.
The file is not mounted into the container; only one frame at a time is sent
from that frozen copy. The hash encoding is UTF-8
`biometric-package-input-v1\n` followed by each canonical frame plus LF.
Input hash validation does not establish a clinical reference or holdout split;
those associations still need the qualification dataset pipeline.
Package files and outputs are never imported as host code. Cleanup removes the
owned container and staging directory on normal completion and caught errors;
hard host termination still needs stale-job recovery before this can become a
durable service. No arbitrary dependency installation occurs during execution.

Run the opt-in Docker regression tests with a reviewed Python image:

```sh
BIOMETRIC_EXPERIMENT_TEST_IMAGE=sha256:<local-image-id> pnpm exec vitest run scripts/algorithm-experiments/container.test.ts
```

The tests cover a valid exchange, filesystem/network/environment/PID probes,
output floods, memory exhaustion, deadlines, and invalid results. They do not
qualify any biometric algorithm or prove resistance to kernel vulnerabilities.

## Determinism evidence

`checkPackageDeterminism` runs the same manifest, byte snapshots, request and
operator policy two to five times, with a fresh container each time. Its trusted
frame factory must reproduce the retained input: every run independently
verifies that hash. It hashes every response, including serialized state, in
order using the `biometric-package-output-v1` domain. Execution timings and
transport measurements are excluded from the output identity.

The result records run/input/output identities and execution metadata. A
changing state fails even when numeric readings are identical. A deterministic
result is only one qualification dimension: it does not approve dependency
compatibility, resource fitness, artifact/noise behavior, held-out agreement,
shadow use, installation, or live activation. Those checks and reviewed release
promotion remain required.

## File-based command line

Run these commands on the external experiment host, from the repository:

```sh
pnpm biometrics:experiment lock sha256:<reviewed-local-image-id> environment.lock.json
pnpm biometrics:experiment inspect proposal.json intake.json
pnpm biometrics:experiment input-hash frames.jsonl 33554432 input-identity.json
pnpm biometrics:experiment run proposal.json request.json frames.jsonl operator-policy.json experiment.json
pnpm biometrics:experiment determinism proposal.json request.json frames.jsonl operator-policy.json 2 determinism.json
```

The proposal is a single inert JSON envelope with `schema` equal to
`biometric-package-proposal-v1`, a complete `manifest`, and `files` containing
`{ "path": "engine.py", "base64": "..." }` entries for every declared artifact.
Include the captured environment lock as the manifest's `dependencyLock` file;
its exact bytes, like all package files, must match the artifact size and hash.
`inspect` verifies the proposal without launching Docker or executing its code.

`frames.jsonl` contains one `biometric-signal-frame-v1` object per line.
`request.json` follows `packageRunRequestSchema` in `protocol.ts`: set its
`packageHash` from the intake report and `inputHash` from the input-identity
report, plus explicit hardware, sample rate, side, configuration, and seed.

`operator-policy.json` is separate from candidate artifacts and contains the
reviewed image ID and positive integer ceilings: `maximumWallMs` (at most one
hour), `maximumMemoryBytes`, `maximumProcesses`, `maximumOutputBytes`, and
`maximumInputBytes`. Select these for the external host; they do not establish
that an algorithm fits the pod. Candidate resource requests must fit the policy.

All file inputs must be bounded regular files, not symlinks, devices or FIFOs.
JSONL has a separate per-line cap. Reports are mode 0600, written completely
before atomic publication, and never overwrite an existing path. Errors return
nonzero and do not publish a success report. The report includes raw candidate
outputs and should be treated as private biometric data. No command sends it to
a reviewer or installs the package. A successful `run` is explicitly marked
`experiment_only`; use the remaining qualification checks and normal reviewed
release process before promotion.
