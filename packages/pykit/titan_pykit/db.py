from __future__ import annotations

import hashlib
import re
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import psycopg
from psycopg import sql
from psycopg.rows import dict_row
from psycopg_pool import ConnectionPool

_FILE_PATTERN = re.compile(r"^\d{4}_[a-z0-9_]+\.sql$")
_LOCK_KEY = 7_480_112  # same key as the Node migration runner


class Database:
    """Connection pool for a service-owned database.

    All access goes through `tx`, which opens a transaction and binds it to a
    tenant through a transaction-local setting read by the row-level security
    policies. `tenant_id=None` leaves the tenant unset: tenant tables then
    return no rows.
    """

    def __init__(self, url: str, application_name: str, max_size: int = 8) -> None:
        self._pool = ConnectionPool(
            url,
            min_size=1,
            max_size=max_size,
            kwargs={"row_factory": dict_row, "application_name": application_name, "options": "-c statement_timeout=30000"},
            open=False,
        )

    def open(self) -> None:
        self._pool.open(wait=False)

    def close(self) -> None:
        self._pool.close()

    @contextmanager
    def tx(self, tenant_id: str | None, read_only: bool = False) -> Iterator[psycopg.Connection[dict[str, Any]]]:
        with self._pool.connection() as conn:
            # The pool commits on normal exit of this block and rolls back on an exception.
            if read_only:
                conn.execute("SET TRANSACTION READ ONLY")
            if tenant_id:
                conn.execute("SELECT set_config('app.tenant_id', %s, true)", (tenant_id,))
            yield conn

    def ping(self) -> bool:
        try:
            with self._pool.connection(timeout=2) as conn:
                conn.execute("SELECT 1")
            return True
        except Exception:
            return False


def _connect_with_retry(url: str, timeout_seconds: float, log) -> psycopg.Connection:
    deadline = time.time() + timeout_seconds
    last: Exception | None = None
    while time.time() < deadline:
        try:
            return psycopg.connect(url, connect_timeout=5, autocommit=True)
        except Exception as exc:  # database still starting
            last = exc
            if log:
                log.warning("database not reachable yet, retrying", error=str(exc).strip())
            time.sleep(2)
    raise RuntimeError(f"could not connect to the database for migrations: {last}")


def run_migrations(owner_url: str, directory: Path, app_role: str | None = None, log=None, connect_timeout: float = 90) -> list[str]:
    """Applies pending `NNNN_name.sql` files in order, each in its own transaction.

    A file already applied whose content changed aborts the run. Safe to run
    from several replicas at once (advisory lock).
    """
    files = sorted(p for p in directory.iterdir() if p.suffix == ".sql") if directory.exists() else []
    bad = [p.name for p in files if not _FILE_PATTERN.match(p.name)]
    if bad:
        raise RuntimeError(f"migration files must be named NNNN_name.sql: {', '.join(bad)}")

    applied: list[str] = []
    conn = _connect_with_retry(owner_url, connect_timeout, log)
    try:
        conn.execute("SELECT pg_advisory_lock(%s)", (_LOCK_KEY,))
        conn.execute(
            """CREATE TABLE IF NOT EXISTS schema_migrations (
                 version text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())"""
        )
        known = {row[0]: row[1] for row in conn.execute("SELECT version, checksum FROM schema_migrations").fetchall()}
        for path in files:
            version = f"service/{path.name}"
            raw = path.read_text(encoding="utf-8")
            checksum = hashlib.sha256(raw.replace("\r\n", "\n").encode()).hexdigest()
            if version in known:
                if known[version] != checksum:
                    raise RuntimeError(f"migration {version} was modified after being applied; add a new migration instead")
                continue
            if "{{APP_ROLE}}" in raw and not app_role:
                raise RuntimeError(f"migration {version} needs DB_APP_ROLE to be configured")
            statement = raw.replace("{{APP_ROLE}}", sql.Identifier(app_role or "").as_string(conn))
            try:
                with conn.transaction():
                    conn.execute(statement.encode())
                    conn.execute("INSERT INTO schema_migrations (version, checksum) VALUES (%s, %s)", (version, checksum))
            except Exception as exc:
                raise RuntimeError(f"migration {version} failed: {exc}") from exc
            applied.append(version)
            if log:
                log.info("migration applied", migration=version)
    finally:
        try:
            conn.execute("SELECT pg_advisory_unlock(%s)", (_LOCK_KEY,))
        finally:
            conn.close()
    return applied
