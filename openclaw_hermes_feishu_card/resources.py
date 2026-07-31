from __future__ import annotations

import os
import subprocess
import time
from collections.abc import Callable
from contextlib import suppress
from pathlib import Path
from typing import cast

from .models import ResourceSnapshot, now_ms


def _linux_memory() -> tuple[int, int]:
    path = Path("/proc/meminfo")
    if not path.exists():
        return 0, 0
    values: dict[str, int] = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        name, _, raw = line.partition(":")
        try:
            values[name] = int(raw.strip().split()[0]) * 1024
        except (IndexError, ValueError):
            continue
    total = values.get("MemTotal", 0)
    available = values.get("MemAvailable", values.get("MemFree", 0))
    return max(0, total - available), total


def _uptime() -> float:
    path = Path("/proc/uptime")
    if path.exists():
        try:
            return float(path.read_text(encoding="utf-8").split()[0])
        except (IndexError, ValueError):
            pass
    return time.monotonic()


def sample_resources() -> ResourceSnapshot:
    used, total = _linux_memory()
    load = None
    getloadavg = cast(
        "Callable[[], tuple[float, float, float]] | None",
        getattr(os, "getloadavg", None),
    )
    if getloadavg is not None:
        with suppress(OSError):
            load = getloadavg()[0]
    cores = max(1, os.cpu_count() or 1)
    gpu: dict[str, str | float] = {}
    with suppress(OSError, subprocess.SubprocessError):
        result = subprocess.run(
            [
                "nvidia-smi",
                "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                "--format=csv,noheader,nounits",
            ],
            check=True,
            capture_output=True,
            text=True,
            timeout=1.5,
        )
        line = next((item for item in result.stdout.splitlines() if item.strip()), "")
        values = [item.strip() for item in line.split(",")]
        if len(values) >= 5:
            gpu["name"] = values[0]
            for key, value in zip(
                ("utilization", "memory_used", "memory_total", "temperature"),
                values[1:5],
                strict=True,
            ):
                with suppress(ValueError):
                    gpu[key] = float(value)
    return ResourceSnapshot(
        sampled_at=now_ms(),
        memory_used_bytes=used,
        memory_total_bytes=total,
        memory_percent=(used / total * 100) if total else 0.0,
        uptime_seconds=_uptime(),
        cpu_percent=min(100.0, max(0.0, load / cores * 100)) if load is not None else None,
        load_average_1m=load,
        gpu_name=str(gpu.get("name") or ""),
        gpu_utilization_percent=cast("float | None", gpu.get("utilization")),
        gpu_memory_used_mib=cast("float | None", gpu.get("memory_used")),
        gpu_memory_total_mib=cast("float | None", gpu.get("memory_total")),
        gpu_temperature_c=cast("float | None", gpu.get("temperature")),
    )
