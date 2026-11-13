from __future__ import annotations

import asyncio
import json
import re
import uuid
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

import nats
from nats.js.api import AckPolicy, ConsumerConfig, DeliverPolicy
from nats.js.errors import NotFoundError

from .observability import correlation_id

EVENT_STREAM = "TITAN_EVENTS"
EVENT_SUBJECT_PREFIX = "titan.events."
_VERSION = re.compile(r"\.v(\d+)$")


def build_envelope(
    event_type: str,
    producer: str,
    aggregate_type: str,
    aggregate_id: str,
    tenant_id: str,
    payload: dict[str, Any],
    actor: dict[str, Any] | None = None,
    causation_id: str | None = None,
) -> dict[str, Any]:
    """Builds the canonical TITAN event envelope (see packages/contracts)."""
    match = _VERSION.search(event_type)
    if not match:
        raise ValueError(f"event type '{event_type}' has no version suffix")
    return {
        "event_id": str(uuid.uuid4()),
        "event_type": event_type,
        "schema_version": int(match.group(1)),
        "producer": producer,
        "aggregate_type": aggregate_type,
        "aggregate_id": aggregate_id,
        "tenant_id": tenant_id,
        "occurred_at": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "correlation_id": correlation_id.get() or str(uuid.uuid4()),
        "causation_id": causation_id,
        "actor": actor,
        "payload": payload,
    }


Handler = Callable[[dict[str, Any], int], Awaitable[None]]


class EventBus:
    """NATS JetStream access for Python services.

    Connecting happens in the background: a service starts and serves
    requests while the broker is unavailable.
    """

    def __init__(self, url: str, service_name: str, log) -> None:
        self._url = url
        self._service = service_name
        self._log = log
        self._nc: nats.NATS | None = None
        self._tasks: list[asyncio.Task] = []
        self._stopping = False

    @property
    def connected(self) -> bool:
        return self._nc is not None and self._nc.is_connected

    async def start(self) -> None:
        self._tasks.append(asyncio.create_task(self._connect()))

    async def _connect(self) -> None:
        while not self._stopping and self._nc is None:
            try:
                self._nc = await nats.connect(self._url, name=self._service, max_reconnect_attempts=-1, reconnect_time_wait=1, connect_timeout=5)
                self._log.info("connected to NATS")
            except Exception as exc:
                self._log.warning("NATS not reachable, retrying", error=str(exc))
                await asyncio.sleep(2)

    async def _ready(self) -> nats.NATS:
        while self._nc is None:
            if self._stopping:
                raise RuntimeError("event bus stopped")
            await asyncio.sleep(0.5)
        return self._nc

    async def publish(self, envelope: dict[str, Any], timeout: float = 5.0) -> bool:
        """Publishes durably. Returns False (and logs) if the broker is unavailable.

        Python services publish events that announce records they have
        already stored durably (run history, tool audit log). Unlike the
        Node services there is no outbox: a failed publish loses only the
        announcement, never the record (see ADR-0007).
        """
        if not self.connected:
            self._log.warning("event not published: broker unavailable", event_type=envelope["event_type"])
            return False
        try:
            js = self._nc.jetstream()  # type: ignore[union-attr]
            await js.publish(
                EVENT_SUBJECT_PREFIX + envelope["event_type"],
                json.dumps(envelope).encode(),
                timeout=timeout,
                headers={"Nats-Msg-Id": envelope["event_id"]},
            )
            return True
        except Exception as exc:
            self._log.warning("event publish failed", event_type=envelope["event_type"], error=str(exc))
            return False

    def consume(self, durable: str, subjects: list[str], handler: Handler, batch: int = 200) -> None:
        """Starts a durable pull consumer. The handler gets (envelope, stream sequence).

        A message is acknowledged only after the handler returns, so the
        handler must be idempotent (at-least-once delivery).
        """
        self._tasks.append(asyncio.create_task(self._consume(durable, subjects, handler, batch)))

    async def _consume(self, durable: str, subjects: list[str], handler: Handler, batch: int) -> None:
        filters = [EVENT_SUBJECT_PREFIX + s for s in subjects]
        while not self._stopping:
            try:
                nc = await self._ready()
                js = nc.jetstream()
                config = ConsumerConfig(
                    durable_name=durable,
                    ack_policy=AckPolicy.EXPLICIT,
                    deliver_policy=DeliverPolicy.ALL,
                    filter_subjects=filters,
                    max_deliver=6,
                    ack_wait=60,
                    max_ack_pending=2000,
                )
                try:
                    await js.consumer_info(EVENT_STREAM, durable)
                except NotFoundError:
                    await js.add_consumer(EVENT_STREAM, config)
                sub = await js.pull_subscribe_bind(durable, EVENT_STREAM)
                self._log.info("event consumer started", consumer=durable, subjects=subjects)
                while not self._stopping:
                    try:
                        messages = await sub.fetch(batch, timeout=2)
                    except (asyncio.TimeoutError, nats.errors.TimeoutError):
                        continue
                    for message in messages:
                        try:
                            envelope = json.loads(message.data)
                            if not isinstance(envelope, dict) or "event_id" not in envelope or "event_type" not in envelope:
                                raise ValueError("not an event envelope")
                        except Exception:
                            await message.term()  # malformed: can never succeed
                            continue
                        try:
                            await handler(envelope, message.metadata.sequence.stream)
                            await message.ack()
                        except Exception as exc:
                            self._log.warning("event handling failed; will retry", event_type=envelope.get("event_type"), error=str(exc))
                            await message.nak(delay=5)
            except asyncio.CancelledError:
                return
            except Exception as exc:
                if not self._stopping:
                    self._log.warning("event consumer interrupted; restarting", consumer=durable, error=str(exc))
                    await asyncio.sleep(2)

    async def stop(self) -> None:
        self._stopping = True
        for task in self._tasks:
            task.cancel()
        await asyncio.gather(*self._tasks, return_exceptions=True)
        if self._nc is not None:
            try:
                await self._nc.drain()
            except Exception:
                pass
