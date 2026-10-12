# Frozen biometric datasets

`DatasetStore` retains bounded processed-data snapshots in `biometrics.db`.
It is the persistence layer for the calibration backtest workflow; it is not
yet a waveform replay service. Creating a dataset does not modify live vitals,
active settings, or hardware.

A snapshot contains the selected full recorded sessions, original vitals and
movement rows, exact reference import revisions and normalized measurements,
and available processing-run bundles. Unknown legacy processing provenance
stays null. Measured calibration bytes are not inferred from today's profile.
The manifest explicitly records that limitation and disables signal replay.
Stage replay must state its calibration-quality assumption when the original
quality context is unavailable.

Each snapshot owns its input bytes. Deleting or correcting a reference import,
or pruning original readings, leaves a frozen dataset unchanged. Dataset reads
verify the hash of both manifest and snapshot. Reusing an idempotency key
returns the original dataset; a different selection under that key fails.
Only one revision from a reference family may appear in a dataset. Both side
and asserted sleeper mapping must match its references.

The initial processed-data limits are 60 selected sessions, 20 reference
imports, 20,000 retained rows, 8 MiB per snapshot including its manifest, and
64 MiB across these snapshots. These are conservative service bounds, not a
claim about target-pod replay performance. Raw artifacts need separate retention
and free-space safeguards before signal replay can be enabled.

Whole-night grouping uses the selected timezone's local noon as the night
boundary. Overnight sessions and naps touching the same night stay together;
a session spanning noon connects adjacent night cohorts. Cohorts are sorted
chronologically before assigning tuning, validation, and holdout. Fewer than
three cohorts yields descriptive tuning only. More cohorts establish a split,
not validated improvement or adequate statistical power. ICU/timezone runtime
versions and the actual assignment are retained; later timezone updates cannot
silently change an existing dataset.

Coverage includes actual timestamp counts, duplicates, and leading/internal/
trailing gaps under an explicit nominal cadence. This estimates recording
availability, not measured signal support duration. Overlapping selected
sessions retain original row IDs; evaluators must deduplicate shared rows and
score one independent night cohort rather than treating sessions as independent
nights. Retrospective classification remains retrospective.
