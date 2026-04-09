#!/bin/bash
# Nightly backup of Prestige DB with optional GPG encryption.
#
# Usage:
#   ./scripts/backup-db.sh                   # local backup only
#   GPG_RECIPIENT=you@email.com ./backup-db.sh  # encrypted backup
#
# Recommended cron (server crontab -e):
#   0 3 * * * /opt/prestige-build/scripts/backup-db.sh >> /var/log/prestige-backup.log 2>&1

set -euo pipefail

DB_PATH="${DB_PATH:-/data/prestige-pro.db}"
BACKUP_DIR="${BACKUP_DIR:-/data/backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"

mkdir -p "$BACKUP_DIR"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] FATAL: DB not found at $DB_PATH"
  exit 1
fi

# Use sqlite3 .backup for an atomic snapshot (safe even if the DB is in use).
# Falls back to cp if sqlite3 CLI is unavailable.
BACKUP_FILE="$BACKUP_DIR/prestige-$TIMESTAMP.db"
if command -v sqlite3 >/dev/null 2>&1; then
  sqlite3 "$DB_PATH" ".backup '$BACKUP_FILE'"
else
  cp "$DB_PATH" "$BACKUP_FILE"
fi

# Compress
gzip -f "$BACKUP_FILE"
BACKUP_FILE="${BACKUP_FILE}.gz"

# Optional GPG encryption
if [ -n "${GPG_RECIPIENT:-}" ] && command -v gpg >/dev/null 2>&1; then
  gpg --batch --yes --trust-model always --encrypt --recipient "$GPG_RECIPIENT" "$BACKUP_FILE"
  rm -f "$BACKUP_FILE"
  BACKUP_FILE="${BACKUP_FILE}.gpg"
  echo "[backup] encrypted with GPG for $GPG_RECIPIENT"
fi

# Optional rsync to remote (set REMOTE_PATH=user@host:/backups/)
if [ -n "${REMOTE_PATH:-}" ]; then
  rsync -az "$BACKUP_FILE" "$REMOTE_PATH/" && echo "[backup] uploaded to $REMOTE_PATH"
fi

# Cleanup old backups
find "$BACKUP_DIR" -name 'prestige-*.db.gz*' -mtime "+$RETENTION_DAYS" -delete

SIZE=$(du -h "$BACKUP_FILE" | cut -f1)
echo "[backup] OK: $BACKUP_FILE ($SIZE) — retention: ${RETENTION_DAYS} days"
