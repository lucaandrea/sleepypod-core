"""Convert the trained challenger to Core ML and verify it on the card's test vectors.

usage (macOS host, repo root; Core ML prediction only runs on macOS):
  uv run --python 3.11 --with scikit-learn==1.5.1 --with coremltools==8.3 --with numpy python analysis/stage-model/convert.py

Writes out/SleepStageChallenger.mlmodel and out/SleepStageChallenger.card.json,
the two files the iOS app bundles. Fails if any test vector disagrees.
"""
import json
import os

import coremltools as ct
import joblib

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')

card = json.load(open(os.path.join(OUT, 'card.json')))
model = joblib.load(os.path.join(OUT, 'model.joblib'))
mlmodel = ct.converters.sklearn.convert(model, card['features'], 'classLabel')
mlmodel.author = 'sleepypod'
mlmodel.license = 'Model: sleepypod. Training data: Walch 2019, PhysioNet, ODC-By 1.0 (doi:10.13026/hmhs-py35). Method after ojwalch/sleep_classifiers (MIT).'
mlmodel.short_description = 'Experimental sleep-stage challenger (0 wake, 1 light, 2 deep, 3 rem) from per-night z-scored pod HR, HR spread, motion and night fraction. Not a medical device.'
mlmodel.version = card['version']
for name in card['features']:
    mlmodel.input_description[name] = {
        'hrZ': 'Per-night z-score of the 5-minute epoch mean heart rate',
        'hrStdZ': 'Per-night z-score of the epoch heart-rate population std',
        'motionZ': 'Per-night z-score of ln(1 + summed epoch movement)',
        'nightFraction': '(epoch start - bed entry) / (bed exit - bed entry)',
    }[name]
mlmodel.output_description['classLabel'] = '0 wake, 1 light, 2 deep, 3 rem'

path = os.path.join(OUT, 'SleepStageChallenger.mlmodel')
mlmodel.save(path)
mismatches = []
for vector in card['testVectors']:
    got = int(mlmodel.predict(vector['input'])['classLabel'])
    if got != vector['classLabel']:
        mismatches.append((vector, got))
if mismatches:
    raise SystemExit(f'Core ML disagrees with scikit-learn on {len(mismatches)} test vectors: {mismatches[:2]}')
json.dump(card, open(os.path.join(OUT, 'SleepStageChallenger.card.json'), 'w'), indent=2)
print(f'{path} · {len(card["testVectors"])} test vectors match · model {card["model"]} v{card["version"]}')
