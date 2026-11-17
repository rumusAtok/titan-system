"""Tenant entitlements for Python services.

The Node services keep a local, event-fed projection of entitlements. The
Python services ask tenant-service instead, WITH THE CALLER'S OWN TOKEN (so
the answer is always for the caller's tenant), and cache it briefly.

Failure behaviour is deliberate:
- a fresh answer is cached for `ttl` seconds;
- if tenant-service cannot be reached, the last answer for that tenant is
  used for up to `stale` seconds (an outage must not switch modules off);
- with no usable answer the tenant has NO switchable capability, pack query
  template or pack AI tool: the caller fails closed.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import httpx

from .auth import Principal
from .errors import DomainError


@dataclass(frozen=True)
class TenantEntitlements:
    capabilities: frozenset[str] = frozenset()
    packs: tuple[tuple[str, str], ...] = ()
    query_templates: frozenset[str] = frozenset()
    ai_tools: frozenset[str] = frozenset()
    revision: int = 0
    # False when tenant-service could not be asked and nothing was cached.
    known: bool = True

    def has(self, capability: str | None) -> bool:
        return capability is None or capability in self.capabilities

    @property
    def pack_ids(self) -> frozenset[str]:
        return frozenset(p[0] for p in self.packs)


UNKNOWN = TenantEntitlements(known=False)


def parse(body: dict[str, Any]) -> TenantEntitlements:
    return TenantEntitlements(
        capabilities=frozenset(body.get("capabilities") or []),
        packs=tuple((p["id"], p["version"]) for p in body.get("packs") or []),
        query_templates=frozenset(body.get("query_templates") or []),
        ai_tools=frozenset(body.get("ai_tools") or []),
        revision=int(body.get("revision") or 0),
    )


@dataclass
class EntitlementsClient:
    base_url: str
    ttl: float = 5.0
    stale: float = 600.0
    timeout: float = 3.0
    _cache: dict[str, tuple[float, TenantEntitlements]] = field(default_factory=dict)

    async def of(self, user: Principal) -> TenantEntitlements:
        now = time.monotonic()
        cached = self._cache.get(user.tenant_id)
        if cached and now - cached[0] < self.ttl:
            return cached[1]
        if not self.base_url:
            return UNKNOWN
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                response = await client.get(f"{self.base_url}/entitlements", headers={"authorization": f"Bearer {user.token}"})
            if response.status_code != 200:
                raise httpx.HTTPError(f"tenant-service answered {response.status_code}")
            body = response.json()
            # The answer is bound to the token's tenant by tenant-service; never cache it under another one.
            if body.get("tenant_id") != user.tenant_id:
                return UNKNOWN
            value = parse(body)
            self._cache[user.tenant_id] = (now, value)
            return value
        except (httpx.HTTPError, ValueError, KeyError):
            if cached and now - cached[0] < self.stale:
                return cached[1]
            return UNKNOWN

    async def require(self, user: Principal, capability: str) -> TenantEntitlements:
        """Raises 403 `capability_disabled` unless the caller's tenant has the capability."""
        entitlements = await self.of(user)
        if not entitlements.has(capability):
            raise DomainError(403, "capability_disabled", f"the '{capability}' capability is not active for your organisation", {"capability": capability})
        return entitlements
