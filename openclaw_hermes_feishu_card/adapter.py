from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from typing import Any

from gateway.platforms.base import SendResult
from gateway.session_context import get_session_env
from plugins.platforms.feishu.adapter import FeishuAdapter

from .client import CardKitClient
from .compatibility import LegacyRuntimeReader
from .config import HermesCardConfig
from .ledger import UsageLedger
from .markers import decode_markers, encode_marker, split_reasoning
from .models import CardSession, ToolStatus, now_ms
from .pricing import calculate_cost, resolve_pricing_rule
from .render import render_card
from .resources import sample_resources
from .telemetry import telemetry_registry

logger = logging.getLogger(__name__)


def _current_session_id() -> str:
    value = get_session_env("HERMES_SESSION_ID")
    return str(value).strip() if value else ""


def _json_preview(value: object, limit: int = 900) -> str:
    try:
        text = json.dumps(value, ensure_ascii=False, default=str, separators=(",", ":"))
    except (TypeError, ValueError):
        text = str(value)
    return text if len(text) <= limit else text[: limit - 1] + "…"


def _duration_ms(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (str, bytes, bytearray, int, float)):
        return None
    try:
        result = int(value)
    except (OverflowError, TypeError, ValueError):
        return None
    return result if result > 0 else None


def _attachment_summaries(metadata: dict[str, Any] | None) -> list[str]:
    if not metadata:
        return []
    raw = metadata.get("attachments") or metadata.get("files") or metadata.get("media")
    if not isinstance(raw, list):
        return []
    summaries: list[str] = []
    for item in raw:
        if isinstance(item, str):
            value = item.strip()
        elif isinstance(item, dict):
            value = str(item.get("summary") or item.get("name") or item.get("filename") or "").strip()
        else:
            value = ""
        if value:
            summaries.append(value[:200])
    return summaries[:8]


class HermesFeishuCardAdapter(FeishuAdapter):  # type: ignore[misc]
    """Hermes' native Feishu transport with CardKit streaming presentation."""

    REQUIRES_EDIT_FINALIZE = True

    def __init__(self, config: Any):
        super().__init__(config)
        self._card_config = HermesCardConfig.from_extra(getattr(config, "extra", None))
        self._ledger = UsageLedger(self._card_config.storage_dir, self._card_config.timezone)
        self._legacy_runtime = LegacyRuntimeReader(
            self._card_config.legacy_task_dir,
            self._card_config.balance_cache_path,
        )
        self._sessions: dict[str, CardSession] = {}
        self._by_message: dict[str, CardSession] = {}
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._last_flush: dict[str, float] = {}

    @staticmethod
    def _route_key(chat_id: str, reply_to: str | None, metadata: dict[str, Any] | None) -> str:
        meta = metadata or {}
        anchor = reply_to or str(meta.get("reply_to_message_id") or meta.get("thread_id") or "")
        return f"{chat_id}\x1f{anchor}"

    def _resolve_session(
        self,
        chat_id: str,
        reply_to: str | None,
        metadata: dict[str, Any] | None,
        *,
        create: bool,
        session_id: str = "",
    ) -> CardSession | None:
        self._prune_sessions()
        key = self._route_key(chat_id, reply_to, metadata)
        session = self._sessions.get(key)
        if session is not None and session.status == "running":
            return session
        if session is not None:
            self._discard_session(session)
        # Hermes sends tool progress and the answer through two queues. In DMs
        # only the answer carries the original message id, so reuse the latest
        # still-running card in the same chat and add the stronger route alias.
        active = [
            candidate
            for candidate in {candidate.id: candidate for candidate in self._sessions.values()}.values()
            if candidate.chat_id == chat_id
            and candidate.status == "running"
            and (not session_id or candidate.session_id == session_id)
        ]
        if len(active) == 1:
            session = max(active, key=lambda candidate: candidate.updated_at)
            self._sessions[key] = session
            if reply_to and session.reply_to is None:
                session.reply_to = reply_to
            if metadata:
                session.metadata = dict(metadata)
                session.attachments = _attachment_summaries(metadata)
            return session
        if not create:
            return None
        session_id = session_id or _current_session_id()
        digest = hashlib.sha256(f"{key}\x1f{time.time_ns()}".encode()).hexdigest()[:20]
        virtual_message_id = f"hfc-tool-{digest}"
        session = CardSession(
            id=f"hermes-{digest}",
            route_key=key,
            chat_id=chat_id,
            reply_to=reply_to,
            metadata=dict(metadata) if metadata else None,
            session_id=session_id,
            virtual_message_id=virtual_message_id,
            attachments=_attachment_summaries(metadata),
        )
        self._sessions[key] = session
        self._by_message[virtual_message_id] = session
        return session

    def _discard_session(self, session: CardSession) -> None:
        self._sessions = {key: value for key, value in self._sessions.items() if value is not session}
        self._by_message = {key: value for key, value in self._by_message.items() if value is not session}
        self._session_locks.pop(session.id, None)
        self._last_flush.pop(session.id, None)

    def _prune_sessions(self, *, limit: int = 256, ttl_ms: int = 30 * 60 * 1000) -> None:
        unique = {session.id: session for session in self._sessions.values()}
        current = now_ms()
        stale = [
            session
            for session in unique.values()
            if session.status != "running" and current - session.updated_at >= ttl_ms
        ]
        remaining = len(unique) - len(stale)
        if remaining > limit:
            candidates = sorted(
                (session for session in unique.values() if session.status != "running" and session not in stale),
                key=lambda session: session.updated_at,
            )
            stale.extend(candidates[: remaining - limit])
        for session in stale:
            self._discard_session(session)

    def _lock_for(self, session: CardSession) -> asyncio.Lock:
        return self._session_locks.setdefault(session.id, asyncio.Lock())

    def _refresh_telemetry(self, session: CardSession) -> str | None:
        session_id, usage, tools, terminal_status, error_message = telemetry_registry.snapshot(session.session_id)
        if session_id:
            session.session_id = session_id
        rule = resolve_pricing_rule(self._card_config.pricing, usage.provider, usage.model)
        usage.turn_cost = calculate_cost(usage, rule)
        if rule is not None:
            usage.currency = rule.currency
        session.usage = usage
        for tool_id, data in tools.items():
            name = str(data.get("name") or "tool")
            status_value = str(data.get("status") or "running")
            status: ToolStatus = (
                "failed" if status_value == "failed" else "completed" if status_value == "completed" else "running"
            )
            # Prefer a marker-derived step with the same name; hooks may use a
            # provider-specific tool_call_id that the stream event omits.
            matching = [step.id for step in session.tools.values() if step.name == name]
            resolved_id = matching[-1] if matching else str(tool_id)
            session.upsert_tool(
                tool_id=resolved_id,
                name=name,
                status=status,
                input_preview=_json_preview(data.get("args")) if data.get("args") is not None else "",
                output_preview=_json_preview(data.get("result")) if data.get("result") is not None else "",
                error=str(data.get("error") or ""),
                duration_ms=_duration_ms(data.get("duration_ms")),
            )
        if error_message and (not session.notices or session.notices[-1] != error_message):
            session.notices.append(error_message[:900])
        return terminal_status

    async def _send_card_reference(self, session: CardSession, card_id: str) -> SendResult:
        payload = json.dumps(
            {"type": "card", "data": {"card_id": card_id}},
            ensure_ascii=False,
            separators=(",", ":"),
        )
        response = await self._feishu_send_with_retry(
            chat_id=session.chat_id,
            msg_type="interactive",
            payload=payload,
            reply_to=session.reply_to,
            metadata=session.metadata,
        )
        return self._finalize_send_result(response, "CardKit message send failed")

    async def _flush(self, session: CardSession, *, force: bool = False) -> SendResult:
        if self._client is None:
            return SendResult(success=False, error="Feishu client is not connected")
        async with self._lock_for(session):
            now = time.monotonic()
            last = self._last_flush.get(session.id, 0.0)
            if not force and session.card_id is not None and (now - last) * 1000 < self._card_config.update_interval_ms:
                return SendResult(success=True, message_id=session.message_id or session.virtual_message_id)
            self._refresh_telemetry(session)
            if session.status != "running" and not session.ledger_written:
                self._ledger.append("hermes", session.id, session.usage, session.completed_at or now_ms())
                session.ledger_written = True
            totals = self._ledger.totals()
            card = render_card(
                session,
                totals,
                self._card_config,
                resource=sample_resources() if self._card_config.panels.resources else None,
                legacy=self._legacy_runtime.sample()
                if self._card_config.footer.background_tasks or self._card_config.footer.balance
                else None,
                now=now_ms(),
            )
            client = CardKitClient(self._client)
            if session.card_id is None:
                session.card_id = await client.create(card)
                result = await self._send_card_reference(session, session.card_id)
                if not result.success:
                    session.card_id = None
                    return result
                session.message_id = str(result.message_id) if result.message_id else None
                if session.message_id:
                    self._by_message[session.message_id] = session
            else:
                session.sequence += 1
                await client.update(session.card_id, card, session.sequence)
                result = SendResult(success=True, message_id=session.message_id)
                if session.status != "running":
                    session.sequence += 1
                    await client.close_stream(session.card_id, session.sequence)
            self._last_flush[session.id] = now
            return result

    @staticmethod
    def _apply_markers(session: CardSession, markers: list[dict[str, Any]]) -> None:
        for offset, marker in enumerate(markers):
            marker_session_id = str(marker.get("sessionId") or "")
            if marker_session_id and not session.session_id:
                session.session_id = marker_session_id
            name = str(marker.get("name") or "tool")
            index = marker.get("index")
            tool_id = str(index if index is not None else f"{name}:{offset}")
            args = marker.get("args")
            preview = str(marker.get("preview") or "")
            session.upsert_tool(
                tool_id=tool_id,
                name=name,
                input_preview=_json_preview(args) if args else preview[:900],
            )

    def format_tool_event(
        self,
        event: Any,
        *,
        mode: str = "all",
        preview_max_len: int = 40,
    ) -> str | None:
        name = str(getattr(event, "tool_name", "") or "")
        if not name:
            return None
        return encode_marker(
            {
                "name": name,
                "index": getattr(event, "index", None),
                "preview": str(getattr(event, "preview", "") or "")[: max(40, preview_max_len)],
                "args": getattr(event, "args", None) if mode == "verbose" else None,
                "sessionId": _current_session_id(),
            }
        )

    def render_message_event(self, event: Any, sink: Any) -> None:
        from gateway.stream_events import Commentary

        if isinstance(event, Commentary):
            text = str(getattr(event, "text", "") or "").strip()
            if text:
                sink.on_delta(f"<reasoning>{text}</reasoning>")
            return
        super().render_message_event(event, sink)

    async def send(
        self,
        chat_id: str,
        content: str,
        reply_to: str | None = None,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        if not self._card_config.enabled:
            return await super().send(chat_id, content, reply_to=reply_to, metadata=metadata)
        markers = decode_markers(content)
        stream_delivery = bool((metadata or {}).get("expect_edits"))
        final_delivery = bool((metadata or {}).get("notify"))
        if not markers and not stream_delivery and not final_delivery:
            return await super().send(chat_id, content, reply_to=reply_to, metadata=metadata)

        marker_session_id = next(
            (str(marker.get("sessionId")) for marker in markers if marker.get("sessionId")),
            "",
        )
        session = self._resolve_session(
            chat_id,
            reply_to,
            metadata,
            create=True,
            session_id=marker_session_id or _current_session_id(),
        )
        assert session is not None
        fallback_content = content
        if markers:
            self._apply_markers(session, markers)
        else:
            answer, reasoning = split_reasoning(content)
            session.set_answer(answer)
            if answer:
                fallback_content = answer
            if reasoning:
                session.reasoning = reasoning
            if final_delivery and (terminal_status := self._refresh_telemetry(session)):
                session.finish("failed" if terminal_status == "failed" else "completed")
        try:
            result = await self._flush(session, force=session.card_id is None or session.status != "running")
        except Exception as exc:
            logger.warning("[openclaw-hermes-feishu-card] CardKit send failed: %s", exc, exc_info=True)
            if markers:
                display = "\n".join(f"⚙️ {marker.get('name', 'tool')}…" for marker in markers)
                return await super().send(chat_id, display, reply_to=reply_to, metadata=metadata)
            return await super().send(chat_id, fallback_content, reply_to=reply_to, metadata=metadata)
        if not result.success:
            if markers:
                display = "\n".join(f"⚙️ {marker.get('name', 'tool')}…" for marker in markers)
                return await super().send(chat_id, display, reply_to=reply_to, metadata=metadata)
            return await super().send(chat_id, fallback_content, reply_to=reply_to, metadata=metadata)
        if markers:
            return SendResult(
                success=result.success,
                message_id=session.virtual_message_id if result.success else None,
                error=result.error,
                raw_response=result.raw_response,
                retryable=result.retryable,
            )
        return SendResult(
            success=result.success,
            message_id=session.message_id if result.success else None,
            error=result.error,
            raw_response=result.raw_response,
            retryable=result.retryable,
        )

    async def edit_message(
        self,
        chat_id: str,
        message_id: str,
        content: str,
        *,
        finalize: bool = False,
        metadata: dict[str, Any] | None = None,
    ) -> SendResult:
        session = self._by_message.get(message_id)
        if not self._card_config.enabled or session is None:
            return await super().edit_message(chat_id, message_id, content, finalize=finalize)
        markers = decode_markers(content)
        fallback_content = content
        if markers:
            self._apply_markers(session, markers)
        else:
            answer, reasoning = split_reasoning(content)
            session.set_answer(answer)
            if answer:
                fallback_content = answer
            if reasoning:
                session.reasoning = reasoning
        if finalize and (terminal_status := self._refresh_telemetry(session)):
            session.finish("failed" if terminal_status == "failed" else "completed")
        try:
            result = await self._flush(session, force=finalize)
        except Exception as exc:
            logger.warning("[openclaw-hermes-feishu-card] CardKit update failed: %s", exc, exc_info=True)
            if message_id.startswith("hfc-tool-"):
                return SendResult(success=False, error=str(exc), retryable=True)
            return await super().edit_message(chat_id, message_id, fallback_content, finalize=finalize)
        return SendResult(
            success=result.success,
            message_id=message_id,
            error=result.error,
            raw_response=result.raw_response,
            retryable=result.retryable,
        )

    async def delete_message(self, chat_id: str, message_id: str) -> bool:
        if message_id.startswith("hfc-tool-"):
            return True
        return bool(await super().delete_message(chat_id, message_id))
