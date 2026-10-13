# Biometric calibration release evidence

This is the acceptance evidence map for the calibration implementation, including
prospective monitoring and external algorithm experiments. A passing synthetic
benchmark is resource evidence for its exact build and input; it is not evidence
of improved accuracy or authorization to promote an algorithm.

## Validation recorded on October 13, 2026

- Full CI Vitest run at `cb39444b`: 6,856 passed, 18 skipped; 480 files passed,
  one skipped. Skips are not counted as verified behavior.
- Locked piezo environment: 203 piezo/shared numerical tests passed; the separate
  common-module suite passed 415 tests with five skipped.
- TypeScript and the production build passed after the MCP workflow addition.
- Browser checks at `216dab46`: five passed, including the real database manual
  calibration/receipt/rollback flow and English/Spanish provenance views.
- Deployment archive regression at `b1e05db3`: 26 tests passed. Local Python
  environments/caches are excluded while source and locked dependencies remain.
- The shadow benchmark harness at `4ee74c25` passes TypeScript/lint and bundles;
  those checks do not establish target-pod execution.

## Acceptance map

These links locate implementation contracts and behavioral evidence. Target-pod
acceptance is separate from fixture and browser results.

| Requirement | Implementation and evidence |
| --- | --- |
| Defaults without user configuration | [Registry tests](../src/biometrics/algorithms/tests/registry.test.ts), [numerical golden fixtures](../modules/piezo-processor/test_default_golden.py) |
| Independent compatible side overrides | [Profile activation tests](../src/biometrics/profiles/tests/activation.test.ts), [runtime routing](../modules/common/test_biometric_routing.py) |
| Sensor calibration distinct from personalization | [Runtime ownership and lifecycle](biometrics-runtime-activation.md), [sensor calibration architecture](hardware/calibration-architecture.md) |
| Preserve existing stage overrides | [Runtime integration](../src/biometrics/profiles/tests/runtime-integration.test.ts), [migration/provenance tests](../src/biometrics/profiles/tests/provenance-migration.test.ts) |
| Reference source, metric, interval, timezone and import provenance | [Reference normalization](../src/biometrics/references/tests/normalize.test.ts), [reference storage](../src/biometrics/references/tests/store.test.ts), [import contracts](biometrics-reference-imports.md) |
| HRV definition across storage, reports, UI, exports and prompts | [API/provenance contracts](biometrics-calibration-api.md), [router tests](../src/server/routers/tests/biometrics.provenance.test.ts), [CSV tests](../src/components/biometrics/tests/vitals-csv.test.ts), [MCP contracts](../src/mcp/tests/server.test.ts) |
| Identical retained inputs, whole-night separation, coverage-aware evaluation | [Frozen datasets](biometrics-datasets.md), [dataset tests](../src/biometrics/backtest/tests/datasets.test.ts), [evaluation assessment](../src/biometrics/profiles/tests/evaluation-assessment.test.ts) |
| Missing raw/context limits claims | [Waveform dataset tests](../src/biometrics/backtest/tests/waveform-dataset.test.ts), [retained replay tests](../modules/piezo-processor/test_retained_replay.py) |
| Shared processing, durable jobs, bounded resources, no canonical/hardware effects | [Backtest lifecycle](biometrics-backtest-jobs.md), [waveform publication integration](../src/biometrics/backtest/tests/waveform-publication.integration.test.ts), [shared live/replay tests](../modules/piezo-processor/test_waveform_replay.py) |
| Shared UI/MCP workflow | [Browser workflow](../tests/browser/workflow.e2e.ts), [failed validation](../tests/browser/calibration.e2e.ts), [MCP session tests](../src/mcp/tests/server.test.ts) |
| Exact revision, concurrency and actual acknowledgment | [Runtime integration](../src/biometrics/profiles/tests/runtime-integration.test.ts), [daemon adapter tests](../modules/piezo-processor/test_runtime_adapter.py) |
| Distinct audited reset and rollback | [Activation tests](../src/biometrics/profiles/tests/activation.test.ts), [runtime protocol](biometrics-runtime-activation.md) |
| Original observations distinct from recomputation | [Historical API semantics](biometrics-calibration-api.md), [provenance browser checks](../tests/browser/provenance.e2e.ts) |
| Coherent updates, resets, cleanup, failures and restarts | [Runtime host tests](../src/biometrics/profiles/tests/runtime-host.test.ts), [backtest lifecycle](biometrics-backtest-jobs.md), [deployment tests](../tests/updateDeploy.test.ts) |
| Isolated generated code and reviewed promotion | [External experiment contracts and real-Docker checks](../scripts/algorithm-experiments/README.md), [shadow admission tests](../src/biometrics/shadow/tests/admission.test.ts), [promotion registry tests](../src/biometrics/profiles/tests/qualification-registry.test.ts) |
| Target-pod operational behavior | [Measurements and limitations](biometrics-replay-benchmark.md); deployment and live measurement status below |

## Delivery and qualification status

- The current eight-hour replay and 30-minute synthetic shadow supervisor runs
  completed successfully; their receipts are linked in the measurement document.
  The separate 180-second live source/isolated sink assessment also completed;
  its exit-race regression, build identities and limitations are recorded there.
  Synthetic output cannot supply held-out accuracy.
- The measured replay policy is installed and the pod reports admitted.
  Reviewed promotion/shadow registries still need their own matching fixture and
  held-out evidence; absence must remain visible and deny qualified promotion.
- Build `4c3a6a6e` is deployed, including the live-shadow exit-race fix. Migrations succeeded; the calibration API, live
  data path and core/numerical services are healthy, and new vitals carry processing
  provenance. [Deployment receipt](performance/biometrics-replay-2026-10-13/deployment-verification.json).
  Unpersonalized defaults have no requested activation generation, so this check
  does not claim a new profile acknowledgment or change the user's profile.
- [PR #824](https://github.com/sleepypod/core/pull/824) is pushed against `dev`.
  CodeRabbit full review was requested, but the provider skipped it because
  the PR exceeds its 100-file review limit. No completed CodeRabbit review is claimed.
- Build, lint, typecheck, unit, browser and all Python jobs passed at `8909f305`.
  The patch-coverage gate passed at 86.47%, within the repository's existing
  eight-point margin below its 88.93% target. No coverage threshold was changed.
  Direct coordinator and host tests cover admission, cancellation, retention,
  error sanitization and resource ownership.

Legacy reference availability alone does not establish independent nights, metric
compatibility, reference reliability or sufficient held-out support. No accuracy
qualification is inferred from an inventory of existing references.
