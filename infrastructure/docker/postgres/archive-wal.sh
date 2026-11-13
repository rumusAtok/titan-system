#!/bin/sh
# archive_command for PostgreSQL continuous archiving.
#   archive-wal.sh <path of WAL file> <file name>
# Must return non-zero if the file was NOT safely archived, so PostgreSQL
# keeps the segment and retries. Never overwrites an existing archive file.
set -eu

src="$1"
name="$2"
dest_dir="${WAL_ARCHIVE_DIR:-/wal-archive}"
retention_days="${WAL_ARCHIVE_RETENTION_DAYS:-3}"

if [ -f "$dest_dir/$name" ]; then
  # Already archived (e.g. retry after a crash): succeed only if identical.
  cmp -s "$src" "$dest_dir/$name"
  exit $?
fi

cp "$src" "$dest_dir/$name.tmp"
mv "$dest_dir/$name.tmp" "$dest_dir/$name"

# Development-only retention so the local archive volume cannot grow without
# bound. Production retention must be driven by the backup tool (see
# docs/disaster-recovery/backup-and-restore-runbook.md), never by age alone.
find "$dest_dir" -maxdepth 1 -type f -mtime "+$retention_days" -delete 2>/dev/null || true
exit 0
