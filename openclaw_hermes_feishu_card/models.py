from __future__ import annotations

from dataclasses import dataclass, field
from time import time
from typing import Literal

CardStatus = Literal["running", "completed", "failed", "aborted"]
ToolStatus = Literal["running", "completed", "failed"]
Currency = Literal["CNY", "USD"]


def now_ms() -> int:
    return int(time() * 1000)


@dataclass(slots=True)
class UsageSnapshot:
    provider: str = ""
    model: str = ""
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    total_tokens: int = 0
    context_used_tokens: int = 0
    context_token_budget: int = 0
    duration_ms: int = 0
    turn_cost: float | None = None
    currency: Currency | None = None


@dataclass(slots=True)
class UsageTotals:
    today_tokens: int = 0
    month_tokens: int = 0
    all_time_tokens: int = 0
    today_cost: float = 0
    month_cost: float = 0
    all_time_cost: float = 0
    currency: Currency | None = None


@dataclass(slots=True)
class ToolStep:
    id: str
    name: str
    status: ToolStatus = "running"
    started_at: int = field(default_factory=now_ms)
    finished_at: int | None = None
    duration_ms: int | None = None
    input_preview: str = ""
    output_preview: str = ""
    error: str = ""


@dataclass(slots=True)
class ResourceSnapshot:
    sampled_at: int
    memory_used_bytes: int
    memory_total_bytes: int
    memory_percent: float
    uptime_seconds: float
    cpu_percent: float | None = None
    load_average_1m: float | None = None
    gpu_name: str = ""
    gpu_utilization_percent: float | None = None
    gpu_memory_used_mib: float | None = None
    gpu_memory_total_mib: float | None = None
    gpu_temperature_c: float | None = None


@dataclass(frozen=True, slots=True)
class LegacyTaskSummary:
    id: str
    name: str
    status: Literal["running", "stalled"]
    progress: float | None = None


@dataclass(frozen=True, slots=True)
class BalanceSummary:
    platform: str
    total: float
    available: bool = True


@dataclass(frozen=True, slots=True)
class LegacyRuntimeSnapshot:
    tasks: tuple[LegacyTaskSummary, ...] = ()
    balances: tuple[BalanceSummary, ...] = ()


@dataclass(slots=True)
class CardSession:
    id: str
    route_key: str
    chat_id: str
    reply_to: str | None
    metadata: dict[str, object] | None
    session_id: str = ""
    status: CardStatus = "running"
    started_at: int = field(default_factory=now_ms)
    updated_at: int = field(default_factory=now_ms)
    completed_at: int | None = None
    first_token_at: int | None = None
    answer: str = ""
    reasoning: str = ""
    notices: list[str] = field(default_factory=list)
    attachments: list[str] = field(default_factory=list)
    tools: dict[str, ToolStep] = field(default_factory=dict)
    usage: UsageSnapshot = field(default_factory=UsageSnapshot)
    card_id: str | None = None
    message_id: str | None = None
    virtual_message_id: str | None = None
    sequence: int = 0
    ledger_written: bool = False

    def set_answer(self, content: str) -> None:
        if content and self.first_token_at is None:
            self.first_token_at = now_ms()
        self.answer = content
        self.updated_at = now_ms()

    def upsert_tool(
        self,
        *,
        tool_id: str,
        name: str,
        input_preview: str = "",
        status: ToolStatus = "running",
        output_preview: str = "",
        error: str = "",
        duration_ms: int | None = None,
    ) -> ToolStep:
        step = self.tools.get(tool_id)
        if step is None:
            step = ToolStep(id=tool_id, name=name, input_preview=input_preview)
            self.tools[tool_id] = step
        elif input_preview:
            step.input_preview = input_preview
        step.status = status
        if output_preview:
            step.output_preview = output_preview
        if error:
            step.error = error
        if duration_ms is not None:
            step.duration_ms = duration_ms
        if status != "running" and step.finished_at is None:
            step.finished_at = now_ms()
            if step.duration_ms is None:
                step.duration_ms = max(0, step.finished_at - step.started_at)
        self.updated_at = now_ms()
        return step

    def finish(self, status: CardStatus = "completed") -> None:
        stamp = now_ms()
        self.status = status
        self.completed_at = stamp
        self.updated_at = stamp
        for step in self.tools.values():
            if step.status == "running":
                step.status = "completed" if status == "completed" else "failed"
                step.finished_at = stamp
                step.duration_ms = max(0, stamp - step.started_at)

    @property
    def tool_steps(self) -> list[ToolStep]:
        return sorted(self.tools.values(), key=lambda step: step.started_at)
