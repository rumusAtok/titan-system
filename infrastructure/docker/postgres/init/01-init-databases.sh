#!/bin/bash
# Runs once, when the data directory is first initialised.
#
# Database-per-service ownership on a single development instance:
#   titan_<svc>      database
#   <svc>_owner      owns the schema; used only by migrations
#   <svc>_app        least-privilege runtime role; subject to row-level security
#
# Passwords are derived from DB_DEV_PASSWORD (development only). In production
# each role gets an independent secret from the secret manager.
set -euo pipefail

: "${DB_DEV_PASSWORD:?DB_DEV_PASSWORD must be set}"

SERVICES="tenant case workflow notification audit asset device telemetry alert incident analytics pipeline ai"

run_sql() {
  psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$1"
}

for svc in $SERVICES; do
  owner="${svc}_owner"
  app="${svc}_app"
  db="titan_${svc}"
  echo "init: creating ${db}"

  run_sql postgres <<SQL
CREATE ROLE ${owner} LOGIN PASSWORD '${DB_DEV_PASSWORD}_${owner}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE ROLE ${app}   LOGIN PASSWORD '${DB_DEV_PASSWORD}_${app}'   NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
CREATE DATABASE ${db} OWNER ${owner};
REVOKE ALL ON DATABASE ${db} FROM PUBLIC;
GRANT CONNECT ON DATABASE ${db} TO ${app};
SQL

  run_sql "${db}" <<SQL
ALTER SCHEMA public OWNER TO ${owner};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA public TO ${app};
-- Everything the owner creates later is usable (but not alterable) by the app role.
ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${app};
ALTER DEFAULT PRIVILEGES FOR ROLE ${owner} IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO ${app};
SQL
done

# pgvector for the AI knowledge store (extension creation needs elevated rights).
run_sql titan_ai <<SQL
CREATE EXTENSION IF NOT EXISTS vector;
SQL

# Read-only role for approved analytical query templates (used by the AI tools path).
run_sql postgres <<SQL
CREATE ROLE analytics_ro LOGIN PASSWORD '${DB_DEV_PASSWORD}_analytics_ro' NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
GRANT CONNECT ON DATABASE titan_analytics TO analytics_ro;
SQL
run_sql titan_analytics <<SQL
GRANT USAGE ON SCHEMA public TO analytics_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE analytics_owner IN SCHEMA public GRANT SELECT ON TABLES TO analytics_ro;
ALTER ROLE analytics_ro SET default_transaction_read_only = on;
ALTER ROLE analytics_ro SET statement_timeout = '5s';
SQL

# Keycloak identity store.
run_sql postgres <<SQL
CREATE ROLE keycloak LOGIN PASSWORD '${DB_DEV_PASSWORD}_keycloak' NOSUPERUSER NOCREATEDB NOCREATEROLE;
CREATE DATABASE keycloak OWNER keycloak;
REVOKE ALL ON DATABASE keycloak FROM PUBLIC;
SQL

# Monitoring (read-only statistics) and physical replication for the DR lab.
run_sql postgres <<SQL
CREATE ROLE titan_monitor LOGIN PASSWORD '${DB_DEV_PASSWORD}_titan_monitor' NOSUPERUSER NOCREATEDB NOCREATEROLE;
GRANT pg_monitor TO titan_monitor;
CREATE ROLE replicator LOGIN REPLICATION PASSWORD '${DB_DEV_PASSWORD}_replicator';
SQL

echo "host replication replicator all scram-sha-256" >> "$PGDATA/pg_hba.conf"
echo "init: databases and roles created"
