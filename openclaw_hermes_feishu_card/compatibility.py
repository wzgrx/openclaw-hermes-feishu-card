from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

from .models import (
    BalanceSummary,
    LegacyRuntimeSnapshot,
    LegacyTaskSummary,
)

_MAX_FILES = 64
_MAX_FILE_BYTES = 64 * 1024


def _mapping(value: object) -> dict[str, Any]:
    return dict(value) if isinstance(value, dict) else {}


def _text(value: object) -> str:
    return value.strip() if isinstance(value, str) else ""


def _number(value: object) -> float | None:
    if isinstance(value, bool):
        return None
    try:
        parsed = float(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    return parsed if parsed == parsed and parsed not in {float("inf"), float("-inf")} else None


def _read_json(path: Path) -> dict[str, Any]:
    try:
        if path.stat().st_size > _MAX_FILE_BYTES:
            return {}
        return _mapping(json.loads(path.read_text(encoding="utf-8")))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}


def _read_tasks(directory: Path) -> tuple[LegacyTaskSummary, ...]:
    try:
        files = sorted(directory.glob("*.json"))[:_MAX_FILES]
    except OSError:
        return ()
    tasks: list[LegacyTaskSummary] = []
    for path in files:
        value = _read_json(path)
        status = _text(value.get("status")).lower()
        if status not in {"running", "stalled"}:
            continue
        task_id = _text(value.get("taskId")) or _text(value.get("id")) or path.stem
        name = _text(value.get("name")) or _text(value.get("title")) or task_id
        progress = _number(value.get("progress"))
        tasks.append(
            LegacyTaskSummary(
                id=task_id,
                name=name[:120],
                status=status,  # type: ignore[arg-type]
                progress=None if progress is None else min(100.0, max(0.0, progress)),
            )
        )
    return tuple(tasks)


def _read_balances(path: Path) -> tuple[BalanceSummary, ...]:
    value = _read_json(path)
    raw_results = value.get("results")
    if not isinstance(raw_results, list):
        return ()
    balances: list[BalanceSummary] = []
    for item in raw_results[:8]:
        current = _mapping(item)
        platform = _text(current.get("platform"))
        total = _number(current.get("total"))
        if not platform or total is None or total < 0:
            continue
        balances.append(
            BalanceSummary(
                platform=platform[:80],
                total=total,
                available=current.get("available") is not False,
            )
        )
    return tuple(balances)


class LegacyRuntimeReader:
    def __init__(
        self,
        task_dir: Path,
        balance_cache_path: Path,
        cache_seconds: float = 10.0,
    ) -> None:
        self._task_dir = task_dir
        self._balance_cache_path = balance_cache_path
        self._cache_seconds = cache_seconds
        self._cached_at = 0.0
        self._cached = LegacyRuntimeSnapshot()

    def sample(self) -> LegacyRuntimeSnapshot:
        now = time.monotonic()
        if now - self._cached_at < self._cache_seconds:
            return self._cached
        self._cached = LegacyRuntimeSnapshot(
            tasks=_read_tasks(self._task_dir),
            balances=_read_balances(self._balance_cache_path),
        )
        self._cached_at = now
        return self._cached
