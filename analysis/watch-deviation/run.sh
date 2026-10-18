#!/bin/sh
# usage: [SP_BIOMETRICS_DIR=/path [SP_BIOMETRICS_RW=1]] analysis/watch-deviation/run.sh <command...>
# e.g.   SP_BIOMETRICS_DIR=/Volumes/nas/sleepypod analysis/watch-deviation/run.sh npx tsx analysis/watch-deviation/score_live.ts
#
# SP_BIOMETRICS_DIR mounts an off-repo biometrics folder (biometrics.db,
# watch.json, archive/) at /biometrics, read-only unless SP_BIOMETRICS_RW=1,
# and points the scripts at it through SP_ANALYSIS_DATA.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
docker build -q -t sleepypod-analysis "$HERE" >/dev/null

# Docker flags go in front of the command, keeping paths with spaces intact.
CMD_COUNT=$#
set -- "$@" --rm -i \
  -v "$REPO:/work" \
  -v sleepypod-analysis-node-modules:/work/node_modules \
  -v sleepypod-analysis-venv:/work/modules/piezo-processor/.venv
if [ -n "${SP_BIOMETRICS_DIR:-}" ]; then
  [ -d "$SP_BIOMETRICS_DIR" ] || { echo "SP_BIOMETRICS_DIR is not a directory: $SP_BIOMETRICS_DIR" >&2; exit 2; }
  MODE=ro
  [ "${SP_BIOMETRICS_RW:-}" = 1 ] && MODE=rw
  set -- "$@" -v "$(cd "$SP_BIOMETRICS_DIR" && pwd):/biometrics:$MODE" -e SP_ANALYSIS_DATA=/biometrics
fi
set -- "$@" sleepypod-analysis
# Rotate the original command (first CMD_COUNT args) to the end.
i=0
while [ "$i" -lt "$CMD_COUNT" ]; do
  arg=$1
  shift
  set -- "$@" "$arg"
  i=$((i + 1))
done
exec docker run "$@"
