"""Tools the assistant may use.

Every tool is READ-ONLY and calls the owning service's public API with the
END USER'S OWN TOKEN. The assistant therefore can never see more than the
person asking could see directly: tenant isolation and role checks are
enforced by the services, not re-implemented (or bypassed) here.

`propose_incident_note` is the one tool that relates to a write. It only
records a proposal; nothing is executed until a person approves it.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable, Literal

import httpx
from psycopg.types.json import Jsonb
from pydantic import BaseModel, Field, ValidationError
from titan_pykit import Database, Principal

from . import retrieval

UUID = r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$"


class ToolError(Exception):
    def __init__(self, status: str, detail: str) -> None:
        super().__init__(detail)
        self.status = status  # denied | error | timeout | rejected
        self.detail = detail


@dataclass
class ToolResult:
    data: Any
    sources: list[dict[str, Any]] = field(default_factory=list)
    empty: bool = False
    flags: list[str] = field(default_factory=list)


@dataclass
class ToolContext:
    user: Principal
    db: Database
    urls: dict[str, str]
    timeout: float
    embed: Callable[[list[str]], Awaitable[list[list[float]]]] | None = None

    async def get(self, service: str, path: str, params: dict[str, Any] | None = None) -> Any:
        return await self._call("GET", service, path, params=params)

    async def post(self, service: str, path: str, body: dict[str, Any]) -> Any:
        return await self._call("POST", service, path, json=body)

    async def _call(self, method: str, service: str, path: str, **kwargs: Any) -> Any:
        base = self.urls.get(service)
        if not base:
            raise ToolError("error", f"{service} is not configured")
        try:
            async with httpx.AsyncClient(timeout=self.timeout) as client:
                # On behalf of the user: their token, their permissions.
                response = await client.request(method, f"{base}{path}", headers={"authorization": f"Bearer {self.user.token}"}, **kwargs)
        except httpx.TimeoutException as exc:
            raise ToolError("timeout", f"{service} did not respond in time") from exc
        except httpx.HTTPError as exc:
            raise ToolError("error", f"{service} is unavailable") from exc
        if response.status_code in (401, 403):
            raise ToolError("denied", f"you are not authorised to read this from {service}")
        if response.status_code == 404:
            raise ToolError("error", "the requested record was not found")
        if response.status_code >= 400:
            raise ToolError("error", f"{service} answered {response.status_code}")
        return response.json()


# --- argument schemas ---------------------------------------------------------------


class NoArgs(BaseModel):
    model_config = {"extra": "forbid"}


class ListIncidentsArgs(BaseModel):
    model_config = {"extra": "forbid"}
    status: Literal["active", "open", "acknowledged", "resolved", "closed"] | None = "active"
    severity: Literal["info", "warning", "critical"] | None = None
    limit: int = Field(10, ge=1, le=20)


class IncidentArgs(BaseModel):
    model_config = {"extra": "forbid"}
    incident_id: str = Field(pattern=UUID)


class LimitArgs(BaseModel):
    model_config = {"extra": "forbid"}
    limit: int = Field(5, ge=1, le=20)


class SearchArgs(BaseModel):
    model_config = {"extra": "forbid"}
    query: str = Field(min_length=2, max_length=300)
    limit: int = Field(4, ge=1, le=8)


class TemplateArgs(BaseModel):
    model_config = {"extra": "forbid"}
    name: str = Field(pattern=r"^[a-z_]{3,64}$")
    params: dict[str, Any] = {}


class ProposeNoteArgs(BaseModel):
    model_config = {"extra": "forbid"}
    incident_id: str = Field(pattern=UUID)
    note: str = Field(min_length=3, max_length=1000)
    rationale: str = Field("Requested by the user", max_length=500)


# --- handlers -----------------------------------------------------------------------


async def kpi_summary(ctx: ToolContext, _: NoArgs) -> ToolResult:
    data = await ctx.get("analytics", "/kpis/summary")
    freshness = data.pop("freshness", {}) or {}
    if freshness.get("status") != "loaded":
        return ToolResult(data=None, empty=True)
    return ToolResult(data, [{"type": "dataset", "id": "kpis/summary", "title": "Operational KPI summary", "as_of": freshness.get("computed_at")}])


def _incident_brief(i: dict[str, Any]) -> dict[str, Any]:
    keys = ("id", "reference_no", "title", "severity", "status", "source_type", "created_at", "acknowledged_by", "acknowledged_at", "resolved_at", "assignee_username")
    return {k: i.get(k) for k in keys}


async def list_incidents(ctx: ToolContext, args: ListIncidentsArgs) -> ToolResult:
    params = {k: v for k, v in {"status": args.status, "severity": args.severity, "limit": args.limit}.items() if v is not None}
    incidents = await ctx.get("incident", "/incidents", params)
    brief = [_incident_brief(i) for i in incidents]
    sources = [{"type": "incident", "id": i["id"], "title": f"{i['reference_no']}: {i['title']}", "as_of": i.get("created_at")} for i in brief]
    return ToolResult(brief, sources, empty=not brief)


async def get_incident(ctx: ToolContext, args: IncidentArgs) -> ToolResult:
    incident = await ctx.get("incident", f"/incidents/{args.incident_id}")
    data = {**_incident_brief(incident), "description": incident.get("description"), "timeline": [
        {"at": t.get("occurred_at"), "type": t.get("entry_type"), "by": t.get("actor_username"), "message": t.get("message")} for t in incident.get("timeline", [])
    ]}
    # Free text written by people is untrusted input for a model.
    from .guard import scan

    flags = sorted({f for t in data["timeline"] for f in scan(str(t.get("message") or ""))} | set(scan(str(data.get("description") or ""))))
    return ToolResult(data, [{"type": "incident", "id": incident["id"], "title": f"{incident['reference_no']}: {incident['title']}", "as_of": incident.get("updated_at")}], flags=flags)


async def workflow_bottlenecks(ctx: ToolContext, args: LimitArgs) -> ToolResult:
    result = await ctx.post("analytics", "/query-templates/workflow_bottlenecks/run", {"params": {"limit": args.limit}})
    rows = result.get("rows", [])
    freshness = (result.get("source") or {}).get("freshness") or {}
    return ToolResult(rows, [{"type": "dataset", "id": "pending_tasks", "title": "Pending workflow tasks by stage", "as_of": freshness.get("computed_at")}], empty=not rows)


async def water_levels(ctx: ToolContext, _: NoArgs) -> ToolResult:
    latest = await ctx.get("telemetry", "/latest")
    rows = [
        {"device": r.get("device_name"), "serial_no": r.get("serial_no"), "water_level_m": r.get("value"), "quality": r.get("quality"), "observed_at": r.get("observed_at")}
        for r in latest
        if r.get("sensor_kind") == "water_level"
    ]
    newest = max((r["observed_at"] for r in rows if r["observed_at"]), default=None)
    return ToolResult(rows, [{"type": "telemetry", "id": "latest/water_level", "title": "Latest water-level readings (synthetic sensor data)", "as_of": newest}], empty=not rows)


async def search_documents(ctx: ToolContext, args: SearchArgs) -> ToolResult:
    hits, mode = await retrieval.search(ctx.db, ctx.user, args.query, args.limit, ctx.embed)
    usable = [h for h in hits if not h["flagged"]]
    flags = ["document_chunk_withheld"] if len(usable) != len(hits) else []
    sources = [{"type": "document", "id": h["document_id"], "title": h["title"], "chunk": h["ordinal"], "classification": h["classification"]} for h in usable]
    data = {"retrieval": mode, "passages": [{"title": h["title"], "text": h["content"]} for h in usable]}
    return ToolResult(data, sources, empty=not usable, flags=flags)


async def run_query_template(ctx: ToolContext, args: TemplateArgs) -> ToolResult:
    result = await ctx.post("analytics", f"/query-templates/{args.name}/run", {"params": args.params})
    rows = result.get("rows", [])
    source = result.get("source") or {}
    return ToolResult(rows, [{"type": "dataset", "id": source.get("dataset"), "title": f"Query template {args.name}", "as_of": (source.get("freshness") or {}).get("computed_at")}], empty=not rows)


async def propose_incident_note(ctx: ToolContext, args: ProposeNoteArgs) -> ToolResult:
    """Records a proposal. Performs NO write on the incident."""
    incident = await ctx.get("incident", f"/incidents/{args.incident_id}")  # must exist and be visible to the user
    with ctx.db.tx(ctx.user.tenant_id) as conn:
        row = conn.execute(
            """INSERT INTO pending_actions (tenant_id, action, arguments, rationale, proposed_for)
               VALUES (%s, 'incident.add_note', %s, %s, %s) RETURNING id, expires_at""",
            (ctx.user.tenant_id, Jsonb({"incident_id": args.incident_id, "note": args.note}), args.rationale, ctx.user.username),
        ).fetchone()
    data = {"proposal_id": str(row["id"]), "action": "incident.add_note", "incident": incident["reference_no"], "note": args.note, "status": "pending human approval", "expires_at": row["expires_at"]}
    return ToolResult(data, [{"type": "incident", "id": incident["id"], "title": f"{incident['reference_no']}: {incident['title']}"}])


@dataclass(frozen=True)
class Tool:
    name: str
    description: str
    args: type[BaseModel]
    handler: Callable[[ToolContext, Any], Awaitable[ToolResult]]
    # Offered to the model for selection. Proposals are only created through an explicit request path.
    selectable: bool = True


TOOLS: dict[str, Tool] = {
    t.name: t
    for t in [
        Tool("kpi_summary", "Headline operational indicators: approvals, pending tasks, incidents, sensors, assets. No arguments.", NoArgs, kpi_summary),
        Tool("list_incidents", "List incidents. Arguments: status (active|open|acknowledged|resolved|closed), severity (info|warning|critical), limit.", ListIncidentsArgs, list_incidents),
        Tool("get_incident", "One incident with its timeline. Arguments: incident_id (UUID).", IncidentArgs, get_incident),
        Tool("workflow_bottlenecks", "Workflow stages with the most waiting or overdue tasks. Arguments: limit.", LimitArgs, workflow_bottlenecks),
        Tool("water_levels", "Latest water-level reading of every sensor. No arguments.", NoArgs, water_levels),
        Tool("search_documents", "Search approved reference documents (procedures, guidelines). Arguments: query, limit.", SearchArgs, search_documents),
        Tool("run_query_template", "Run an approved analytical query. Arguments: name, params.", TemplateArgs, run_query_template),
        Tool("propose_incident_note", "Propose adding a note to an incident, for human approval.", ProposeNoteArgs, propose_incident_note, selectable=False),
    ]
}

SELECTABLE = {name for name, tool in TOOLS.items() if tool.selectable}


def catalog_for_prompt() -> str:
    return "\n".join(f"- {t.name}: {t.description}" for t in TOOLS.values() if t.selectable)


async def execute(ctx: ToolContext, name: str, arguments: dict[str, Any], use_case: str, selected_by: str, correlation_id: str | None) -> ToolResult:
    """Validates arguments, runs the tool and writes the audit record, whatever the outcome."""
    started = time.perf_counter()
    status, detail = "ok", None
    try:
        tool = TOOLS.get(name)
        if tool is None:
            raise ToolError("rejected", f"'{name}' is not an available tool")
        try:
            args = tool.args.model_validate(arguments)
        except ValidationError as exc:
            raise ToolError("rejected", "invalid tool arguments: " + "; ".join(f"{'.'.join(map(str, e['loc']))}: {e['msg']}" for e in exc.errors())) from exc
        return await tool.handler(ctx, args)
    except ToolError as exc:
        status, detail = exc.status, exc.detail
        raise
    except Exception as exc:
        status, detail = "error", type(exc).__name__
        raise ToolError("error", "the tool failed") from exc
    finally:
        with ctx.db.tx(ctx.user.tenant_id) as conn:
            conn.execute(
                """INSERT INTO tool_executions (tenant_id, user_id, username, use_case, tool, arguments, status, detail, duration_ms, selected_by, correlation_id)
                   VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                (ctx.user.tenant_id, ctx.user.user_id, ctx.user.username, use_case, name[:64], Jsonb(_safe(arguments)), status, detail,
                 int((time.perf_counter() - started) * 1000), selected_by, correlation_id),
            )


def _safe(arguments: Any) -> Any:
    """Bounds what is written to the audit log."""
    text = str(arguments)
    return arguments if len(text) <= 4000 else {"truncated": text[:4000]}


_UUID_ANYWHERE = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")
_REFERENCE = re.compile(r"\bINC-\d{4}-\d{6}\b", re.I)
_PROCEDURAL = re.compile(
    r"\b(procedure|sop|policy|policies|guideline|guidance|instructions?|what (must|should|does)|how (do|does|should|to)|who (must|should|is responsible)|"
    r"required to|supposed to|steps?|code phrase|contacts?)\b"
)


def route_by_rules(message: str) -> tuple[str, dict[str, Any]]:
    """Deterministic tool selection, used when no model is available or its plan was rejected."""
    text = message.lower()
    found = _UUID_ANYWHERE.search(message)
    if found and "incident" in text:
        return "get_incident", {"incident_id": found.group(0)}
    # "What should / how do I / what is the procedure" asks about guidance, not about live records.
    if _PROCEDURAL.search(text):
        return "search_documents", {"query": message[:300], "limit": 4}
    if re.search(r"\b(bottleneck|backlog|overdue|pending|waiting|stuck|slow|delay)", text) or ("workflow" in text and "incident" not in text):
        return "workflow_bottlenecks", {"limit": 5}
    if "incident" in text or "alarm" in text or "emergenc" in text:
        severity = next((s for s in ("critical", "warning") if s in text), None)
        status = "resolved" if "resolved" in text else "closed" if "closed" in text else "active"
        return "list_incidents", {"status": status, "severity": severity, "limit": 10}
    if re.search(r"\b(water|river|flood|level|gauge|rainfall)\b", text) and not re.search(r"\b(procedure|sop|policy|guideline|should|how do)\b", text):
        return "water_levels", {}
    if re.search(r"\b(kpi|summary|overview|dashboard|how many|status of operations|turnaround|availability|assets?)\b", text):
        return "kpi_summary", {}
    return "search_documents", {"query": message[:300], "limit": 4}


def find_incident_reference(message: str) -> str | None:
    match = _REFERENCE.search(message)
    return match.group(0).upper() if match else None
