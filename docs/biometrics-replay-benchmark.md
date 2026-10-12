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
