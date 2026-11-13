"""Deterministic (template-based) answers.

Used when no model is available or a model call fails. These are plain
renderings of the retrieved records. They are always labelled
`generated_by.kind = "deterministic"` and are never presented as AI output.
"""

from __future__ import annotations

from typing import Any


def _when(value: Any) -> str:
    return str(value).replace("T", " ")[:16] + " UTC" if value else "n/a"


def kpi_summary(d: dict[str, Any]) -> str:
    a, t, i, s, x = d["approvals"], d["workflow_tasks"], d["incidents"], d["sensors"], d["assets"]
    hours = a.get("avg_turnaround_hours")
    return "\n".join(
        [
            "Operational summary [1]:",
            f"- Approvals: {a['completed']} completed ({a['approved']} approved, {a['rejected']} rejected)"
            + (f", average turnaround {hours} h." if hours is not None else "."),
            f"- Workflow: {t['pending']} case task(s) pending, {t['overdue']} overdue.",
            f"- Incidents: {i['total']} recorded; {i['open']} open, {i['acknowledged']} acknowledged, {i['active_critical']} active critical.",
            f"- Sensors: {s['online']} of {s['devices']} online"
            + (f", average availability {s['avg_availability_pct']}% over the last hour." if s.get("avg_availability_pct") is not None else "."),
            f"- Assets: {x['total']} registered, {x['under_maintenance']} under maintenance, {x['maintenance_overdue']} with overdue maintenance.",
        ]
    )


def incidents(rows: list[dict[str, Any]]) -> str:
    lines = [f"{len(rows)} incident(s) found:"]
    for n, r in enumerate(rows, 1):
        lines.append(f"- {r['reference_no']} [{n}]: {r['title']} | severity {r['severity']}, status {r['status']}, created {_when(r['created_at'])}")
    return "\n".join(lines)


def incident(d: dict[str, Any]) -> str:
    lines = [
        f"Incident {d['reference_no']} [1]: {d['title']}",
        f"- Severity: {d['severity']}. Status: {d['status']}. Source: {d.get('source_type')}.",
        f"- Created {_when(d.get('created_at'))}."
        + (f" Acknowledged by {d['acknowledged_by']} at {_when(d['acknowledged_at'])}." if d.get("acknowledged_at") else " Not yet acknowledged.")
        + (f" Resolved at {_when(d['resolved_at'])}." if d.get("resolved_at") else ""),
    ]
    if d.get("description"):
        lines.append(f"- Detail: {d['description']}")
    if d.get("timeline"):
        lines.append("- Timeline:")
        lines.extend(f"  - {_when(t['at'])}: {t['message']}" + (f" ({t['by']})" if t.get("by") else "") for t in d["timeline"][:15])
    return "\n".join(lines)


def bottlenecks(rows: list[dict[str, Any]]) -> str:
    lines = ["Workflow stages with waiting work, most overdue first [1]:"]
    for r in rows:
        age = f", oldest waiting {r['oldest_age_hours']} h" if r.get("oldest_age_hours") is not None else ""
        lines.append(f"- {r['subject_type']} / {r['stage_key']} (role {r['role']}): {r['pending']} pending, {r['overdue']} overdue{age}.")
    worst = rows[0]
    if worst.get("overdue"):
        lines.append(f"The largest overdue backlog is at '{worst['stage_key']}', which waits on role '{worst['role']}'.")
    return "\n".join(lines)


def water_levels(rows: list[dict[str, Any]]) -> str:
    lines = ["Latest water-level readings (synthetic sensor data) [1]:"]
    for r in sorted(rows, key=lambda r: -(r.get("water_level_m") or 0)):
        lines.append(f"- {r['device']} ({r['serial_no']}): {r['water_level_m']} m, quality {r['quality']}, observed {_when(r['observed_at'])}")
    return "\n".join(lines)


def documents(d: dict[str, Any]) -> str:
    lines = [f"Passages found in approved reference documents ({d['retrieval']} search):"]
    for n, p in enumerate(d["passages"], 1):
        text = p["text"] if len(p["text"]) <= 500 else p["text"][:500].rsplit(" ", 1)[0] + " ..."
        lines.append(f"[{n}] {p['title']}:\n{text}")
    return "\n\n".join(lines)


def rows(data: list[dict[str, Any]]) -> str:
    lines = [f"{len(data)} row(s) [1]:"]
    lines.extend("- " + ", ".join(f"{k}={v}" for k, v in r.items()) for r in data[:20])
    return "\n".join(lines)


def proposal(d: dict[str, Any]) -> str:
    return (
        f"I cannot change records myself. I have prepared a proposal for a person to review:\n"
        f"- Action: add a note to incident {d['incident']} [1]\n- Note: {d['note']}\n"
        f"- Proposal id: {d['proposal_id']} (status: {d['status']})\n"
        "Nothing has been changed. An authorised person must approve it under AI workspace > Proposed actions."
    )


RENDERERS = {
    "kpi_summary": kpi_summary,
    "list_incidents": incidents,
    "get_incident": incident,
    "workflow_bottlenecks": bottlenecks,
    "water_levels": water_levels,
    "search_documents": documents,
    "run_query_template": rows,
    "propose_incident_note": proposal,
}


def render(tool: str, data: Any) -> str:
    return RENDERERS[tool](data)


def daily_report(tenant_name: str, sections: dict[str, Any], generated_at: str) -> str:
    parts = [f"DRAFT - Daily operations report - {tenant_name}", f"Prepared {generated_at}. Requires human review before use.", ""]
    numbering = {"kpi_summary": "1. Summary", "list_incidents": "2. Active incidents", "workflow_bottlenecks": "3. Workflow backlog", "water_levels": "4. Water levels"}
    for tool, heading in numbering.items():
        parts.append(heading)
        section = sections.get(tool)
        if section is None:
            parts.append("No records available for this section.")
        elif isinstance(section, str):
            parts.append(section)
        else:
            parts.append(render(tool, section))
        parts.append("")
    return "\n".join(parts).strip()
