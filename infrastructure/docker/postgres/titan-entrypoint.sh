#!/bin/bash
# Entry point for TITAN PostgreSQL containers.
#
#   PG_ROLE=primary (default)  normal start; first start runs the init scripts.
#   PG_ROLE=standby            if the data directory is empty, clone the
#                              upstream with pg_basebackup and start as a hot
#                              standby that streams from it.
#
# A standby that already has a data directory simply starts with whatever
# role that directory has (standby, or primary after a promotion). Roles are
# never changed implicitly here: promotion is an explicit operator action.
set -euo pipefail

if [ "${PG_ROLE:-primary}" = "standby" ] && [ ! -s "$PGDATA/PG_VERSION" ]; then
  : "${PG_UPSTREAM_HOST:?PG_UPSTREAM_HOST is required for a standby}"
  : "${PG_REPLICATION_PASSWORD:?PG_REPLICATION_PASSWORD is required for a standby}"
  echo "standby: waiting for upstream ${PG_UPSTREAM_HOST}"
  until pg_isready -h "$PG_UPSTREAM_HOST" -p 5432 -q; do sleep 2; done

  mkdir -p "$PGDATA"
  chown -R postgres:postgres "$PGDATA"
  chmod 700 "$PGDATA"
  echo "standby: cloning ${PG_UPSTREAM_HOST} with pg_basebackup"
  # -R writes standby.signal and primary_conninfo; -X stream includes the WAL needed for consistency.
  PGPASSWORD="$PG_REPLICATION_PASSWORD" gosu postgres pg_basebackup \
    --host="$PG_UPSTREAM_HOST" --port=5432 --username=replicator \
    --pgdata="$PGDATA" --wal-method=stream --write-recovery-conf --checkpoint=fast --no-password
  # Identify this node in the upstream's pg_stat_replication.
  echo "primary_conninfo = 'host=${PG_UPSTREAM_HOST} port=5432 user=replicator password=${PG_REPLICATION_PASSWORD} application_name=${PG_NODE_NAME:-standby}'" \
    >> "$PGDATA/postgresql.auto.conf"
  echo "standby: base backup complete"
fi

exec docker-entrypoint.sh "$@"
