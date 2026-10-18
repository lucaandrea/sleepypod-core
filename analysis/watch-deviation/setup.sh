#!/bin/bash
# Idempotent: install Linux node_modules and the locked piezo-processor venv
# into their volumes the first time, reuse them afterwards.
set -euo pipefail
cd /work
if [ ! -f node_modules/.modules.yaml ] || [ pnpm-lock.yaml -nt node_modules/.modules.yaml ]; then
  CI=1 pnpm install --frozen-lockfile --ignore-scripts=false
fi
if [ ! -x modules/piezo-processor/.venv/bin/python ] || [ modules/piezo-processor/uv.lock -nt modules/piezo-processor/.venv/pyvenv.cfg ]; then
  (cd modules/piezo-processor && uv sync --frozen)
fi
