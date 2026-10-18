#!/bin/sh
# Copy the pod's gzipped RAW archives that cover the given UTC windows into data/archive/.
# usage: fetch_raw.sh POD "2026-10-18 09:14|2026-10-18 16:22" ["start|end" ...]
# A frame is gzipped ~15 min after it closes, so each window is widened by 20 min
# before and 45 min after on the archive file's mtime.
set -eu
POD=$1; shift
DIR=$(cd "$(dirname "$0")" && pwd)/data/archive
mkdir -p "$DIR"
for w in "$@"; do
  a=${w%|*}; b=${w#*|}
  ssh -p 8822 -o BatchMode=yes "root@$POD" \
    "cd /persistent/biometrics-archive && find . -maxdepth 1 -name '*.RAW.gz' -newermt \"\$(date -u -d '$a UTC 20 minutes ago' '+%Y-%m-%d %H:%M:%S')\" ! -newermt \"\$(date -u -d '$b UTC 45 minutes' '+%Y-%m-%d %H:%M:%S')\" | sed 's|^./||'" > "$DIR/.list"
  echo "$w: $(wc -l < "$DIR/.list") archives"
  (cd "$DIR" && ssh -p 8822 -o BatchMode=yes "root@$POD" "cd /persistent/biometrics-archive && tar cf - $(tr '\n' ' ' < "$DIR/.list")" | tar xf -)
done
rm -f "$DIR/.list"
ls "$DIR" | wc -l; du -sh "$DIR"
