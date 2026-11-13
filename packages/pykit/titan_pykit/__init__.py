"""TITAN infrastructure helpers for Python services.

Mirrors the Node `@titan/platform` kit: configuration, token verification,
tenant-bound database transactions, migrations, events and observability.
It contains no business logic.
"""

from .auth import Principal, ServiceTokenProvider, TokenVerifier, current_user, require_roles
from .config import Settings, load_settings
from .db import Database, run_migrations
from .errors import DomainError
from .events import EventBus, build_envelope
from .observability import correlation_id, get_logger
from .service import create_app

__all__ = [
    "Database",
    "DomainError",
    "EventBus",
    "Principal",
    "ServiceTokenProvider",
    "Settings",
    "TokenVerifier",
    "build_envelope",
    "correlation_id",
    "create_app",
    "current_user",
    "get_logger",
    "load_settings",
    "require_roles",
    "run_migrations",
]
