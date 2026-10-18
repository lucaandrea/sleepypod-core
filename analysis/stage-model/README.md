# Sleep-stage challenger model

An experimental stage classifier that has to beat the pod's rule-based stages
against the Apple Watch. It's trained here (off-device), converted to Core ML,
and run on the iPhone (`SleepStageChallenger.mlmodel` in sleepypod-ios).

## Sources and licences

- **Training data:** "Motion and heart rate from a wrist-worn wearable and labeled sleep from polysomnography" (Walch, 2019), PhysioNet, https://doi.org/10.13026/hmhs-py35. **ODC-By 1.0**, open access, no data-use agreement. Attribution is required, so it's credited in the app.
- **Method:** after ojwalch/sleep_classifiers, whose README states an **MIT** licence (the repo has no LICENSE file). No code is copied; the features and model are reimplemented here.

## Features (the contract the iOS app implements)

5-minute epochs from bed entry; epochs without heart rate are skipped. Per
night: population z-scores of epoch mean HR (`hrZ`), epoch HR std (`hrStdZ`)
and ln(1 + summed movement) (`motionZ`), plus `nightFraction`. Classes: 0 wake,
1 light (N1+N2), 2 deep (N3/N4), 3 rem.

## Reproduce

```sh
# 1. data: 2.2 GB from the AWS Open Data mirror (PhysioNet's own server is ~40 KB/s)
cd analysis/stage-model/data && curl -s "https://physionet-open.s3.amazonaws.com/?list-type=2&prefix=sleep-accel/1.0.0/" \
  | grep -oE '<Key>[^<]+</Key>' | sed -E 's#</?Key>##g' | grep -v /steps/ \
  | xargs -P 8 -I{} sh -c 'mkdir -p "$(dirname {})" && curl -sS --fail -o {} https://physionet-open.s3.amazonaws.com/{}'
# 2. train + score against your pod nights (container; pod folder mounted at /biometrics)
SP_BIOMETRICS_DIR=~/sleepypod-biometrics/pod-88 analysis/watch-deviation/run.sh bash -c \
  'uv run --no-project --python 3.11 --with scikit-learn==1.5.1 --with numpy --with pandas --with joblib python analysis/stage-model/train.py /biometrics'
# 3. convert on macOS (Core ML prediction only runs there); fails if any test vector disagrees
uv run --no-project --python 3.11 --with scikit-learn==1.5.1 --with coremltools==8.3 --with numpy --with joblib python analysis/stage-model/convert.py
```

## v1.0.0 results (2026-10-18)

| | Lab sleep studies, leave-one-subject-out (31 subjects, 2664 epochs) | Pod .88 vs its Watch (9 nights, 642 epochs) |
|---|---|---|
| Pod rule-based stages | n/a | κ ≈ 0.01 |
| Logistic regression | κ 0.29, acc 0.50 | κ 0.11, acc 0.38 |
| **Random forest (shipped)** | **κ 0.35, acc 0.54** | **κ 0.12, acc 0.37** |

The forest is the first stage signal that agrees with the Watch better than
chance on pod data. It's modest because it was trained on Watch PPG heart rate
and wrist motion, then applied to pod piezo HR and bed movement, and because pod
HR tracks the Watch only loosely. Better pod HR/HRV (beat-level, #221) raises
its ceiling; personalising it with each user's own Watch nights is the next step.
