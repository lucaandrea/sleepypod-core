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
The host staging parent stays mode 0700, with frozen input mode 0600. Only its
`package/` subdirectory (0755, files 0444) is bind-mounted read-only. The container
UID can traverse that mount without granting other host users access through the
private parent. An opt-in real-Docker test verifies these modes after container
creation, successful execution as UID 65534, and removal after completion.
Package files and outputs are never imported as host code. Cleanup removes the
owned container and staging directory on normal completion and caught errors;
hard host termination is handled by the explicit container recovery sweep
described below, followed by ownership-checked private staging recovery. No arbitrary dependency installation occurs during execution.

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

## Host resource observations

Experiment reports now include `execution.measurements`, collected from the
Docker Engine stats API on the host, never from candidate output. The collector
uses the actual created container ID, validates each response's identity, and
records observed cumulative CPU milliseconds, memory bytes including cache,
and process counts. It attempts sampling every 250 ms without overlapping
requests, and requests a final sample while the candidate is still waiting for
stdin EOF. Reads have time and byte limits.

The receipt records attempts, usable samples, and maximum gaps including
startup and shutdown. Missing, stale, or regressing samples leave it incomplete. Memory is an observed peak,
not an exact lifetime high-water mark; CPU is the largest observed cumulative
counter, not a guaranteed final lifetime total. A process may consume resources
between samples. The collector's overhead counts toward the experiment's wall
deadline. Qualification must inspect coverage and gaps and retain these limits.
No fit-for-pod decision is inferred from measurements on an external host.

Currently measurement supports local Unix Docker endpoints and API 1.41 or
newer. Unsupported transports or failed observations leave nullable counters
and incomplete evidence; they do not fabricate zero usage or waive the existing
container resource limits. See the [Docker stats API](https://docs.docker.com/reference/api/engine/version/v1.51/).

## Artifact/noise fixture suites

```sh
pnpm biometrics:experiment fixtures proposal.json suite.json operator-policy.json fixture-report.json
```

A reviewed suite uses `biometric-package-fixtures-v1` and a `fixtures` array.
Each fixture has a unique `id`, `category`, full run `request`, inline signal
`frames`, and `expectations`. Its request must bind the proposal and actual
frame hashes. The suite file is bounded to 32 MiB; inline fixtures are intended
for focused signal tests, not whole-night held-out comparisons.

Expectation windows use inclusive `startMs`, exclusive `endMs`, and a declared
`metric`. A `numeric` expectation specifies `minimum`, `maximum`,
`minimumReadings`, and `minimumQuality`. Missing/null readings cannot satisfy
numeric coverage. An `abstain` expectation permits absent or null output and
rejects numeric values. Duplicate readings, unexpected metrics/times,
out-of-range values, low quality, insufficient coverage and overlapping
expectations fail. Windows must fall inside the supplied input interval.
Clean-signal fixtures must require numeric output; empty-bed fixtures must
require abstention.

Each fixture executes in a fresh isolated container. Reports retain the suite,
fixture, input and output identities, the complete frozen suite with frames and
expectations, execution output, independent resource observations and failures.
A crashed or invalid-output case remains a failed case in the report.

Required category coverage is `clean_signal`, `pump`, `empty_bed`, `motion`,
`cross_side`, `harmonics`, `gaps`, `warmup`, and `boundary_reset`. Omitted categories
make an otherwise passing report `incomplete`. All covered checks passing yields
`fixture_checks_passed`, never automatic qualification or installation. Category
labels do not prove that a signal realistically represents that condition:
review the exact hashed suite and its expected behavior. The test suite includes
synthetic clean/empty-bed examples to verify this workflow; representative
shipped-algorithm fixtures, held-out agreement, compatibility and pod resource
qualification remain separate requirements.

Each fixture suite also requires an explicit reviewed `resourcePolicy` with
schema `biometric-package-resource-policy-v1`, `maximumWallMs`, `maximumCpuMs`,
`maximumMemoryBytes`, `maximumProcesses`, `minimumSamples`,
`maximumObservationGapMs`, and `evidenceMode` equal to
`sampled_counters_and_enforced_limits`. There are no production default
thresholds. The policy is part of the frozen suite hash and every per-case
resource assessment records its own policy hash.

An assessment can be `within_observed_limits`, `insufficient_evidence`, or
`failed`. It requires consistent host receipts, adequate sample count and gaps,
and enforced limits no wider than the reviewed budget. Known wall, observed
CPU/memory/process, or enforced-limit overruns fail even when sampling is also
incomplete. Missing measurements never mean zero cost. A passing signal check
with incomplete resource evidence makes the overall fixture report incomplete;
a resource failure makes it fail. These sampled observations plus hard limits
still do not establish exact lifetime costs or target-pod fitness.

## Reference comparison

```sh
pnpm biometrics:experiment compare comparison-input.json comparison-report.json
```

This command reuses the application's reference normalization, point/interval
alignment, and common-support numeric comparison. The input uses schema
`biometric-package-comparison-v1`, a `metricId`, whole-night `startMs`/`endMs`
(up to 24 hours), explicit `minimumQuality`, raw `referenceImport`, frozen
`alignment`, and exactly three `outputs` labelled `default`, `current`, and
`candidate`. Each output supplies its `manifest`, run `request`, and complete
executor `result`. Inputs are bounded to 32 MiB. Run IDs include configuration;
reported baseline/candidate hashes in the shared comparison are those run IDs.

Each selected manifest metric must declare a `reference` contract with a
supported metric definition and nullable `windowMs`. HRV definitions require
an explicit window, and units must be canonical (`bpm`, `breaths/min`, or `ms`).
A free-text description or a coincidentally matching output name is insufficient.
All packages must agree on that contract, input identity, hardware, sample rate,
side and input-frame sequence. Different HRV definitions or windows cannot be
compared as the same metric.

Reference rows are normalized using the shared adapter. Out-of-night rows and
compatibility exclusions are reported explicitly. Comparisons use identical,
unambiguous observation timestamps shared by all three runs before reference
pairing; rejected/low-quality readings remain missing support, never filled
values. MAE, bias and coverage differences are descriptive reference agreement.
The command does not trust file-provided results as execution attestations,
record holdout access, estimate whole-night uncertainty, designate an objective,
or authorize promotion. Those require the authoritative experiment/qualification
workflow, not a report assembled from arbitrary files.

## Durable study ledger (orchestration component)

`PackageExperimentLedger` maintains frozen study identities, exact trial
requests, idempotency keys, expiring worker leases and report hashes in a
**dedicated off-pod SQLite database**. Its generated schema and migrations are
under `src/db/package-experiment-*`; generate changes with
`pnpm exec drizzle-kit generate --config=drizzle.package-experiments.config.ts`.
Do not use either pod database for this ledger. Initialization refuses nonempty
foreign databases, uses an application identifier, and rejects future format
versions rather than migrating them backward.

Study nights bind subject/side, start/end, input/reference hashes, split and
protocol hash. Splits must be chronological and nonoverlapping. Claims record
exposure transactionally before selected input is opened. Every attempt counts,
including failures, expired leases and retries; changed study IDs or corrected
input/reference hashes cannot erase overlap with an earlier attempt on the
same subject and side. A stale attempt cannot renew a replacement's lease or
publish over its report. Completed trials return their retained report identity
rather than silently running again.

Claim-time `unexposedHoldoutAtClaim` is historical information. Re-read
`currentEvidence` for current eligibility: another overlapping trial can make a
previously unique holdout attempt non-unique. Keeping this ledger across studies
is required; a new/deleted ledger, relabelled subjects, or data inspected outside
its workflow cannot prove independent holdout use. Final qualification must
bind subjects and windows to retained datasets and recheck exposure while
publishing its decision.

The exploratory `run`, `compare`, `determinism`, and `fixtures` commands do not
claim studies through this ledger and cannot issue independent-holdout promotion
evidence. `runManagedTrial` and the `managed` command integrate it as described
below. `assessManagedQualification` combines verified external evidence as
described below; installation remains a separate reviewed code/release step.

## Managed whole-night runner

`runManagedTrial` in `managed.ts` accepts a reserved ledger trial, its frozen
`biometric-managed-protocol-v1`, exactly three package variants, a private report
directory, and a trusted retained-night loader. The protocol freezes hardware,
sample rate, metric, quality threshold, reference alignment, whole-night
bootstrap settings and resource policy. Each trial variant binds the package
hash, runtime image, and `configHash({ config, seed })`.

It verifies package/configuration/protocol identities before claiming a lease.
The loader runs only after all selected night exposures are committed. Loaded
references must match the study's subject, side and shared import content hash.
Frames must lie within their frozen night and match its actual input hash. All
three variants run in independent containers; results use the shared typed
comparison and paired whole-night uncertainty functions. Resource assessments
remain attached to every variant.

Private per-night and trial reports are published under their content hashes,
then the ledger's live attempt fence selects the winning report. Heartbeats and
checks between expensive steps renew leases; lost leases abort active execution
or reject publication. Failures retain partial-night evidence and exposure.
An old worker may leave an unreferenced artifact but cannot overwrite the winning
ledger pointer. Restarted completed trials verify the complete retained report graph before
reusing it and never silently reread holdout input. Missing or corrupted
per-night artifacts fail rather than trigger a new evaluation.

A successful run means the evaluation completed, not that its candidate passed
all promotion criteria. Check current ledger exposure, coverage, uncertainty,
resource assessments, deterministic/noise/compatibility evidence and reviewed
release admission. The runner does not install packages or claim pod fitness.
Hard process termination can still leave orphan containers/artifacts; use the
ownership-checked recovery procedures below. Combined external qualification
rechecks the retained evidence and current exposure without authorizing installation.

## Managed descriptor command

```sh
pnpm biometrics:experiment managed ./experiment-workspace descriptor.json receipt.json
```

The command creates a private workspace (0700) containing a dedicated
`experiments.sqlite` (0600) and private `reports/`. Reuse the same workspace
across studies; deleting or replacing it destroys the exposure history needed
for future decisions. Existing public directories, symlinked workspace/report
paths, symlinked database/sidecar files, and foreign databases are rejected.
No pod database is opened or migrated.

Managed execution acquires an OS-released SQLite write lock in `.writer.sqlite`
for the entire workspace operation. Competing controllers fail before changing
the ledger or starting containers. Never unlink this lock file to resolve a busy
workspace: doing so would create a second lock inode. A killed controller releases
the database lock automatically; container and private-staging recovery are still
separate responsibilities. Low-level trial APIs are trusted building blocks;
`managed` is the bounded persistent-workspace entry point.

The default workstation storage policy allows 2,048 report files, 1 GiB of total
report bytes, 32 MiB per report and a 64 MiB ledger, while requiring 1 GiB of free
space plus room for ledger growth/rollback and the next report. These are off-pod
storage limits, not production pod resource budgets. Supply a strict JSON policy
as the optional fourth managed argument to override them:

```sh
pnpm biometrics:experiment managed WORKSPACE DESCRIPTOR RECEIPT STORAGE_POLICY
```

Policy fields are `maximumReportFiles`, `maximumReportBytes`,
`maximumSingleReportBytes`, `maximumDatabaseBytes`, and `minimumFreeBytes`.
Checks run before work, before each retained-night load, and before each report
publication. They bound managed report files, including abandoned temporary files,
and SQLite growth via `max_page_count` with DELETE-mode rollback journals. The
report directory must contain only private, owned, single-link regular files.
Symlinks, subdirectories and unsafe database/lock files are rejected. No existing
reports or exposure history are deleted to satisfy a quota. When publication is
refused, the failure-finalization behavior below still applies.

Free-space checks are admission snapshots; unrelated applications can consume
space afterward. The ledger cap plus its rollback journal is accounted separately
from report bytes. Operator source files, the output receipt path, Docker storage,
and container input staging outside this workspace are not covered by these
workspace limits. Their existing per-input/output limits still apply; aggregate
staging quotas and crash recovery require separate controls.

A descriptor uses `biometric-managed-descriptor-v1` with:

- `study`: the frozen `biometric-package-study-v1`, including all chronological
  night assignments and their input/reference hashes.
- `protocol`: the exact managed protocol whose canonical hash is the study's
  `protocolHash`.
- `split` and an `idempotencyKey` for this exact trial.
- `variants`: exactly `default`, `current`, and `candidate`, each specifying
  `proposal` (file path), `config`, `seed`, and the operator execution `policy`.
- `nights`: exactly the selected split's night IDs, each with `frames` (JSONL
  path) and `referenceImport` (raw reference-import JSON path).

Failure finalization also runs when the failure report cannot be published (for
example, a full report volume). If the ledger remains writable and the lease is
current, the attempt becomes `failed` with a null report hash. No nonexistent
artifact is claimed. Publication or ledger-finalization failures are returned
alongside the original error in an `AggregateError`; its cause remains the original
failure. Failed attempts retain their exposure history. A stale lease cannot end
or annotate a replacement attempt. A failed ledger write leaves state unconfirmed
and requires subsequent lease recovery; the CLI does not report successful cleanup.

Relative source paths resolve from the descriptor's directory. The descriptor
is operator-owned input, not candidate-provided instructions. Source files must
pass the bounded regular-file reader. Study reference hashes use the shared
`previewReferenceImport(...).summary.contentHash`; input hashes use
`packageInputHash`. Keep retained sources and proposals alongside the study for
reproducibility; metadata alone does not prove a complete night or subject
identity.

Night files are opened only after the ledger records exposure. The receipt
contains the winning trial/report identity, report path and current ledger
evidence. Repeating an unchanged completed descriptor verifies and reuses its
report without rereading night files. Reusing its idempotency key with changed
configuration or study fails. Review current exposure again at any later
promotion decision, since other trials can invalidate first-use evidence.
A receipt is not an installation or qualification approval.

## Recovery after a terminated experiment controller

```sh
pnpm biometrics:experiment recover recovery-report.json
```

Experiment and environment-probe containers carry immutable version, invoking
host UID, kind and expiry labels. Expiry includes the maximum execution deadline
plus two minutes for startup and cleanup. Run this command after restarting an
experiment host and periodically while accepting work. It checks labels, names
and full container IDs on the currently selected Docker daemon, then force-removes
only overdue owned containers by immutable ID. Unexpired, unlabelled and foreign
containers remain untouched. The private report records inspected count and
removed IDs; repeating a sweep is safe. A daemon outage fails the command and
must be retried. Legacy containers without these labels require manual review.

Recovery does not retroactively qualify an interrupted trial or erase exposure.
The ledger's expired lease permits a fresh fenced attempt, with earlier holdout
access still counted. The container sweep does not delete retained reports; its subsequent staging
sweep is described below. This is not a background supervisor: the external host
must schedule it. Host clock correctness is required for absolute expiry. Aggregate
temporary-staging quotas and periodic recovery scheduling remain separate work.

## Retained evidence verification

`readManagedEvidence(ledger, trialId, reportDirectory)` starts from the successful
ledger-selected report hash. It verifies every linked night artifact, exact
study/request/protocol/attempt identities, the complete selected-night set,
reference content and subject/side, all three package/configuration/input/image
identities, and declared resource limits. It recomputes reference comparisons,
resource assessments and whole-night uncertainty, requiring both the per-night
and top-level summaries to match those calculations. Updating hashes around an
altered score does not make that score valid.

Completed managed runs use this verifier before returning a cached result. It
reads reports only, without rerunning candidate code or reopening retained raw
night inputs. The returned evidence includes a fresh ledger exposure snapshot;
later overlapping access can invalidate a previously unique holdout attempt.
This does not prove that a local administrator has never replaced the ledger or
fabricated raw execution records. The experiment host and its retained history
remain trusted. Qualification must recheck current exposure when publishing its
decision and still requires objective criteria, determinism, representative
fixtures, compatibility, target-pod resources and reviewed release promotion.

## Frozen accuracy criteria

Managed protocols may include `accuracyPolicy` using schema
`biometric-package-accuracy-policy-v1`. Choose and review its explicit criteria
before freezing the study: `minimumMaeImprovement`,
`maximumNightMaeRegression`, `maximumNightP95Regression`,
`maximumNightAbsoluteBiasIncrease`, `minimumCommonPairsPerNight`,
`minimumReferenceCoverage`, `maximumReferenceCoverageLoss`, and
`maximumLostTimestampFraction`. Error thresholds use the selected metric's
canonical unit; coverage/loss thresholds are fractions. There are no implicit
production thresholds. Changing criteria changes the protocol hash and cannot
retrofit the original study. Legacy protocols without criteria remain readable
but cannot meet the accuracy gate.

The managed receipt's `accuracy` assessment is recomputed from verified retained
evidence and current ledger exposure. It requires a unique current holdout
attempt, sufficient common pairs on every selected night, coverage and support
within the frozen limits, no excessive per-night MAE/tail/bias regression, and
an estimated whole-night confidence interval supporting the requested MAE
improvement against both default and current. Missing or degenerate uncertainty,
omitted nights, ambiguous support and absent criteria remain insufficient.
Known violations produce `criteria_not_met` even if other evidence is missing.

`criteria_met` means only that these reference-agreement criteria passed. It is
not clinical validation or package qualification: determinism, resource/noise
fixtures, compatibility, pod fitness, prospective monitoring and reviewed release
promotion still apply. The assessment retains exact failures and missing evidence
and never installs code or changes live processing.

## Combined external preflight

```sh
pnpm biometrics:experiment preflight proposal.json plan.json suite.json operator-policy.json preflight-report.json
```

The plan uses `biometric-package-preflight-plan-v1`, `suiteHash` (the canonical
`dataHash` of the parsed fixture suite), `repetitions` (2–5), `configHash`
(`configHash({ config, seed })`), `hardwareId`, `sampleRateHz`, and `side`.
Every fixture must use that exact candidate configuration and seed, hardware,
rate and side. A changed suite or configuration is rejected before execution.
Use reviewed synthetic fixtures here, not undisclosed holdout data.

The runner snapshots candidate bytes, suite and operator policy, executes the
fixture suite, then repeats every fixture in independent containers to check
full-output/state determinism. Each repeat also receives a resource assessment
under the suite's frozen policy. Execution failures and nondeterminism fail the
preflight. Missing fixture categories or incomplete resource observations keep
it incomplete. Cancellation propagates to active experiments and stops further
fixtures/repeats. Reports retain the exact plan and its hash, fixture report,
per-fixture determinism reports, resource assessments and bounded errors.

`external_checks_passed` is external preflight only. Managed studies can bind
the preflight artifact as described below; standalone reports cannot prove
holdout independence or pod fitness. The final combined qualification decision
remains separate. The candidate still needs representative fixture review, current
held-out accuracy, target-pod compatibility/resources, and normal reviewed
release promotion before it can become live.

## Binding preflight to a managed study

Include `preflightPlan` in the managed protocol and `preflightSuite` (a suite-file
path relative to the descriptor) in the managed descriptor. Both are required
together. The study protocol hash freezes the plan, including suite identity,
repetitions and candidate configuration/seed. Its hardware, rate and side must
match the managed study. The runner snapshots the suite before asynchronous work
and rejects mismatches before claiming a trial.

During the leased attempt, preflight runs under the same cancellation heartbeat
before night comparisons. Its complete report, including candidate manifest, is
published by content hash and referenced by the final trial report. Failed or
incomplete preflight remains visible alongside the night results; completing a
trial does not imply that preflight passed. Failure reports retain a completed
preflight reference if a later step fails. Legacy trials without a plan have no
preflight evidence and cannot supply that qualification dimension.

The retained-evidence verifier reopens the bound preflight artifact and checks
its plan, candidate/image, exact fixture set, fixture inputs and output protocol,
resource limits and measurements, repeat count, run identities and determinism
hashes. It recomputes fixture outcomes, resource assessments, missing categories
and overall status. Missing, altered or inconsistent artifacts fail cached reuse.
Completed file workflows do not reread the original suite or night input files.
The managed receipt exposes verified preflight status alongside accuracy; target
pod compatibility, representative-fixture review and release promotion remain
required before an algorithm can become live.

## Combined external qualification assessment

`assessManagedQualification(ledger, trialId, reportDirectory)` verifies the full
retained graph once, reads current holdout exposure, assesses frozen accuracy,
and combines it with bound preflight and every night/variant's resource evidence.
The managed command includes this `qualification` object and an `assessmentHash`
in its receipt. The hash binds trial/report/protocol/request identities, current
exposure and all assessment dimensions. Re-reviewing unchanged evidence is stable;
later overlapping holdout use changes the snapshot and invalidates its independent
holdout claim even though the original execution report remains unchanged.

The combined status is `failed`, `insufficient_evidence`, or
`external_criteria_met`. Known failures dominate missing evidence, with both
reason lists retained. Passing accuracy cannot waive absent/failed preflight,
missing or duplicated resource rows, substituted resource policy, budget excess,
or inadequate measurements for default/current/candidate on any selected night.

This is an external evidence snapshot, not a durable installation authorization.
`installationAuthorized` remains false, and the receipt lists outstanding
representative-fixture review, target-pod compatibility and resource qualification,
prospective health/reference comparison, and reviewed shipped-registry release.
A future promotion step must recheck authoritative evidence at publication; an
old exported assessment must never substitute for that current check.


### Abandoned private staging

Before freezing inputs, the executor writes a private, fsynced ownership receipt
inside its mode-0700 staging directory. It binds the directory name/device/inode,
host UID, controller PID, exact container name, and wall deadline plus two-minute
grace. These receipts require a Unix host UID (macOS or Linux). Package code cannot
read or modify them through its package-only mount.

`recover OUTPUT` first performs the existing expired-container sweep, then scans
host temporary staging. Its output is `biometric-experiment-recovery-v1` with
separate `containers` and `staging` results. Staging is removed only when the
receipt is valid and expired, its controller PID is confirmed absent with ESRCH,
and Docker confirms the named container does not exist. A present container or
an unavailable daemon never proves absence. PID reuse/permission errors retain
staging conservatively. Directory and marker identities are rechecked before
removal; markers must be private, owned, bounded regular files with one link.
The sweep is bounded to 16,384 temporary-directory entries and 128 candidates.

Normal cleanup also preserves staging if container removal fails. Legacy or
unmarked directories, damaged receipts, symlinks, and unproven ownership are left
untouched. A crash between creating the empty directory and writing its receipt
can leave an unmarked empty directory; recovery will not guess its ownership.
Reports and exposure ledgers are not touched. This is an explicit recovery sweep;
a periodic host service and aggregate temporary-staging quotas remain separate.
