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
