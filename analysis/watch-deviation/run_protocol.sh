#!/usr/bin/env bash
# One command for anyone with a pod and an Apple Watch: replay the shared
# protocol (protocol.json) over your Watch-covered nights, entirely on your
# machine, and write
#   out/summary.json  de-identified errors only; share it if you want to
#   out/report.html   charts of your own data; keep it local
#
# usage: SP_BIOMETRICS_DIR=/path/to/folder analysis/watch-deviation/run_protocol.sh
#   the folder holds biometrics.db, watch.json (parse_watch.py) and archive/*.RAW.gz,
#   e.g. a `pnpm biometrics:archive pull` destination's <podId>/ folder.
# optional: SP_TIMEZONE=Area/City (defaults to this machine's timezone)
# Takes a few minutes per night on a 10-core machine (18 candidates each).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
: "${SP_BIOMETRICS_DIR:?set SP_BIOMETRICS_DIR to the folder with biometrics.db, watch.json and archive/}"
if [ -z "${SP_TIMEZONE:-}" ]; then
  SP_TIMEZONE=$(readlink /etc/localtime 2>/dev/null | sed 's#.*/zoneinfo/##')
  [ -n "$SP_TIMEZONE" ] || SP_TIMEZONE=$(cat /etc/timezone 2>/dev/null || echo UTC)
fi
export SP_BIOMETRICS_DIR SP_TIMEZONE
cd "$REPO"
run() { "$HERE/run.sh" "$@"; }

SP_SIDE=$(run npx tsx analysis/watch-deviation/protocol.ts side | tail -1)
export SP_SIDE
IDS=$(run npx tsx analysis/watch-deviation/protocol.ts sessions | tail -1)
echo "protocol: side $SP_SIDE, timezone $SP_TIMEZONE, nights $IDS"
run npx tsx analysis/watch-deviation/protocol.ts candidates | tail -1
# One night per bundle: the dataset splitter joins nights that cross local
# noon into one cohort, and a cohort may reference at most 64 archives (~16 h).
rm -rf "$HERE/out/protocol"
for ID in $IDS; do
  echo "night $ID"
  run npx tsx analysis/watch-deviation/build_bundle.ts "$ID" | tail -1
  run npx tsx scripts/biometrics-local-fit/cli.ts fit analysis/watch-deviation/out/bundle.tar \
    analysis/watch-deviation/out/protocol-candidates.json "analysis/watch-deviation/out/protocol/$ID" --include-holdout --save-readings | tail -1
  run npx tsx analysis/watch-deviation/score_readings.ts "analysis/watch-deviation/out/protocol/$ID" "$ID" > "$HERE/out/protocol/$ID/sessions.md"
done
run npx tsx analysis/watch-deviation/summary.ts analysis/watch-deviation/out/protocol | tail -1
run npx tsx analysis/watch-deviation/report.ts "$SP_SIDE" 3 analysis/watch-deviation/out/protocol | tail -1
echo "share (optional): $HERE/out/summary.json · keep local: $HERE/out/report.html"
