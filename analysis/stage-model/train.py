"""Train the experimental sleep-stage challenger and score it against the Watch.

usage (repo root, in the analysis container):
  uv run --python 3.11 --with scikit-learn==1.5.1 --with numpy --with pandas --with joblib python analysis/stage-model/train.py [podDataDir]

Training data: PhysioNet "Motion and heart rate from a wrist-worn wearable and
labeled sleep from polysomnography" (Walch 2019, ODC-By 1.0), unpacked under
analysis/stage-model/data/. Method after ojwalch/sleep_classifiers (MIT):
heart rate + motion + time of night, classical classifiers.

Features follow the iOS contract exactly (SleepStageChallenger card): 5-minute
epochs from bed entry, epochs without HR skipped, per-night z-scores of epoch
mean HR, HR population std and ln(1 + motion), plus nightFraction. Classes:
0 wake, 1 light (N1+N2), 2 deep (N3+N4), 3 rem.

Outputs (analysis/stage-model/out/): model.joblib, metrics.json, card.json
(metrics, licences, test vectors). Conversion to Core ML is convert.py.
"""
import glob
import json
import math
import os
import sqlite3
import sys

import numpy as np
import pandas as pd
from sklearn.ensemble import RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.metrics import accuracy_score, cohen_kappa_score, confusion_matrix

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, 'data')
OUT = os.path.join(HERE, 'out')
EPOCH_S = 300
FEATURES = ['hrZ', 'hrStdZ', 'motionZ', 'nightFraction']
CLASSES = ['wake', 'light', 'deep', 'rem']
PSG_TO_CLASS = {0: 0, 1: 1, 2: 1, 3: 2, 4: 2, 5: 3}


def zscore(values):
    """Population z-score; a constant column scores 0."""
    v = np.asarray(values, dtype=float)
    sd = v.std()
    return np.zeros_like(v) if sd == 0 else (v - v.mean()) / sd


def night_features(start, end, hr_t, hr_v, mv_t, mv_v):
    """Rows of the four contract features for each 5-minute epoch with HR, plus epoch starts."""
    n = int((end - start) // EPOCH_S)
    rows, starts = [], []
    hr_t, hr_v, mv_t, mv_v = map(np.asarray, (hr_t, hr_v, mv_t, mv_v))
    for i in range(n):
        a = start + i * EPOCH_S
        b = a + EPOCH_S
        hr = hr_v[(hr_t >= a) & (hr_t < b)]
        if hr.size == 0:
            continue
        motion = float(mv_v[(mv_t >= a) & (mv_t < b)].sum()) if mv_v.size else 0.0
        rows.append([float(hr.mean()), float(hr.std()) if hr.size >= 2 else 0.0, math.log1p(max(motion, 0.0)), (a - start) / (end - start)])
        starts.append(a)
    if not rows:
        return np.zeros((0, 4)), []
    m = np.asarray(rows)
    return np.column_stack([zscore(m[:, 0]), zscore(m[:, 1]), zscore(m[:, 2]), m[:, 3]]), starts


def load_walch():
    """One (features, labels, subject) block per PhysioNet subject."""
    root = next(iter(glob.glob(os.path.join(DATA, '**', 'labels'), recursive=True)), None)
    if root is None:
        raise SystemExit('PhysioNet sleep-accel data not found under analysis/stage-model/data/')
    base = os.path.dirname(root)
    blocks = []
    for path in sorted(glob.glob(os.path.join(base, 'labels', '*_labeled_sleep.txt'))):
        sid = os.path.basename(path).split('_')[0]
        lab = pd.read_csv(path, sep=r'\s+', header=None).to_numpy(float)
        hr = pd.read_csv(os.path.join(base, 'heart_rate', f'{sid}_heartrate.txt'), header=None).to_numpy(float)
        acc = pd.read_csv(os.path.join(base, 'motion', f'{sid}_acceleration.txt'), sep=r'\s+', header=None).to_numpy(float)
        start, end = lab[0, 0], lab[-1, 0] + 30
        # Motion: absolute change of acceleration magnitude, a rough activity count.
        mag = np.linalg.norm(acc[:, 1:4], axis=1)
        x, starts = night_features(start, end, hr[:, 0], hr[:, 1], acc[1:, 0], np.abs(np.diff(mag)))
        y, keep = [], []
        for i, a in enumerate(starts):
            sel = lab[(lab[:, 0] >= a) & (lab[:, 0] < a + EPOCH_S), 1]
            mapped = [PSG_TO_CLASS[int(s)] for s in sel if int(s) in PSG_TO_CLASS]
            if len(mapped) >= 5:  # majority of the ten 30-s epochs scored
                y.append(max(set(mapped), key=mapped.count))
                keep.append(i)
        if keep:
            blocks.append((x[keep], np.asarray(y), sid))
    return blocks


def load_pod(data_dir, max_hours=14, min_hours=3):
    """The pod's own nights with Watch stages: features from stored vitals and movement."""
    watch = json.load(open(os.path.join(data_dir, 'watch.json')))
    stages = [(a / 1000, b / 1000, {'wake': 0, 'light': 1, 'deep': 2, 'rem': 3}[s]) for a, b, s in watch['stages']]
    db = sqlite3.connect(f"file:{os.path.join(data_dir, 'biometrics.db')}?mode=ro&immutable=1", uri=True)
    nights = []
    for rid, s, e in db.execute("select id, entered_bed_at, left_bed_at from sleep_records where side='left' and left_bed_at - entered_bed_at between ? and ? order by entered_bed_at", (min_hours * 3600, max_hours * 3600)):
        ref = [(a, b, c) for a, b, c in stages if b > s and a < e]
        if not ref:
            continue
        hr = db.execute("select timestamp, heart_rate from vitals where side='left' and heart_rate is not null and timestamp between ? and ?", (s, e)).fetchall()
        mv = db.execute("select timestamp, total_movement from movement where side='left' and timestamp between ? and ?", (s, e)).fetchall()
        if not hr:
            continue
        x, starts = night_features(s, e, [t for t, _ in hr], [v for _, v in hr], [t for t, _ in mv], [v for _, v in mv])
        y, keep = [], []
        for i, a in enumerate(starts):
            mid = a + EPOCH_S / 2
            hit = next((c for lo, hi, c in ref if lo <= mid < hi), None)
            if hit is not None:
                y.append(hit)
                keep.append(i)
        if keep:
            nights.append((x[keep], np.asarray(y), rid))
    return nights


def models():
    return {
        'logistic': LogisticRegression(max_iter=2000, class_weight='balanced'),
        'forest': RandomForestClassifier(n_estimators=100, max_depth=6, min_samples_leaf=20, class_weight='balanced', random_state=0),
    }


def score(y, p):
    return {'epochs': int(len(y)), 'kappa': round(float(cohen_kappa_score(y, p)), 4), 'accuracy': round(float(accuracy_score(y, p)), 4)}


def main():
    os.makedirs(OUT, exist_ok=True)
    walch = load_walch()
    print(f'PhysioNet: {len(walch)} subjects, {sum(len(y) for _, y, _ in walch)} epochs')
    metrics = {}
    for name in models():
        ys, ps = [], []
        for i, (_, y, _) in enumerate(walch):  # leave one subject out
            train = [b for j, b in enumerate(walch) if j != i]
            m = models()[name]
            m.fit(np.vstack([b[0] for b in train]), np.concatenate([b[1] for b in train]))
            ys.append(y)
            ps.append(m.predict(walch[i][0]))
        metrics[name] = {'loso': score(np.concatenate(ys), np.concatenate(ps))}
        print(name, 'LOSO', metrics[name]['loso'])

    pod = load_pod(sys.argv[1]) if len(sys.argv) > 1 else []
    final = {}
    for name in metrics:
        m = models()[name]
        m.fit(np.vstack([b[0] for b in walch]), np.concatenate([b[1] for b in walch]))
        final[name] = m
        if pod:
            y = np.concatenate([b[1] for b in pod])
            p = np.concatenate([m.predict(b[0]) for b in pod])
            metrics[name]['pod'] = {**score(y, p), 'nights': len(pod),
                                    'confusion': confusion_matrix(y, p, labels=[0, 1, 2, 3]).tolist(),
                                    'perNight': [score(b[1], m.predict(b[0])) for b in pod]}
            print(name, 'pod vs Watch', {k: v for k, v in metrics[name]['pod'].items() if k in ('kappa', 'accuracy', 'epochs', 'nights')})

    best = max(metrics, key=lambda k: (metrics[k].get('pod', metrics[k]['loso'])['kappa'], metrics[k]['loso']['kappa']))
    import joblib
    joblib.dump(final[best], os.path.join(OUT, 'model.joblib'))
    rng = np.random.default_rng(7)
    vectors = rng.normal(size=(12, 4))
    vectors[:, 3] = rng.uniform(0, 1, size=12)
    vectors = vectors.round(6)  # the card stores these exact inputs
    preds = final[best].predict(vectors)
    card = {
        'name': 'SleepStageChallenger',
        'version': '1.0.0',
        'model': best,
        'classes': CLASSES,
        'features': FEATURES,
        'featureSpec': 'iOS contract: 5-minute epochs from bed entry; epochs without HR skipped; per-night population z-scores of epoch mean HR, epoch HR population std (0 if <2 samples) and ln(1 + summed motion); nightFraction = (epochStart - enteredBed) / (leftBed - enteredBed).',
        'metrics': metrics,
        'training': {'dataset': "Motion and heart rate from a wrist-worn wearable and labeled sleep from polysomnography (Walch, 2019), PhysioNet",
                     'doi': 'https://doi.org/10.13026/hmhs-py35', 'license': 'ODC-By 1.0', 'subjects': len(walch)},
        'method': 'After ojwalch/sleep_classifiers (MIT license)',
        'limitations': 'Trained on Apple Watch PPG heart rate and wrist accelerometer motion; applied to pod piezo heart rate and bed movement after per-night normalisation. Experimental, not a medical device.',
        'testVectors': [{'input': dict(zip(FEATURES, map(lambda v: round(float(v), 6), row))), 'classLabel': int(c)} for row, c in zip(vectors, preds)],
    }
    json.dump(metrics, open(os.path.join(OUT, 'metrics.json'), 'w'), indent=2)
    json.dump(card, open(os.path.join(OUT, 'card.json'), 'w'), indent=2)
    print('chosen', best, '→', os.path.join(OUT, 'model.joblib'))


if __name__ == '__main__':
    main()
