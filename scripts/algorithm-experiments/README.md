# Off-pod algorithm experiments

`executePackageExperiment` runs an inert, hash-verified package in a reviewed
local Docker image selected by an operator policy. It is development tooling,
not a pod API, installation service, or qualification decision. Known pod DAC
socket paths are rejected. Never bundle this runner into the pod web server.

The image must contain Python and dependencies built from the package's lock.
The runner requires an immutable local `sha256:` image ID, but does not yet
verify that the installed dependencies match the lock. That remains a required
qualification step. Do not pass a candidate-selected image or policy.

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
before retaining its response. The caller supplies a trusted synchronous frame
iterator and is responsible for binding it to the declared retained input hash.
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
