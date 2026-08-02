from __future__ import annotations

from dataclasses import dataclass, field, replace
from threading import RLock
from time import monotonic
from typing import Any

from .models import UsageSnapshot


def _number(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, (str, bytes, bytearray, int, float)):
        return 0
    try:
        return max(0, int(value))
    except (OverflowError, TypeError, ValueError):
        return 0


def _platform(value: object) -> str:
    return str(getattr(value, "value", value) or "").lower()


@dataclass(slots=True)
class SessionTelemetry:
    usage: UsageSnapshot = field(default_factory=UsageSnapshot)
    updated_at: float = field(default_factory=monotonic)
    tools: dict[str, dict[str, object]] = field(default_factory=dict)
    turn_id: str = ""
    terminal_status: str | None = None
    error_message: str = ""


class TelemetryRegistry:
    def __init__(self) -> None:
        self._lock = RLock()
        self._sessions: dict[str, SessionTelemetry] = {}
        self._latest_feishu_session = ""

    def _entry(self, session_id: str) -> SessionTelemetry:
        if session_id not in self._sessions and len(self._sessions) >= 2048:
            oldest = min(self._sessions, key=lambda key: self._sessions[key].updated_at)
            self._sessions.pop(oldest, None)
            if oldest == self._latest_feishu_session:
                self._latest_feishu_session = max(
                    self._sessions,
                    key=lambda key: self._sessions[key].updated_at,
                    default="",
                )
        return self._sessions.setdefault(session_id, SessionTelemetry())

    @staticmethod
    def _begin_turn(entry: SessionTelemetry, turn_id: str) -> None:
        if turn_id and turn_id != entry.turn_id:
            entry.usage = UsageSnapshot()
            entry.tools.clear()
            entry.turn_id = turn_id
        entry.terminal_status = None
        entry.error_message = ""
        entry.updated_at = monotonic()

    def pre_api_request(self, **kwargs: Any) -> None:
        if _platform(kwargs.get("platform")) != "feishu":
            return
        session_id = str(kwargs.get("session_id") or "")
        if not session_id:
            return
        with self._lock:
            entry = self._entry(session_id)
            self._begin_turn(entry, str(kwargs.get("turn_id") or ""))
            self._latest_feishu_session = session_id

    def post_api_request(self, **kwargs: Any) -> None:
        if _platform(kwargs.get("platform")) != "feishu":
            return
        session_id = str(kwargs.get("session_id") or "")
        if not session_id:
            return
        raw_usage_value = kwargs.get("usage")
        raw_usage: dict[str, Any] = dict(raw_usage_value) if isinstance(raw_usage_value, dict) else {}
        with self._lock:
            entry = self._entry(session_id)
            turn_id = str(kwargs.get("turn_id") or "")
            if turn_id and turn_id != entry.turn_id:
                self._begin_turn(entry, turn_id)
            usage = entry.usage
            usage.provider = str(kwargs.get("provider") or usage.provider)
            usage.model = str(kwargs.get("response_model") or kwargs.get("model") or usage.model)
            usage.resolved_ref = str(
                kwargs.get("resolved_ref") or kwargs.get("resolved_model_ref") or usage.resolved_ref
            )
            usage.api = str(kwargs.get("api") or kwargs.get("api_type") or kwargs.get("provider_api") or usage.api)
            usage.transport = str(kwargs.get("transport") or usage.transport)
            usage.input_tokens += _number(raw_usage.get("input_tokens"))
            usage.output_tokens += _number(raw_usage.get("output_tokens"))
            usage.cache_read_tokens += _number(raw_usage.get("cache_read_tokens"))
            usage.cache_write_tokens += _number(raw_usage.get("cache_write_tokens"))
            usage.total_tokens = (
                usage.input_tokens + usage.output_tokens + usage.cache_read_tokens + usage.cache_write_tokens
            )
            usage.duration_ms += round(float(kwargs.get("api_duration") or 0) * 1000)
            finish_reason = str(kwargs.get("finish_reason") or "").lower()
            entry.terminal_status = (
                "completed"
                if _number(kwargs.get("assistant_tool_call_count")) == 0
                and finish_reason not in {"function_call", "tool_call", "tool_calls", "tool_use"}
                else None
            )
            entry.updated_at = monotonic()
            self._latest_feishu_session = session_id

    def api_request_error(self, **kwargs: Any) -> None:
        if _platform(kwargs.get("platform")) != "feishu":
            return
        session_id = str(kwargs.get("session_id") or "")
        if not session_id:
            return
        retryable = bool(kwargs.get("retryable"))
        retry_count = _number(kwargs.get("retry_count"))
        max_retries = _number(kwargs.get("max_retries"))
        terminal = not retryable or (max_retries > 0 and retry_count >= max_retries)
        with self._lock:
            entry = self._entry(session_id)
            turn_id = str(kwargs.get("turn_id") or "")
            if turn_id and turn_id != entry.turn_id:
                self._begin_turn(entry, turn_id)
            if terminal:
                entry.terminal_status = "failed"
                error = kwargs.get("error")
                if isinstance(error, dict):
                    entry.error_message = str(error.get("message") or "")
                else:
                    entry.error_message = str(kwargs.get("error_message") or "")
            entry.updated_at = monotonic()
            self._latest_feishu_session = session_id

    def pre_tool_call(self, **kwargs: Any) -> None:
        platform = _platform(kwargs.get("platform"))
        if platform and platform != "feishu":
            return
        session_id = str(kwargs.get("session_id") or "")
        if not session_id:
            return
        key = str(kwargs.get("tool_call_id") or kwargs.get("tool_name") or len(self._sessions))
        with self._lock:
            if not platform and session_id not in self._sessions:
                return
            entry = self._entry(session_id)
            turn_id = str(kwargs.get("turn_id") or "")
            if turn_id and turn_id != entry.turn_id:
                self._begin_turn(entry, turn_id)
            entry.tools[key] = {
                "name": str(kwargs.get("tool_name") or "tool"),
                "status": "running",
                "args": kwargs.get("args"),
            }
            entry.updated_at = monotonic()
            self._latest_feishu_session = session_id

    def post_tool_call(self, **kwargs: Any) -> None:
        platform = _platform(kwargs.get("platform"))
        if platform and platform != "feishu":
            return
        session_id = str(kwargs.get("session_id") or "")
        if not session_id:
            return
        name = str(kwargs.get("tool_name") or "tool")
        with self._lock:
            if not platform and session_id not in self._sessions:
                return
            entry = self._entry(session_id)
            turn_id = str(kwargs.get("turn_id") or "")
            if turn_id and turn_id != entry.turn_id:
                self._begin_turn(entry, turn_id)
            candidates = [key for key, value in entry.tools.items() if value.get("name") == name]
            requested_key = str(kwargs.get("tool_call_id") or "")
            key = (
                requested_key
                if requested_key in entry.tools
                else candidates[-1]
                if candidates
                else requested_key or name
            )
            entry.tools.setdefault(key, {"name": name})
            entry.tools[key].update(
                {
                    "status": "failed"
                    if kwargs.get("error_type") or kwargs.get("status") in {"error", "blocked"}
                    else "completed",
                    "result": kwargs.get("result"),
                    "error": kwargs.get("error_message"),
                    "duration_ms": _number(kwargs.get("duration_ms")),
                }
            )
            entry.updated_at = monotonic()
            self._latest_feishu_session = session_id

    def snapshot(
        self, session_id: str = ""
    ) -> tuple[str, UsageSnapshot, dict[str, dict[str, object]], str | None, str]:
        with self._lock:
            resolved = session_id or self._latest_feishu_session
            entry = self._sessions.get(resolved)
            if entry is None:
                return "", UsageSnapshot(), {}, None, ""
            return (
                resolved,
                replace(entry.usage),
                {key: dict(value) for key, value in entry.tools.items()},
                entry.terminal_status,
                entry.error_message,
            )


telemetry_registry = TelemetryRegistry()


def on_pre_api_request(**kwargs: Any) -> None:
    telemetry_registry.pre_api_request(**kwargs)


def on_post_api_request(**kwargs: Any) -> None:
    telemetry_registry.post_api_request(**kwargs)


def on_api_request_error(**kwargs: Any) -> None:
    telemetry_registry.api_request_error(**kwargs)


def on_pre_tool_call(**kwargs: Any) -> None:
    telemetry_registry.pre_tool_call(**kwargs)


def on_post_tool_call(**kwargs: Any) -> None:
    telemetry_registry.post_tool_call(**kwargs)
