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
