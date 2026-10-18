# Pod vs Apple Watch deviation

**Goal:** near-zero deviation from the Apple Watch for heart rate, HRV,
breathing rate and sleep stages.

Everything here runs off-pod. The pod is only a data source: its database
snapshot and RAW archives are pulled once, then replays and scoring run in the
local container (`run.sh`, linux/arm64 with the pod's locked Python 3.10,
NumPy 2.2.6 and SciPy 1.15.3). Each step is a standalone script so its logic
can move into the app, the API or MCP once it earns it.

## Layout

| File | What it does |
|---|---|
| `Dockerfile`, `setup.sh`, `run.sh` | Analysis container. Repo bind-mounted at `/work`; Linux `node_modules` and the piezo-processor venv live in named volumes. |
| `parse_watch.py` | Apple Health `export.zip` → `data/watch.json` (Watch-sourced HR, HRV SDNN, respiratory rate, sleep stages). Drops rows sleepypod wrote back into Health. |
| `fetch_raw.sh` | Copies the pod's gzipped RAW archives for given UTC windows into `data/archive/`. Read-only on the pod. |
| `pairing.ts` | Shared pairing windows and deviation stats (MAE, bias, p90, r, coverage). Deviation = pod − Watch. |
| `score_live.ts` | Scores what the pod stored each night (vitals table + stages re-run with the current ruleset) against the Watch. |
| `build_bundle.ts` | Builds the same off-pod fitting bundle the pod's dataset export streams, from the pulled snapshot and archives. |
| `score_readings.ts` | Scores replayed readings (`--save-readings`) per sleep session with the same pairing, including coverage. |
| `candidates-*.json` | Profile candidates for `scripts/biometrics-local-fit` replays. |
| `data/`, `out/` | Pulled inputs and results; gitignored. |

## Reproduce

```sh
# pull (read-only on the pod)
ssh -p 8822 root@POD '/usr/local/bin/node -e "…backup(/tmp/bio-snap.db)"' && scp -P 8822 root@POD:/tmp/bio-snap.db data/biometrics.db
python3 parse_watch.py ~/Downloads/export.zip 2026-10-01
./fetch_raw.sh POD "2026-10-15 09:16|2026-10-15 15:24" …

# analyse (container, repo root)
npx tsx analysis/watch-deviation/score_live.ts left 3
analysis/watch-deviation/run.sh npx tsx analysis/watch-deviation/build_bundle.ts 1139 1160 1170 1176
analysis/watch-deviation/run.sh npx tsx scripts/biometrics-local-fit/cli.ts fit analysis/watch-deviation/data/bundle.tar analysis/watch-deviation/candidates-hr.json analysis/watch-deviation/out/hr --include-holdout --save-readings
npx tsx analysis/watch-deviation/score_readings.ts analysis/watch-deviation/out/hr 1139 1160 1170 1176
```

## Log

### 2026-10-18: data pulled

- Pod .88 snapshot taken 16:40 UTC (after `dev` 1dc8a07 deploy). Watch export uploaded 09:12 PT, imported on the pod (HR + stages only; the web import has no HRV or breathing).
- `watch.json` since 2026-10-01, Watch-only: 2658 HR, 52 HRV SDNN, 429 respiratory rate, 240 stage segments.
- Last night is sleep record **1176** (10-18 09:34–15:37 UTC, 6.1 h). It ran runtime config gen 5 from a stale branch build: `trackingToleranceBpm` 15 and the old hard-coded peak-score floor 0.1, i.e. **without** #840's `minimumPeakScore` 0.4 guard.
- RAW archives for 1139, 1160, 1170, 1176: 127 files, 355 MB.

### Step 1: live nights as recorded (`score_live.ts`, left side, records ≥ 3 h)

Pairing: HR nearest pod row ±60 s, BR ±150 s, HRV = mean pod hrv ±5 min vs Watch SDNN. Stages re-run with ruleset gen 6, piezo quality 0.981. Deviation = pod − Watch.

| night | start (UTC) | h | HR n/watch | HR MAE | HR bias | HR r | BR n | BR MAE | BR bias | HRV n | HRV MAE | HRV bias | stage epochs | acc | kappa |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1097 | 2026-10-09T09:04 | 10.5 | 61/95 | 3.1 | 0.1 | 0.29 | 23 | 3.3 | 3.2 | 1 | 21.8 | 21.8 | 202 | 0.41 | 0.09 |
| 1100 | 2026-10-10T10:35 | 11.8 | 129/143 | 6.6 | 1.1 | 0.15 | 37 | 2.7 | 2.2 | 3 | 14.3 | 4.3 | 369 | 0.33 | -0.01 |
| 1103 | 2026-10-11T07:35 | 14.4 | 113/125 | 8.0 | 6.4 | 0.13 | 30 | 2.9 | 2.5 | 3 | 20.4 | 20.4 | 303 | 0.42 | 0.07 |
| 1110 | 2026-10-12T09:14 | 5.1 | 70/70 | 4.7 | 3.2 | 0.35 | 23 | 1.2 | 0.8 | 2 | 35.9 | 35.9 | 215 | 0.16 | 0.05 |
| 1121 | 2026-10-13T09:58 | 10.3 | 138/145 | 3.4 | 2.7 | 0.42 | 53 | 1.1 | 0.7 | 3 | 28.2 | 28.2 | 420 | 0.14 | -0.07 |
| 1129 | 2026-10-14T10:48 | 8.5 | 108/120 | 4.0 | 3.6 | 0.28 | 50 | 2.9 | 2.8 | 2 | 12.8 | 12.8 | 401 | 0.28 | -0.03 |
| 1139 | 2026-10-15T09:16 | 6.1 | 82/86 | 4.0 | 2.2 | 0.41 | 30 | 1.7 | 1.2 | 2 | 16.4 | 16.4 | 266 | 0.17 | 0.03 |
| 1160 | 2026-10-16T10:55 | 6 | 83/85 | 1.8 | 1.1 | 0.64 | 34 | 3.0 | 2.6 | 2 | 7.6 | -7.6 | 321 | 0.17 | -0.01 |
| 1170 | 2026-10-17T09:41 | 9.5 | 136/136 | 4.2 | 2.8 | 0.40 | 53 | 1.7 | 1.4 | 4 | 28.9 | 28.9 | 514 | 0.24 | 0.03 |
| 1176 | 2026-10-18T09:34 | 6.1 | 85/85 | 2.0 | 0.5 | 0.63 | 31 | 2.0 | 2.0 | 2 | 13.5 | 13.5 | 307 | 0.24 | -0.00 |

Reading:
- **HR:** MAE 1.8–8 bpm, nearly always biased high (+0.1 to +6.4). Last night (no guard) was one of the two best nights.
- **Breathing:** MAE 1.1–3.3 /min with a consistent **positive bias of +0.7 to +3.2** — the pod over-reads every night. A calibration offset or a band change is the first lever.
- **HRV:** the pod reads 8–36 ms above Watch SDNN on all but one night, but the Watch gives only 1–4 SDNN samples a night and the pod's HRV is an IBI-variability index, not SDNN. Near-zero HRV deviation needs a like-for-like metric before any tuning.
- **Stages:** no agreement beyond chance (kappa −0.07 to 0.09) — same as the 10-13 baseline. HR-ratio rules cannot work while HR barely orders stages; stages depend on fixing HR and HRV first.

### Step 2: does #840's peak-score guard still help on new nights? Yes.

Bundle: 1139 (tuning), 1160 (validation), 1170 + 1176 (holdout; the splitter joins them because 1170 runs past local noon). Replayed in the container with 10 workers.

- **Parity:** tuning/validation HR MAE for the old floor (4.503 / 1.716) match the 10-17 macOS run exactly, so the container reproduces the laptop and the pod.
- `dev` defaults are `trackingToleranceBpm` 15 + `minimumPeakScore` 0.4, so `gen5` (tol 15, floor 0.1) and `mps0.1` resolve to the same config. Tolerance does not matter; the floor does.
- Live check: replaying 1176 with the config it actually ran gives HR MAE 2.17 / BR 1.93; the pod's live recording scored 2.0 / 2.0.

Per session (`score_readings.ts`), HR MAE bpm (Watch coverage):

| session | floor 0.1 (ran last night) | **0.4 (dev default)** | 0.5 | 0.6 |
|---|---|---|---|---|
| 1139 | 4.38 (97%) | **1.81 (67%)** | 1.07 (53%) | 0.64 (45%) |
| 1160 | 1.70 (96%) | **1.04 (93%)** | 0.92 (80%) | 0.74 (68%) |
| 1170 | 4.30 (91%) | **2.53 (74%)** | 1.58 (46%) | 0.99 (29%) |
| 1176 | 2.17 (100%) | **1.01 (87%)** | 0.96 (79%) | 0.99 (53%) |

Ranking (evaluator, per split): holdout HR MAE 3.39 → **1.78** with the guard; the guard keeps ~78% of the old floor's Watch-paired readings.

- **The guard still helps on every new night**, including last night (2.17 → 1.01 bpm). Last night ran without it only because of the stale deploy.
- Remaining HR error is a **positive bias of +0.7 to +2.5 bpm** on every night, and 7–33% of Watch minutes get no pod HR at all. Raising the floor trades coverage for error; it does not remove the bias.
- Breathing (+1.7 to +2.7 /min bias) and HRV are unchanged by any HR parameter, as expected.

### Tool fixes made along the way

- `scripts/biometrics-local-fit/fit.ts`: worker slots resolved to absolute paths. With a relative output dir the worker (cwd = temp dir) could not find its slot and every replay failed with "Waveform worker failed or returned an incomplete result".
- `scripts/biometrics-local-fit/local_replay.py`: prints the Python traceback before the generic failure line.
- Debugging needed the worker's stderr, which `src/biometrics/backtest/waveform-child.ts` discards; patched temporarily, reverted.

## Where each metric stands against "near-zero deviation"

| metric | now (dev defaults, 4 recent nights) | blocker | next experiment |
|---|---|---|---|
| HR | MAE 1.0–2.5 bpm, bias +0.7 to +2.5, coverage 67–93% | weak-signal windows pick a wrong single peak (#840); residual high bias | find the source of the high bias (harmonic choice vs Watch averaging window); fill withheld windows from neighbours instead of dropping them |
| Breathing | MAE 1.9–3.2 /min, bias **+1.7 to +2.7** every night | systematic over-read; interval-ratio sweeps never moved it | fit a per-side linear correction against Watch RR, then look for the extra-breath source in the BR estimator |
| HRV | pod 7–32 ms above Watch SDNN, 1–4 Watch samples a night | **different metric**: pod emits an IBI-variability index, Watch reports SDNN; Watch HRV is never imported | emit SDNN (and RMSSD) from the pod's IBIs over Watch-sized windows; import Watch HRV |
| Stages | kappa −0.07 to 0.09 (chance) | rules key on HR ratio and HRV that do not yet track the Watch | revisit after HR/HRV; with ~10 Watch nights, fit stage thresholds on features instead of hand rules |

### API / MCP changes this needs

- **Watch upload should import respiratory rate and HRV SDNN**, not just HR and stages (`app/api/biometrics/watch-upload`). Today breathing and HRV references only exist in this folder's `watch.json`.
- **Evaluator HRV scoring** needs a like-for-like pod metric before `hrv_sdnn` references can be scored; `comparison.ts` already accepts `hrv_sdnn`.
- Optional: an export endpoint for a DB snapshot + RAW window, so `fetch_raw.sh` and the ssh backup step become one read-only HTTP call.
