from __future__ import annotations

import re
import time
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncIterator, Awaitable, Callable

from fastapi import FastAPI, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from prometheus_client import CONTENT_TYPE_LATEST, generate_latest
from starlette.exceptions import HTTPException as StarletteHTTPException

from .auth import TokenVerifier
from .config import Settings, load_settings
from .db import Database, run_migrations
from .errors import DomainError
from .events import EventBus
from .observability import correlation_id, get_logger, http_request_duration, new_correlation_id, registry

_CORRELATION = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_QUIET = {"/health/live", "/health/ready", "/metrics"}

Hook = Callable[[FastAPI], Awaitable[None]]


def _problem(status: int, code: str, message: str, details: Any = None) -> JSONResponse:
    error: dict[str, Any] = {"status": status, "code": code, "message": message, "correlation_id": correlation_id.get()}
    if details is not None:
        error["details"] = details
    return JSONResponse(status_code=status, content={"error": error})


def create_app(
    title: str,
    description: str,
    migrations: Path | None = None,
    on_start: Hook | None = None,
    on_stop: Hook | None = None,
    settings: Settings | None = None,
) -> FastAPI:
    """Builds a FastAPI app with the TITAN service conventions: migrations at
    start, token verification, uniform errors, correlation ids, health and
    metrics endpoints. State: app.state.settings / db / bus / verifier / log.
    """
    settings = settings or load_settings()
    log = get_logger(settings.service_name, settings.log_level)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        if migrations is not None and settings.migrate_on_start:
            if not settings.database_owner_url:
                raise RuntimeError("DATABASE_OWNER_URL is required to run migrations")
            applied = run_migrations(settings.database_owner_url, migrations, settings.db_app_role, log)
            log.info("database migrations up to date", applied=len(applied))
        if app.state.db is not None:
            app.state.db.open()
        await app.state.bus.start()
        if on_start:
            await on_start(app)
        log.info(f"{settings.service_name} started")
        try:
            yield
        finally:
            if on_stop:
                await on_stop(app)
            await app.state.bus.stop()
            if app.state.db is not None:
                app.state.db.close()

    app = FastAPI(title=title, description=description, version="0.1.0", lifespan=lifespan, docs_url="/docs", openapi_url="/docs-json", redoc_url=None)
    app.state.settings = settings
    app.state.log = log
    app.state.db = Database(settings.database_url, settings.service_name) if settings.database_url else None
    app.state.bus = EventBus(settings.nats_url, settings.service_name, log)
    app.state.verifier = TokenVerifier(settings.oidc_issuer, settings.oidc_jwks_uri, settings.oidc_audience)

    @app.middleware("http")
    async def observe(request: Request, call_next):
        incoming = request.headers.get("x-correlation-id", "")
        cid = incoming if _CORRELATION.match(incoming) else new_correlation_id()
        token = correlation_id.set(cid)
        started = time.perf_counter()
        status = 500
        try:
            response: Response = await call_next(request)
            status = response.status_code
            response.headers["x-correlation-id"] = cid
            return response
        finally:
            elapsed = time.perf_counter() - started
            route = request.scope.get("route")
            http_request_duration.labels(request.method, getattr(route, "path", "unmatched"), str(status)).observe(elapsed)
            if request.url.path not in _QUIET:
                (log.error if status >= 500 else log.info)(
                    "request completed", http={"method": request.method, "path": request.url.path, "status": status, "duration_ms": round(elapsed * 1000)}
                )
            correlation_id.reset(token)

    @app.exception_handler(DomainError)
    async def domain_error(_: Request, exc: DomainError):
        return _problem(exc.status, exc.code, exc.message, exc.details)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_: Request, exc: RequestValidationError):
        details = [{"path": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
        return _problem(400, "validation_failed", "request validation failed", details)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_: Request, exc: StarletteHTTPException):
        code = {401: "unauthenticated", 403: "forbidden", 404: "not_found", 405: "method_not_allowed", 429: "rate_limited"}.get(exc.status_code, "http_error")
        return _problem(exc.status_code, code, str(exc.detail))

    @app.exception_handler(Exception)
    async def unhandled(_: Request, exc: Exception):
        log.error("unhandled error", exc_info=exc)
        return _problem(500, "internal_error", "internal server error")

    @app.get("/health/live", include_in_schema=False)
    async def live():
        return {"status": "ok", "service": settings.service_name}

    @app.get("/health/ready", include_in_schema=False)
    async def ready(response: Response):
        database = "not_used" if app.state.db is None else ("up" if app.state.db.ping() else "down")
        broker = "up" if app.state.bus.connected else "down"
        is_ready = database != "down"
        if not is_ready:
            response.status_code = 503
        return {
            "status": "unavailable" if not is_ready else ("ok" if broker == "up" else "degraded"),
            "service": settings.service_name,
            "checks": {"database": database, "broker": broker},
        }

    @app.get("/metrics", include_in_schema=False)
    async def metrics():
        return Response(generate_latest(registry), media_type=CONTENT_TYPE_LATEST)

    return app
