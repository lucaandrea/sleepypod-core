#!/bin/sh
# usage: analysis/watch-deviation/run.sh <command...>   (from anywhere)
# e.g.   analysis/watch-deviation/run.sh npx tsx analysis/watch-deviation/build_bundle.ts
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
docker build -q -t sleepypod-analysis "$HERE" >/dev/null
exec docker run --rm -i \
  -v "$REPO":/work \
  -v sleepypod-analysis-node-modules:/work/node_modules \
  -v sleepypod-analysis-venv:/work/modules/piezo-processor/.venv \
  sleepypod-analysis "$@"
