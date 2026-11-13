from __future__ import annotations

import contextvars
import json
import logging
import sys
import uuid
from datetime import datetime, timezone

from prometheus_client import CollectorRegistry, Counter, Histogram

correlation_id: contextvars.ContextVar[str | None] = contextvars.ContextVar("correlation_id", default=None)

registry = CollectorRegistry()
http_request_duration = Histogram(
    "titan_http_request_duration_seconds",
    "HTTP request duration in seconds",
    ["method", "route", "status"],
    buckets=(0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60),
    registry=registry,
)
upstream_requests = Counter(
    "titan_upstream_requests_total", "Outbound calls to other services by outcome", ["upstream", "outcome"], registry=registry
)

_REDACT = {"authorization", "password", "token", "client_secret", "access_token"}


class _JsonFormatter(logging.Formatter):
    def __init__(self, service: str) -> None:
        super().__init__()
        self._service = service

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, object] = {
            "level": record.levelname.lower(),
            "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "service": self._service,
            "message": record.getMessage(),
        }
        cid = correlation_id.get()
        if cid:
            entry["correlation_id"] = cid
        extra = getattr(record, "fields", None)
        if isinstance(extra, dict):
            for key, value in extra.items():
                entry[key] = "[redacted]" if key.lower() in _REDACT else value
        if record.exc_info:
            entry["error"] = self.formatException(record.exc_info)
        return json.dumps(entry, default=str)


class _Logger(logging.LoggerAdapter):
    """Structured logging: `log.info("message", key=value)`."""

    def process(self, msg, kwargs):
        fields = {k: kwargs.pop(k) for k in list(kwargs) if k not in ("exc_info", "stack_info", "stacklevel", "extra")}
        kwargs["extra"] = {"fields": fields}
        return msg, kwargs


_configured = False


def get_logger(service: str, level: str = "info") -> _Logger:
    global _configured
    root = logging.getLogger("titan")
    if not _configured:
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(_JsonFormatter(service))
        root.addHandler(handler)
        root.setLevel(level.upper())
        root.propagate = False
        _configured = True
    return _Logger(root, {})


def new_correlation_id() -> str:
    return str(uuid.uuid4())
