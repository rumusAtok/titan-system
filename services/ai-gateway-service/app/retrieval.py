"""Retrieval over approved reference documents.

Visibility is decided in SQL, before any text leaves the database:
- tenant: row-level security (the transaction is bound to the caller's tenant);
- role: a document with `allowed_roles` is visible only to holders of one of them.

Search is lexical (PostgreSQL full-text) and, when an embedding model is
available, also semantic (pgvector). Without a model the lexical path works
on its own, so retrieval never depends on the AI runtime.
"""

from __future__ import annotations

import re
from typing import Any, Awaitable, Callable

from titan_pykit import Database, Principal

from .guard import scan

CHUNK_CHARS = 700
EMBEDDING_DIMENSIONS = 768

Embedder = Callable[[list[str]], Awaitable[list[list[float]]]]


def chunk(text: str, size: int = CHUNK_CHARS) -> list[str]:
    """Splits on paragraphs, packing them into chunks of at most `size` characters."""
    paragraphs = [p.strip() for p in re.split(r"\n\s*\n", text.replace("\r\n", "\n")) if p.strip()]
    chunks: list[str] = []
    current = ""
    for paragraph in paragraphs:
        while len(paragraph) > size:  # a single very long paragraph
            cut = paragraph.rfind(" ", 0, size)
            cut = cut if cut > size // 2 else size
            head, paragraph = paragraph[:cut].strip(), paragraph[cut:].strip()
            if current:
                chunks.append(current)
                current = ""
            chunks.append(head)
        if current and len(current) + len(paragraph) + 2 > size:
            chunks.append(current)
            current = paragraph
        else:
            current = f"{current}\n\n{paragraph}" if current else paragraph
    if current:
        chunks.append(current)
    return chunks


def _vector(values: list[float]) -> str:
    return "[" + ",".join(f"{v:.7f}" for v in values) + "]"


async def add_document(db: Database, user: Principal, title: str, content: str, classification: str, allowed_roles: list[str], source: str, embed: Embedder | None) -> dict[str, Any]:
    pieces = chunk(content)
    vectors: list[list[float]] | None = None
    model_note = "not_embedded"
    if embed is not None and pieces:
        try:
            candidate = await embed(pieces)
            if all(len(v) == EMBEDDING_DIMENSIONS for v in candidate):
                vectors, model_note = candidate, "embedded"
            else:
                model_note = "embedding_dimension_mismatch"
        except Exception:
            model_note = "embedding_unavailable"
    with db.tx(user.tenant_id) as conn:
        document = conn.execute(
            """INSERT INTO reference_documents (tenant_id, title, source, classification, allowed_roles, content, created_by)
               VALUES (%s, %s, %s, %s, %s, %s, %s) RETURNING id, title, classification, allowed_roles, status, created_at""",
            (user.tenant_id, title, source, classification, allowed_roles, content, user.username),
        ).fetchone()
        flagged = 0
        for ordinal, piece in enumerate(pieces):
            is_flagged = bool(scan(piece))
            flagged += is_flagged
            conn.execute(
                """INSERT INTO document_chunks (tenant_id, document_id, ordinal, content, flagged, embedding, embedding_model)
                   VALUES (%s, %s, %s, %s, %s, %s::vector, %s)""",
                (user.tenant_id, document["id"], ordinal, piece, is_flagged, _vector(vectors[ordinal]) if vectors else None, "ollama" if vectors else None),
            )
    return {**document, "chunks": len(pieces), "flagged_chunks": flagged, "embedding": model_note}


_VISIBLE = "d.status = 'approved' AND (cardinality(d.allowed_roles) = 0 OR d.allowed_roles && %(roles)s::text[])"


async def search(db: Database, user: Principal, query: str, limit: int, embed: Embedder | None) -> tuple[list[dict[str, Any]], str]:
    """Returns (hits, mode) where mode is 'hybrid' or 'lexical'."""
    query_vector: str | None = None
    if embed is not None:
        try:
            vector = (await embed([query]))[0]
            if len(vector) == EMBEDDING_DIMENSIONS:
                query_vector = _vector(vector)
        except Exception:
            query_vector = None

    params = {"roles": list(user.roles), "q": query, "limit": limit}
    hits: dict[str, dict[str, Any]] = {}
    with db.tx(user.tenant_id, read_only=True) as conn:
        lexical = conn.execute(
            f"""SELECT c.id, c.document_id, c.ordinal, c.content, c.flagged, d.title, d.classification,
                       ts_rank_cd(c.tsv, websearch_to_tsquery('english', %(q)s)) AS score
                  FROM document_chunks c JOIN reference_documents d ON d.id = c.document_id
                 WHERE {_VISIBLE} AND c.tsv @@ websearch_to_tsquery('english', %(q)s)
                 ORDER BY score DESC LIMIT %(limit)s""",
            params,
        ).fetchall()
        if not lexical:
            # Natural-language questions rarely match every term: fall back to "any term".
            terms = [t for t in re.findall(r"[a-zA-Z]{4,}", query.lower())][:12]
            if terms:
                lexical = conn.execute(
                    f"""SELECT c.id, c.document_id, c.ordinal, c.content, c.flagged, d.title, d.classification,
                               ts_rank_cd(c.tsv, to_tsquery('english', %(any)s)) AS score
                          FROM document_chunks c JOIN reference_documents d ON d.id = c.document_id
                         WHERE {_VISIBLE} AND c.tsv @@ to_tsquery('english', %(any)s)
                         ORDER BY score DESC LIMIT %(limit)s""",
                    {**params, "any": " | ".join(terms)},
                ).fetchall()
        for row in lexical:
            hits[str(row["id"])] = {**row, "match": "lexical"}
        if query_vector is not None:
            semantic = conn.execute(
                f"""SELECT c.id, c.document_id, c.ordinal, c.content, c.flagged, d.title, d.classification,
                           1 - (c.embedding <=> %(v)s::vector) AS score
                      FROM document_chunks c JOIN reference_documents d ON d.id = c.document_id
                     WHERE {_VISIBLE} AND c.embedding IS NOT NULL
                     ORDER BY c.embedding <=> %(v)s::vector LIMIT %(limit)s""",
                {**params, "v": query_vector},
            ).fetchall()
            for row in semantic:
                key = str(row["id"])
                if row["score"] is not None and row["score"] >= 0.45 and key not in hits:
                    hits[key] = {**row, "match": "semantic"}
    ordered = sorted(hits.values(), key=lambda h: (h["match"] != "lexical", -float(h["score"] or 0)))[:limit]
    for h in ordered:
        h["document_id"] = str(h["document_id"])
        h.pop("id", None)
        h["score"] = round(float(h["score"] or 0), 4)
    return ordered, ("hybrid" if query_vector is not None else "lexical")
