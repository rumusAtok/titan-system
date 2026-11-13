from __future__ import annotations

from typing import Any


class DomainError(Exception):
    """Business-rule failure with an HTTP status and a stable machine-readable code."""

    def __init__(self, status: int, code: str, message: str, details: Any = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details

    @classmethod
    def not_found(cls, what: str) -> "DomainError":
        return cls(404, "not_found", f"{what} not found")

    @classmethod
    def forbidden(cls, message: str = "not permitted") -> "DomainError":
        return cls(403, "forbidden", message)

    @classmethod
    def conflict(cls, code: str, message: str) -> "DomainError":
        return cls(409, code, message)

    @classmethod
    def invalid(cls, message: str, details: Any = None) -> "DomainError":
        return cls(400, "validation_failed", message, details)

    @classmethod
    def unavailable(cls, code: str, message: str) -> "DomainError":
        return cls(503, code, message)
