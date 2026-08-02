from __future__ import annotations

import json
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime, tzinfo
from math import isfinite
from pathlib import Path
from threading import RLock
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from .models import Currency, UsageSnapshot, UsageTotals


@dataclass(frozen=True, slots=True)
class _LedgerRecord:
    timestamp: float
    tokens: int
    cost: float
    currency: Currency | None


class UsageLedger:
    def __init__(self, storage_dir: Path, timezone: str) -> None:
        self._path = storage_dir / "usage.ndjson"
        resolved_timezone: tzinfo = UTC
        with suppress(ZoneInfoNotFoundError):
            resolved_timezone = ZoneInfo(timezone)
        self._timezone = resolved_timezone
        self._lock = RLock()

    def append(
        self,
        runtime: str,
        session_id: str,
        usage: UsageSnapshot,
        timestamp_ms: int,
    ) -> bool:
        record = {
            "schemaVersion": 1,
            "id": session_id,
            "runtime": runtime,
            "timestamp": timestamp_ms,
            "usage": {
                "provider": usage.provider,
                "model": usage.model,
                "resolvedRef": usage.resolved_ref,
                "api": usage.api,
                "transport": usage.transport,
                "inputTokens": usage.input_tokens,
                "outputTokens": usage.output_tokens,
                "cacheReadTokens": usage.cache_read_tokens,
                "cacheWriteTokens": usage.cache_write_tokens,
                "totalTokens": usage.total_tokens,
                "contextUsedTokens": usage.context_used_tokens,
                "contextTokenBudget": usage.context_token_budget,
                "durationMs": usage.duration_ms,
                "turnCost": usage.turn_cost,
                "currency": usage.currency,
            },
        }
        with self._lock:
            self._path.parent.mkdir(parents=True, exist_ok=True)
            if session_id in self._read_records():
                return False
            with self._path.open("a", encoding="utf-8", newline="\n") as handle:
                handle.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")
        return True

    def totals(self, now_ms: int | None = None) -> UsageTotals:
        now = datetime.fromtimestamp((now_ms or round(datetime.now().timestamp() * 1000)) / 1000, self._timezone)
        totals = UsageTotals()
        if not self._path.exists():
            return totals
        currencies: set[Currency] = set()
        with self._lock:
            for record in self._read_records().values():
                stamp = datetime.fromtimestamp(record.timestamp / 1000, self._timezone)
                tokens = record.tokens
                cost = record.cost
                currency = record.currency
                totals.all_time_tokens += tokens
                totals.all_time_cost += cost
                if stamp.year == now.year and stamp.month == now.month:
                    totals.month_tokens += tokens
                    totals.month_cost += cost
                if stamp.date() == now.date():
                    totals.today_tokens += tokens
                    totals.today_cost += cost
                if currency is not None:
                    currencies.add(currency)
        totals.currency = next(iter(currencies)) if len(currencies) == 1 else None
        return totals

    def _read_records(self) -> dict[str, _LedgerRecord]:
        records: dict[str, _LedgerRecord] = {}
        if not self._path.exists():
            return records
        for line_number, raw in enumerate(
            self._path.read_text(encoding="utf-8").splitlines(),
            start=1,
        ):
            try:
                value = json.loads(raw)
                if not isinstance(value, dict):
                    continue
                runtime = value.get("runtime")
                record_id = value.get("id") or value.get("sessionId")
                timestamp = float(value["timestamp"])
                if runtime not in {"openclaw", "hermes"} or not isinstance(record_id, str):
                    continue
                usage_value = value.get("usage")
                usage = usage_value if isinstance(usage_value, dict) else {}
                tokens = _number(
                    value.get("tokens"),
                    usage.get("totalTokens"),
                    usage.get("total_tokens"),
                )
                if tokens is None:
                    tokens = (
                        (_number(usage.get("inputTokens"), usage.get("input_tokens")) or 0)
                        + (_number(usage.get("outputTokens"), usage.get("output_tokens")) or 0)
                        + (
                            _number(
                                usage.get("cacheReadTokens"),
                                usage.get("cache_read_tokens"),
                            )
                            or 0
                        )
                        + (
                            _number(
                                usage.get("cacheWriteTokens"),
                                usage.get("cache_write_tokens"),
                            )
                            or 0
                        )
                    )
                cost = (
                    _number(
                        value.get("cost"),
                        usage.get("turnCost"),
                        usage.get("turn_cost"),
                    )
                    or 0.0
                )
                raw_currency = value.get("currency") or usage.get("currency")
                currency: Currency | None = raw_currency if raw_currency in {"CNY", "USD"} else None
            except (KeyError, TypeError, ValueError, json.JSONDecodeError, OSError):
                continue
            key = record_id or f"legacy:{runtime}:{timestamp}:{line_number}"
            records[key] = _LedgerRecord(
                timestamp=timestamp,
                tokens=max(0, int(tokens)),
                cost=max(0.0, float(cost)),
                currency=currency,
            )
        return records


def _number(*values: object) -> float | None:
    for value in values:
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        parsed = float(value)
        if isfinite(parsed):
            return parsed
    return None
