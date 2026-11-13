from __future__ import annotations

import re
import time
from dataclasses import dataclass
from typing import Any, Callable

import httpx
import jwt
from fastapi import Depends, Request

from .errors import DomainError

PLATFORM_TENANT_ID = "00000000-0000-0000-0000-000000000000"
SERVICE_ROLE = "service"
_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.IGNORECASE)


@dataclass(frozen=True)
class Principal:
    """Verified caller identity. Built only from a validated token, never from request input."""

    user_id: str
    username: str
    email: str | None
    tenant_id: str
    roles: tuple[str, ...]
    department: str | None
    is_service: bool
    token: str

    def has_any(self, *roles: str) -> bool:
        return any(r in self.roles for r in roles)


class TokenClaimsError(Exception):
    pass


def principal_from_claims(claims: dict[str, Any], token: str) -> Principal:
    sub = claims.get("sub")
    if not isinstance(sub, str) or not sub:
        raise TokenClaimsError("token has no subject")
    realm_access = claims.get("realm_access") or {}
    raw_roles = realm_access.get("roles") if isinstance(realm_access, dict) else None
    roles = tuple(r for r in (raw_roles or []) if isinstance(r, str))
    is_service = SERVICE_ROLE in roles
    tenant = claims.get("tenant_id")
    if is_service:
        # Machine identities are not tenant members; any tenant claim they carry is ignored.
        tenant = PLATFORM_TENANT_ID
    elif not isinstance(tenant, str) or not _UUID.match(tenant):
        raise TokenClaimsError("token has no valid tenant_id claim")
    email = claims.get("email")
    department = claims.get("department")
    return Principal(
        user_id=sub,
        username=str(claims.get("preferred_username") or sub),
        email=email if isinstance(email, str) else None,
        tenant_id=tenant.lower(),
        roles=roles,
        department=department if isinstance(department, str) else None,
        is_service=is_service,
        token=token,
    )


class TokenVerifier:
    """Verifies signature, issuer, audience and expiry of access tokens."""

    def __init__(self, issuer: str, jwks_uri: str, audience: str, key_resolver: Callable[[str], Any] | None = None) -> None:
        self._issuer = issuer
        self._audience = audience
        if key_resolver is None:
            client = jwt.PyJWKClient(jwks_uri, cache_keys=True, lifespan=600, timeout=5)
            key_resolver = lambda token: client.get_signing_key_from_jwt(token).key  # noqa: E731
        self._key_for = key_resolver

    def verify(self, token: str) -> Principal:
        claims = jwt.decode(
            token,
            self._key_for(token),
            algorithms=["RS256", "ES256", "PS256"],
            issuer=self._issuer,
            audience=self._audience,
            leeway=5,
            options={"require": ["exp", "iss", "aud", "sub"]},
        )
        return principal_from_claims(claims, token)


def current_user(request: Request) -> Principal:
    """FastAPI dependency: the verified caller, or 401."""
    header = request.headers.get("authorization", "")
    if not header.lower().startswith("bearer "):
        raise DomainError(401, "unauthenticated", "missing bearer token")
    verifier: TokenVerifier = request.app.state.verifier
    try:
        principal = verifier.verify(header[7:].strip())
    except Exception as exc:  # any verification failure is the same answer to the caller
        raise DomainError(401, "unauthenticated", "invalid or expired token") from exc
    request.state.principal = principal
    return principal


def require_roles(*roles: str) -> Callable[..., Principal]:
    """FastAPI dependency factory: caller must hold at least one of the roles."""

    def dependency(principal: Principal = Depends(current_user)) -> Principal:
        if roles and not principal.has_any(*roles):
            raise DomainError(403, "forbidden", "insufficient role")
        return principal

    return dependency


class ServiceTokenProvider:
    """Client-credentials access token for service-to-service calls, cached until shortly before expiry."""

    def __init__(self, token_url: str, client_id: str, client_secret: str) -> None:
        self._token_url = token_url
        self._client_id = client_id
        self._client_secret = client_secret
        self._token: str | None = None
        self._expires_at = 0.0

    async def token(self) -> str:
        if self._token and time.time() < self._expires_at - 30:
            return self._token
        async with httpx.AsyncClient(timeout=10) as client:
            response = await client.post(
                self._token_url,
                data={"grant_type": "client_credentials", "client_id": self._client_id, "client_secret": self._client_secret},
            )
        if response.status_code != 200:
            raise RuntimeError(f"could not obtain a service token ({response.status_code})")
        body = response.json()
        self._token = body["access_token"]
        self._expires_at = time.time() + float(body.get("expires_in", 60))
        return self._token
