from __future__ import annotations

import time
from typing import Any

import httpx


class ModelUnavailable(Exception):
    pass


class Ollama:
    """Minimal client for a local Ollama server. Every failure maps to ModelUnavailable,
    so callers can fall back to deterministic behaviour."""

    def __init__(self, base_url: str, chat_model: str, embed_model: str, timeout_seconds: float) -> None:
        self.base_url = base_url.rstrip("/")
        self.chat_model = chat_model
        self.embed_model = embed_model
        self._timeout = timeout_seconds
        self._status: dict[str, Any] | None = None
        self._status_at = 0.0

    async def status(self, max_age: float = 15.0) -> dict[str, Any]:
        """Probes the server (cached briefly). Never raises."""
        if self._status is not None and time.monotonic() - self._status_at < max_age:
            return self._status
        result: dict[str, Any] = {"reachable": False, "chat_model_available": False, "embed_model_available": False, "models": [], "error": None}
        try:
            async with httpx.AsyncClient(timeout=3) as client:
                response = await client.get(f"{self.base_url}/api/tags")
            response.raise_for_status()
            names = [m.get("name", "") for m in response.json().get("models", [])]
            result["reachable"] = True
            result["models"] = names
            result["chat_model_available"] = self._has(names, self.chat_model)
            result["embed_model_available"] = self._has(names, self.embed_model)
        except Exception as exc:
            result["error"] = type(exc).__name__
        self._status, self._status_at = result, time.monotonic()
        return result

    @staticmethod
    def _has(names: list[str], wanted: str) -> bool:
        return any(n == wanted or n == f"{wanted}:latest" or n.split(":")[0] == wanted for n in names)

    async def chat(self, system: str, user: str, json_mode: bool = False, max_tokens: int = 500) -> str:
        body: dict[str, Any] = {
            "model": self.chat_model,
            "stream": False,
            "messages": [{"role": "system", "content": system}, {"role": "user", "content": user}],
            "options": {"temperature": 0.1, "num_predict": max_tokens},
        }
        if json_mode:
            body["format"] = "json"
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(f"{self.base_url}/api/chat", json=body)
            response.raise_for_status()
            content = (response.json().get("message") or {}).get("content", "")
        except Exception as exc:
            raise ModelUnavailable(f"{type(exc).__name__}") from exc
        if not content.strip():
            raise ModelUnavailable("empty response")
        return content.strip()

    async def embed(self, texts: list[str]) -> list[list[float]]:
        try:
            async with httpx.AsyncClient(timeout=self._timeout) as client:
                response = await client.post(f"{self.base_url}/api/embed", json={"model": self.embed_model, "input": texts})
            response.raise_for_status()
            vectors = response.json().get("embeddings") or []
        except Exception as exc:
            raise ModelUnavailable(f"{type(exc).__name__}") from exc
        if len(vectors) != len(texts):
            raise ModelUnavailable("unexpected embedding count")
        return vectors
