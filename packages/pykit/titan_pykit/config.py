from __future__ import annotations

import os
from dataclasses import dataclass, field


def _flag(value: str | None, default: bool) -> bool:
    if value is None:
        return default
    return value.strip().lower() in {"1", "true", "yes", "on"}


@dataclass(frozen=True)
class Settings:
    service_name: str
    database_url: str | None
    database_owner_url: str | None
    db_app_role: str | None
    migrate_on_start: bool
    nats_url: str
    oidc_issuer: str
    oidc_jwks_uri: str
    oidc_audience: str
    # Client-credentials identity of this service (for service-to-service calls).
    oidc_token_url: str | None
    client_id: str | None
    client_secret: str | None
    log_level: str
    extra: dict[str, str] = field(default_factory=dict)

    def get(self, key: str, default: str | None = None) -> str | None:
        return self.extra.get(key, default)


def load_settings(env: dict[str, str] | None = None) -> Settings:
    e = dict(os.environ if env is None else env)
    missing = [k for k in ("SERVICE_NAME", "OIDC_ISSUER", "OIDC_JWKS_URI") if not e.get(k)]
    if missing:
        raise RuntimeError(f"invalid service configuration: missing {', '.join(missing)}")
    return Settings(
        service_name=e["SERVICE_NAME"],
        database_url=e.get("DATABASE_URL"),
        database_owner_url=e.get("DATABASE_OWNER_URL"),
        db_app_role=e.get("DB_APP_ROLE"),
        migrate_on_start=_flag(e.get("MIGRATE_ON_START"), True),
        nats_url=e.get("NATS_URL", "nats://localhost:4222"),
        oidc_issuer=e["OIDC_ISSUER"],
        oidc_jwks_uri=e["OIDC_JWKS_URI"],
        oidc_audience=e.get("OIDC_AUDIENCE", "titan-api"),
        oidc_token_url=e.get("OIDC_TOKEN_URL"),
        client_id=e.get("SERVICE_CLIENT_ID"),
        client_secret=e.get("SERVICE_CLIENT_SECRET"),
        log_level=e.get("LOG_LEVEL", "info"),
        extra=e,
    )
