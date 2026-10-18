"""Extract Apple Watch HR, HRV (SDNN), respiratory rate and sleep stages from
an Apple Health export.zip into watch.json in $SP_ANALYSIS_DATA (default: data/).

usage: python3 parse_watch.py <export.zip> [since=2026-10-01]

Only samples whose sourceName names a Watch are kept: the export also holds
what the sleepypod iOS app wrote back into Health, which must never be used as
reference.
"""
import io, json, sys, zipfile
from datetime import datetime
import xml.etree.ElementTree as ET
SINCE = datetime.fromisoformat((sys.argv[2] if len(sys.argv) > 2 else '2026-10-01') + 'T00:00:00+00:00').timestamp()
def ms(s):  # "2026-10-17 23:41:02 -0700"
    return int(datetime.strptime(s, '%Y-%m-%d %H:%M:%S %z').timestamp() * 1000)
TYPES = {'HKQuantityTypeIdentifierHeartRate': 'hr', 'HKQuantityTypeIdentifierHeartRateVariabilitySDNN': 'hrv',
         'HKQuantityTypeIdentifierRespiratoryRate': 'rr'}
STAGE = {'HKCategoryValueSleepAnalysisAsleepCore': 'light', 'HKCategoryValueSleepAnalysisAsleepDeep': 'deep',
         'HKCategoryValueSleepAnalysisAsleepREM': 'rem', 'HKCategoryValueSleepAnalysisAwake': 'wake'}
out = {'hr': [], 'hrv': [], 'rr': [], 'stages': []}
sources = {}
zf = zipfile.ZipFile(sys.argv[1])
xml = zf.open(next(n for n in zf.namelist() if n.endswith('/export.xml')))
for _, el in ET.iterparse(xml, events=('end',)):
    if el.tag != 'Record':
        if el.tag not in ('MetadataEntry', 'InstantaneousBeatsPerMinute', 'HeartRateVariabilityMetadataList'): el.clear()
        continue
    t = el.get('type'); src = el.get('sourceName') or ''
    if t in TYPES or t == 'HKCategoryTypeIdentifierSleepAnalysis':
        a = ms(el.get('startDate'))
        if a / 1000 >= SINCE:
            sources[(t, src)] = sources.get((t, src), 0) + 1
            if 'Watch' in src or 'watch' in src:
                if t in TYPES: out[TYPES[t]].append([a, float(el.get('value'))])
                elif el.get('value') in STAGE: out['stages'].append([a, ms(el.get('endDate')), STAGE[el.get('value')]])
    el.clear()
for k in out: out[k].sort()
import os
json.dump(out, open(os.path.join(os.environ.get('SP_ANALYSIS_DATA') or os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data'), 'watch.json'), 'w'))
print({k: len(v) for k, v in out.items()})
for (t, s), n in sorted(sources.items(), key=lambda x: -x[1])[:12]: print(n, t.replace('HKQuantityTypeIdentifier', '').replace('HKCategoryTypeIdentifier', ''), s)
