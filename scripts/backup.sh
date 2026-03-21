#!/bin/sh
set -eu

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required" >&2
  exit 1
fi

BACKUP_DIR="${BACKUP_DIR:-./backups}"
TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
OUTPUT_FILE="${BACKUP_DIR}/next-level-${TIMESTAMP}.sql.gz"

mkdir -p "$BACKUP_DIR"

pg_dump "$DATABASE_URL" | gzip > "$OUTPUT_FILE"

find "$BACKUP_DIR" -type f -name '*.sql.gz' -mtime +14 -delete 2>/dev/null || true

echo "$OUTPUT_FILE"
