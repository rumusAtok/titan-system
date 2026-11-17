#!/bin/bash
# Idempotent: makes sure every service database and its two roles exist.
#
# 01-init-databases.sh runs only when the data directory is first created.
# A service added later (maintenance-service in TITAN v3) would therefore
# have no database on an existing installation. This script closes that gap
# without touching anything that already exists: it only CREATEs what is
# missing. It never drops, alters ownership of, or re-passwords anything.
#
# Run by the `postgres-ensure` one-shot container against the running primary.
set -euo pipefail

: "${DB_DEV_PASSWORD:?DB_DEV_PASSWORD must be set}"
: "${PGHOST:?PGHOST must be set}"
: "${PGUSER:?PGUSER must be set}"

SERVICES="tenant case workflow notification audit asset device telemetry alert incident maintenance analytics pipeline ai"

for attempt in $(seq 1 60); do
  if pg_isready -q -h "$PGHOST" -U "$PGUSER" -d postgres; then break; fi
  sleep 2
done

# A standby cannot create anything; its content arrives from the primary by replication.
if [ "$(psql -Atq -d postgres -c 'SELECT pg_is_in_recovery()')" = "t" ]; then
  echo "ensure: $PGHOST is a standby; nothing to do"
  exit 0
fi

for svc in $SERVICES; do
  owner="${svc}_owner"
  app="${svc}_app"
  db="titan_${svc}"

  for role in "$owner" "$app"; do
    if [ -z "$(psql -Atq -d postgres -c "SELECT 1 FROM pg_roles WHERE rolname = '${role}'")" ]; then
      psql -q -v ON_ERROR_STOP=1 -d postgres -c "CREATE ROLE ${role} LOGIN PASSWORD '${DB_DEV_PASSWORD}_${role}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS"
      echo "ensure: created role ${role}"
    fi
  done

  if [ -z "$(psql -Atq -d postgres -c "SELECT 1 FROM pg_database WHERE datname = '${db}'")" ]; then
    psql -q -v ON_ERROR_STOP=1 -d postgres <<SQL
CREATE DATABASE ${db} OWNER ${owner};
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${db} TO ${app};
SQL
    psql -q -v ON_ERROR_STOP=1 -d "${db}" <<SQL
ALTER SCHEMA public OWNER TO ${owner};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ${app};
ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};
ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app};
SQL
    echo "ensure: created database ${db}"
  fi
done

echo "ensure: all service databases present"
