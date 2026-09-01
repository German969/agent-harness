#!/bin/bash
# backup.sh — daily SQLite backup for the router state DB.
#
# Uses SQLite's `.backup` (online + consistent even under WAL). Rotates the
# last 30 daily snapshots. Optional S3 upload via `aws` CLI if configured.
#
# Cron:
#   0 3 * * * /opt/dev-team/deploy/backup.sh >> /var/log/agents/backup.log 2>&1

set -euo pipefail

STATE_DB="${STATE_DB:-/var/lib/agents/state.sqlite}"
BACKUP_DIR="${BACKUP_DIR:-/var/lib/agents/backups}"
RETAIN_DAYS="${RETAIN_DAYS:-30}"
S3_BUCKET="${S3_BUCKET:-}" # e.g. s3://<your-bucket>/dev-team-router
DATE=$(date -u +%Y%m%d)
OUT="$BACKUP_DIR/state-$DATE.sqlite"

mkdir -p "$BACKUP_DIR"

echo "[backup] $(date -u +%FT%TZ) starting — src=$STATE_DB dst=$OUT"

# Online backup — safe even if the router is writing concurrently.
sqlite3 "$STATE_DB" ".backup '$OUT'"

# Compress + hash for integrity.
gzip -f "$OUT"
sha256sum "$OUT.gz" > "$OUT.gz.sha256"

echo "[backup] wrote $(stat -c%s "$OUT.gz") bytes"

# Rotate — delete anything older than $RETAIN_DAYS.
find "$BACKUP_DIR" -name 'state-*.sqlite.gz*' -mtime "+$RETAIN_DAYS" -delete

# Optional off-machine copy.
if [ -n "$S3_BUCKET" ]; then
  echo "[backup] uploading to $S3_BUCKET"
  aws s3 cp "$OUT.gz" "$S3_BUCKET/state-$DATE.sqlite.gz"
  aws s3 cp "$OUT.gz.sha256" "$S3_BUCKET/state-$DATE.sqlite.gz.sha256"
fi

echo "[backup] $(date -u +%FT%TZ) done"
