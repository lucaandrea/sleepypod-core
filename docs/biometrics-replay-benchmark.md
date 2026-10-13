# Initial synthetic replay measurement

Measured on the requested pod (`192.168.1.88`, SSH port 8822) on October 12,
2026. This is an initial worker-cost measurement, not the final admission-policy
or end-to-end live-system qualification.

| Property | Observation |
| --- | --- |
| Runtime | ARM64, four CPUs, Node 24.16.0 |
| Physical memory | 2,014,796 KiB |
| Available memory before / after | 1,440,260 / 1,425,340 KiB |
| `/persistent` available before | 3,741,108 KiB |
| One-minute load before / after | 0.54 / 0.36 |
| Input | 27 separate 12-hour nights, 720 minute readings each; 19,440 readings total |
| Input bytes | 2,374,215 |
| Configurations | Identical default/current; one unique numerical evaluation after deduplication |
| Child settings | nice 19, 128 MiB Node heap limit, 30-second external timeout |
| Evaluator elapsed time | 2,519.355 ms |
| Child peak RSS | 132,436 KiB (about 129 MiB) |
| Complete report size | 2,450,542 bytes |
| Core / piezo service status | Both active before and after |

The shipped worker SHA-256 was
`16bab5135fcf0ba4d4a1624660f8565ba0b073cf39e7d13760df17347cd24d6a`.
Input was generated from the repository's processed-backtest fixture, expanded
to daily-separated nights with synthetic `60 + sin(minute / 10) * 8` BPM,
HRV index 30 and breathing rate 14. No personal recordings were transferred.
The worker and synthetic input/output existed only in a unique temporary pod
directory, which was removed after measurement. No live database, service
configuration or hardware controls were changed.

The report exceeded the old 2 MiB inline limit. That concrete failure motivated
the large-report artifact path rather than reducing dataset size or dropping
traces. The worker was invoked directly for measurement; the old repository
would have rejected publication of this report.

Still required before choosing final admission limits: three distinct candidate
configurations, repeated and worst-case inputs, wall-clock startup/serialization,
artifact I/O, CPU utilization, SQLite contention, ingest age, temperatures and
control/API responsiveness while replay runs. Service `active` status alone does
not prove those properties. This measurement does not cover waveform replay or
untrusted algorithm execution, and does not justify a universal speed claim.

## Three-configuration follow-up

On October 12, the same pod and worker hash completed three consecutive runs
with distinct default/current/candidate configuration hashes. Input remained
27 synthetic twelve-hour nights (19,440 readings). The deep-stage HR-ratio
thresholds were 0.92, 0.90, and 0.94 respectively. Other input and protocol
settings were unchanged, including assumed calibration quality zero. These
are distinct evaluations, but this fixture does not exercise every stage branch
or establish a worst-case runtime.

| Run | Wall time, including child startup/output | Evaluator time | Peak worker RSS | JSONL output bytes |
| --- | --- | --- | --- | --- |
| 1 | 4,295.804 ms | 3,397.305 ms | 156,036 KiB | 3,675,631 |
| 2 | 4,163.752 ms | 3,252.410 ms | 141,956 KiB | 3,675,638 |
| 3 | 4,247.537 ms | 3,330.915 ms | 145,188 KiB | 3,675,631 |

A Python harness sampled local read-only performance, sensor-source, and device
status HTTP endpoints approximately every half second (requests are sequential,
so request time extends the interval). It recorded only latency, frame age,
resource counters and thermal-zone-zero temperature. It used four seconds of
baseline and three seconds afterward. There were seven baseline samples,
twenty-three replay samples and four afterward; all requests succeeded.

| Measurement | Baseline | During replay | After |
| --- | --- | --- | --- |
| Minimum available memory | 1,358,520 KiB | 1,215,752 KiB | 1,328,848 KiB |
| Median aggregate CPU busy | 23.78% | 56.65% | 22.22% |
| Maximum aggregate CPU busy | 28.76% | 76.68% | 29.92% |
| Maximum zone-zero temperature | 33.503 °C | 37.356 °C | 30.934 °C |
| Maximum performance GET latency | 34.92 ms | 328.04 ms | 26.11 ms |
| Maximum sensor-source GET latency | 103.29 ms | 45.32 ms | 27.32 ms |
| Maximum device-status GET latency | 51.58 ms | 108.24 ms | 74.00 ms |
| Maximum reported live-frame age | 457 ms | 514 ms | 418 ms |

CPU busy is the change in `/proc/stat` non-idle counters across adjacent samples
in the same phase, aggregated across all four CPUs. It includes the running
services and measurement harness. The server's lifetime event-loop p95 remained
21.14 ms; that lifetime histogram cannot establish the replay interval's p95.
The sensor endpoint reports the newest frame of any sensor type, so this is not
proof of piezo-specific freshness. Temperature zones one through three were
unreadable; only zone zero was sampled. Status GET latency is not proof of
hardware-write or closed-loop control responsiveness.

The harness read the worker's complete output file and extracted operational
counters; it did not run the production Node result parser, artifact publisher
or database transactions. Thus parent-process event-loop cost, persistent
artifact I/O, SQLite contention, larger/reference-heavy fixtures, waveform replay
and sustained-load qualification remain outstanding before final admission limits
are selected. Node ran at nice 19 with a 128 MiB heap and a 45-second external
timeout. Both services remained active afterward. Temporary synthetic input,
worker, harness and output were removed from the pod; no live configuration,
observations or hardware settings were changed.

## Production runner and reference-heavy qualification

A follow-up on October 12 used the production `DatasetStore`, `BacktestJobStore`,
child driver, result publication, and integrity-checked result reader against a
new synthetic SQLite database on the pod's persistent storage. The application
service and its databases were left untouched. The reusable harness is
`scripts/benchmarks/biometrics-runner.ts`; bundle it with esbuild for Node, leaving
`better-sqlite3` external, and pass a **new** directory, copied migration
folder, packaged worker path, and `mixed` or `dense` fixture name. Directory
creation is exclusive so an existing database cannot be selected accidentally.

The tested worker SHA-256 was
`45547553cd456cba5051fe6e60e8562b5510ae32bbf8b92cfeb62c59cdeb59d1`.
The coordinator used Node's 384 MiB heap limit; its evaluator child retained
nice 19 and the 128 MiB heap limit. These are measurement settings, not yet an
approved deployment policy.

The mixed fixture retained 20 twelve-hour nights, 14,400 vital readings,
3,600 movement rows, and 1,600 heart-rate/stage reference records. It includes
periodic missing HR readings, motion, and varying HR/HRV/breathing. Chronological
splitting evaluated 12 tuning nights. The three configurations have distinct
deep-stage HR-ratio thresholds; assumed calibration quality is explicitly one.
This synthetic fixture measures execution and does not validate biometrics.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Coordinator execution through publication | 12,007.73 ms | 11,543.85 ms | 11,673.61 ms |
| Evaluator runtime | 5,202.12 ms | 4,962.23 ms | 5,048.52 ms |
| Evaluator peak RSS | 168,392 KiB | 167,180 KiB | 174,336 KiB |
| Integrity-checked result read | 2,286.37 ms | 2,256.85 ms | 2,267.35 ms |
| Coordinator event-loop maximum | 2,386.56 ms | 2,300.58 ms | 2,365.59 ms |
| Coordinator event-loop p95 | 22.64 ms | 22.95 ms | 20.92 ms |
| Coordinator process peak RSS (cumulative) | 257,564 KiB | 261,296 KiB | 262,292 KiB |

All three attempts succeeded, produced 1,813,618-byte reports, and left the
synthetic canonical vitals unchanged. Dataset creation took 4,322.13 ms. These
reports remain below the 2 MiB inline threshold, so this workload does not
qualify the artifact path. Minimum available system memory during the replay
phase was 1,140,300 KiB and maximum zone-zero temperature was 39.457 °C.

**Admission is not qualified by these results.** The coordinator's multi-second
synchronous work would block the application if wired into its main event loop.
Dataset construction and result reads have the same issue. Move these operations
into a bounded coordinator worker before enabling production execution, then
repeat the benchmark. A favorable p95 conceals the long individual stalls.

The harness's own HTTP requests and piezo receipt callbacks run on that same
coordinator event loop. Their delays therefore cannot be attributed solely to
the application server or sensor ingestion. The separate standard-library probe
`scripts/benchmarks/biometrics-probe.py` measures loopback API latency from another
process. Neither probe retains API bodies or raw sensor samples. The Node
probe retains only sensor timing and resource measurements. This remains
synthetic, non-production-database testing: it does not establish live SQLite
contention, hardware-write responsiveness, waveform replay, or untrusted-code
isolation.

### Large artifacts and independent API probe

The dense fixture used the same worker with 19,000 synthetic vitals, no movement
rows, and 800 reference records across 20 nights. Twelve tuning nights produced
reports of 2,301,040, 2,301,041, and 2,301,034 bytes. All three stored result
descriptors were verified as `biometric-report-artifact-v1`, all result reads
passed integrity checks, and canonical synthetic vitals were unchanged.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Coordinator execution through publication | 13,236.50 ms | 12,901.88 ms | 13,064.22 ms |
| Evaluator runtime | 5,501.95 ms | 5,455.62 ms | 5,499.04 ms |
| Integrity-checked artifact result read | 2,803.76 ms | 2,933.55 ms | 2,973.02 ms |
| Coordinator event-loop maximum | 2,961.18 ms | 2,780.82 ms | 2,885.68 ms |
| Evaluator peak RSS | 166,692 KiB | 161,240 KiB | 162,472 KiB |

Dataset creation took 4,477.81 ms. Coordinator peak RSS reached 262,456 KiB;
minimum available system memory during replay was 1,105,904 KiB; zone-zero
maximum temperature was 40.274 °C. Piezo source-timestamp age seen by the
coordinator peaked at 4,728 ms during replay versus 2,584 ms in its baseline.
Because this callback shares the blocked coordinator loop, that measurement
still combines actual frame age with callback delay.

The independent Python probe made 12 baseline samples, 251 samples spanning
fixture setup and all three attempts, and 9 afterward. Every GET returned 200.

| Maximum HTTP latency | Baseline | Entire benchmark | After |
| --- | --- | --- | --- |
| Performance | 36.88 ms | 57.52 ms | 22.48 ms |
| Sensor source | 93.53 ms | 72.37 ms | 22.72 ms |
| Device status | 66.74 ms | 80.61 ms | 52.32 ms |

The production service remained active after the benchmark. These observations
support keeping heavy coordination separate from the application event loop;
they do not approve running it on that loop. The harness's configuration labels
are synthetic comparison roles (thresholds 0.90, 0.92, 0.94), not a promotion
comparison against an asserted shipped-default profile. Repeat qualification
after coordinator isolation and again for the final deployed worker. The
measurements do not yet select universal admission thresholds or qualify live
SQLite contention and closed-loop control responsiveness.

## Isolated coordinator follow-up

The coordinator implementation at `0e5c87c0` was measured on the same pod on
October 12 using the dense fixture above. The optional final `COORDINATOR`
argument to `scripts/benchmarks/biometrics-runner.ts` routes dataset creation,
experiment creation, execution, and report reads through the shipped coordinator.
The caller uses the same 384 MiB heap cap as the preceding benchmark; each
coordinator has a 384 MiB cap and nice 19, and its evaluator retains 128 MiB/nice
19. Each operation gets a fresh process. The worker hash remains
`45547553cd456cba5051fe6e60e8562b5510ae32bbf8b92cfeb62c59cdeb59d1`.

An initial isolated run succeeded three times. The repeat below adds a timer
turn after report serialization, so its event-loop maximum includes final IPC
deserialization and JSON serialization as well as execution/publication. This
is a calling-process measurement, not the production application's event-loop
histogram. Both runs used exclusively created synthetic databases and retained
no personal recordings or API response bodies.

| Measurement | Run 1 | Run 2 | Run 3 |
| --- | --- | --- | --- |
| Execution through publication | 14,955.19 ms | 15,390.62 ms | 15,141.36 ms |
| Integrity-checked full report read | 4,178.71 ms | 4,418.67 ms | 4,237.17 ms |
| Calling-process event-loop maximum | 144.83 ms | 187.83 ms | 174.59 ms |
| Calling-process event-loop p95 | 21.22 ms | 21.04 ms | 21.12 ms |
| Calling-process cumulative peak RSS | 153,428 KiB | 156,940 KiB | 156,940 KiB |
| Evaluator peak RSS | 164,460 KiB | 171,136 KiB | 162,032 KiB |

All three attempts succeeded; full reports remained approximately 2.30 MB and
canonical synthetic vitals were unchanged. Dataset construction took 5,693.98 ms
with a calling-process event-loop maximum of 56.30 ms. During replay, minimum
available system memory was 1,046,688 KiB, maximum zone-zero temperature was
41.909 °C, and maximum piezo source timestamp age was 2,756 ms. This does not
measure the coordinator's peak RSS; the memory values above must not be summed
as a complete process-tree maximum.

The independent probe recorded 12 baseline samples, 291 spanning the complete
benchmark, and nine afterward. Every request returned HTTP 200.

| Maximum HTTP latency | Baseline | Entire benchmark | After |
| --- | --- | --- | --- |
| Performance | 30.48 ms | 160.12 ms | 38.15 ms |
| Sensor source | 27.47 ms | 109.92 ms | 24.23 ms |
| Device status | 65.74 ms | 159.46 ms | 76.02 ms |

Isolation removed the multi-second calling-loop stalls observed previously,
but full-report IPC/serialization still transfers large trace arrays. In one
retained synthetic report, `nights` occupied about 2.21 MB; the first evaluated
window's `blocks` alone occupied 56,786 bytes. A bounded summary for interactive
review, with exact traces fetched through the existing paginated endpoint, is
an appropriate next optimization. Keep the complete immutable report and its
hash; a transport projection must not silently redefine the retained artifact.

These observations still do not qualify live-database write contention,
closed-loop hardware responsiveness, waveform processing, or arbitrary-code
isolation. No production resource policy or automatic background execution was
enabled by this benchmark. Temporary benchmark databases and binaries were
removed after measurements were copied locally; the production service was
left running without a deployment or restart.

## Retained waveform pipeline on the pod

The October 12 follow-up used the coordinator and Node evaluator built from
`fe25e71a`, plus the Python process-limit compatibility fix accompanying this
measurement. The pod's Python 3.10.4 installation omits the optional `resource`
extension. Workers now use `/usr/bin/prlimit` on Linux when that extension is
missing, failing startup if the utility fails. A separate child on the pod
confirmed CPU soft/hard limits of 120/121 seconds, core limits of zero, and
open-file limits of 64/64 in `/proc/self/limits`.

The new `scripts/benchmarks/biometrics-waveform-fixture.py` creates deterministic
500 Hz dual-channel sine-plus-noise CBOR archives in an exclusively created
directory. The runner `biometrics-waveform-runner.ts` creates a separate database,
retains those archives through the production publisher, enqueues three unique
configuration hashes, executes the leased waveform pipeline, and reads its
summary. The first five minutes are retained pre-roll. Configuration labels
are synthetic roles; this fixture does not measure biological accuracy.

The 30-minute fixture contained 5,976,451 compressed bytes. Dataset creation
took 1.309 seconds and retention took 15.809 seconds. Execution reached its
180-second coordinator limit before publishing a result. Canonical synthetic
observations were unchanged. **This workload is not qualified for automatic
execution.** Full-night execution needs a different scheduling/budget design;
simply enabling the existing host would not make these jobs complete.

The independent probe sampled the benchmark process and its descendants through
`/proc`, in addition to the existing loopback HTTP measurements. RSS is a sampled
sum, not an exact peak or unique physical-memory accounting. The failed
30-minute run produced 12 baseline, 448 benchmark, and nine post-run samples.
All sampled HTTP responses returned 200.

| Measurement | During the complete 30-minute-fixture benchmark |
| --- | --- |
| Maximum sampled process-tree RSS | 313,332 KiB |
| Minimum available system memory | 1,181,144 KiB |
| Maximum zone-zero temperature | 40.041 °C |
| Maximum performance GET latency | 49.01 ms |
| Maximum sensor-source GET latency | 79.46 ms |
| Maximum device-status GET latency | 115.39 ms |
| Maximum age of piezo WebSocket receipt | 1,446 ms |

The receipt age is measured at the benchmark client; it is not the age of the
original sensor timestamp. The calling process's largest sampled scheduling
delay was 179.88 ms, so favorable HTTP timings alone do not establish its event
loop budget. Measurements use synthetic databases and do not qualify live
SQLite write contention or hardware-command latency. No production admission
policy is selected by these results.

A 10-minute follow-up (five minutes pre-roll and five minutes scored) completed
the entire pipeline with the same three configurations. Its 1,992,541 compressed
bytes took 15.599 seconds to retain. Leased replay and publication took 83.402
seconds, and integrity-checked summary retrieval took 1.289 seconds. The summary
was 28,798 bytes; synthetic canonical observations again remained unchanged.
The replay caller's event-loop p95/max were 22.00/63.90 ms, including a timer
turn after the coordinator reply. This is a successful short fixture, not a
qualified whole-night workload.

The independent probe recorded 12 baseline, 247 benchmark, and nine post-run
samples, all with HTTP 200 responses. During the benchmark, process-tree RSS
reached 314,852 KiB, available memory stayed at or above 1,184,736 KiB, and
zone-zero temperature reached 39.924 °C. Maximum performance/sensor-source/device
GET times were 155.93/96.78/75.31 ms. Maximum piezo receipt age was 1,626 ms.

The successful run pinned compound build
`b91e8552bc6d973922bd38808d04490683e3e05d8c67c9af5ad37d40a64bfe45`
and Python build
`fad13cfff0b361fbec950e0b6ddd892fe3d97f42f3ef9c5031af2e700c579aca`.
Its complete report hash was
`8446b1a8fd4c0f1530c25ed186ac5231c8020c60e4dffc42b1ec248aa2b46291`.
Python used the pod's installed NumPy 2.2.6 and SciPy 1.15.3. The staged
benchmark used fixed production worker bundles, not the temporary diagnostic
coordinator used to investigate the missing Python extension.

After both runs, no benchmark descendants remained. Synthetic telemetry and
logs were copied locally, and the staging directory was removed. Both installed
services remained active on the original `homekit-0b53800` release. No deployment,
restart, live-database modification, or hardware command was part of this test.

### Where waveform execution time goes

A subsequent synthetic 30-minute profile on the same pod separated startup
from processing. The Yocto Python installation also lacks `_lsprof`, so the
diagnostic used `time.monotonic()` and `time.process_time()` around the shipped
functions. These timings include small wrapper overhead and are not a complete
function profiler. It retained the same noisy dual-channel fixture in a new
directory and discarded derived readings after counting them.

| Operation | Wall time | CPU time |
| --- | --- | --- |
| Import replay and numerical dependencies | 12.726 s | Not measured |
| Retain the synthetic archive | 0.369 s | Not measured |
| Complete one-configuration retained replay | 45.184 s | 44.751 s |
| Inner CBOR decoding (included above) | 0.596 s | 0.583 s |
| Per-side ingestion (included above) | 41.623 s | 41.238 s |
| Numerical estimates (included in ingestion) | 30.365 s | 30.082 s |

The run consumed 1,860 records including 1,800 piezo frames and produced 50
scored readings plus ten pre-roll readings. These overlapping timings must not
be summed. Both startup and numerical processing matter; archive decoding was
not the dominant cost. A full-night run still needs direct measurement rather
than extrapolating this short profile into a production runtime guarantee.

### Interrupted eight-hour qualification (2026-10-13 UTC)

The three-configuration, eight-hour synthetic run on `192.168.1.88:8822`
was cancelled during its third configuration after systemd explicitly stopped
`sleepypod` at 01:09:44 UTC. Core and piezo services restarted at 01:10:17 UTC;
`NRestarts=0` and the journal showed the stop request and SIGTERM. This task did
not issue that stop. The installed release remained `homekit-0b53800`.
The admission monitor withdrew permission when HTTP health disappeared. This
run is **not a completed qualification**, regardless of the operation timer's
`succeeded` field (which only records that the execution RPC returned).

Before cancellation, the benchmark recorded 293 concurrent descriptor reads,
zero read failures, read p95 1520 ms / maximum 2077 ms, 5962 HTTP probes with six
failures at shutdown, HTTP p95 42 ms / maximum 937 ms, at least 1,045,213,184 bytes
available memory, maximum temperature 44.594 C, maximum piezo receipt age 1768 ms,
and peak benchmark process-tree RSS 396,940 KiB. Canonical observations remained
unchanged. These observations support cancellation behavior but do not establish
a production resource policy or a successful full-night replay.

Synthetic measurements and probe metadata were copied locally for analysis.
After confirming all benchmark descendants had exited, its exact staging directory
was removed; both installed services were active. Repeat full qualification in an
uninterrupted window before enabling the production replay host.
