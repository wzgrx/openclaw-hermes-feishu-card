from __future__ import annotations

import json
import re
from typing import Any

from .config import HermesCardConfig
from .models import CardSession, ResourceSnapshot, ToolStep, UsageTotals

MAX_ANSWER_CHARS = 18_000
MAX_TOOL_STEPS = 20
MAX_CARD_JSON_BYTES = 28 * 1024
MAX_CARD_TABLES = 5
_TABLE_SEPARATOR = re.compile(
    r"^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)$",
    re.MULTILINE,
)


def _limit_markdown_tables(content: str, state: list[int]) -> str:
    def replace(match: re.Match[str]) -> str:
        state[0] += 1
        line = match.group(0)
        return line if state[0] <= MAX_CARD_TABLES else f"\\{line}"

    return _TABLE_SEPARATOR.sub(replace, content)


def _truncate_utf8(content: str, byte_limit: int) -> str:
    if len(content.encode()) <= byte_limit:
        return content
    suffix = "\n\n…内容已截断"
    target = max(0, byte_limit - len(suffix.encode()))
    low, high = 0, len(content)
    while low < high:
        middle = (low + high + 1) // 2
        if len(content[:middle].encode()) <= target:
            low = middle
        else:
            high = middle - 1
    return content[:low] + suffix


def _fit_card_byte_budget(card: dict[str, Any]) -> dict[str, Any]:
    markdown_nodes: list[dict[str, Any]] = []

    def visit(value: object) -> None:
        if isinstance(value, list):
            for child in value:
                visit(child)
        elif isinstance(value, dict):
            if value.get("tag") == "markdown" and isinstance(value.get("content"), str):
                markdown_nodes.append(value)
            for child in value.values():
                visit(child)

    visit(card)
    table_state = [0]
    for node in markdown_nodes:
        content = node.get("content")
        if isinstance(content, str):
            node["content"] = _limit_markdown_tables(content, table_state)
    encoded_size = len(json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode())
    while encoded_size > MAX_CARD_JSON_BYTES:
        candidates = [
            node
            for node in markdown_nodes
            if isinstance(node.get("content"), str) and len(str(node["content"]).encode()) > 48
        ]
        if not candidates:
            break
        largest = max(candidates, key=lambda node: len(str(node["content"]).encode()))
        content = str(largest["content"])
        current_size = len(content.encode())
        excess = encoded_size - MAX_CARD_JSON_BYTES
        largest["content"] = _truncate_utf8(
            content,
            max(48, current_size - excess - 32),
        )
        encoded_size = len(json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode())
    return card


def _compact(value: int | float) -> str:
    absolute = abs(value)
    for boundary, suffix in ((1_000_000_000, "b"), (1_000_000, "m"), (1_000, "k")):
        if absolute >= boundary:
            return f"{value / boundary:.1f}".rstrip("0").rstrip(".") + suffix
    return str(round(value))


def _duration(milliseconds: int | float) -> str:
    seconds = max(0.0, float(milliseconds)) / 1000
    if seconds < 60:
        return f"{seconds:.1f}s"
    return f"{int(seconds // 60)}m {round(seconds % 60)}s"


def _bytes(value: int) -> str:
    gib = value / 1024**3
    return f"{gib:.1f} GiB" if gib >= 10 else f"{gib:.2f} GiB"


def _markdown(content: str, text_size: str = "normal_v2") -> dict[str, Any]:
    return {
        "tag": "markdown",
        "content": content,
        "text_size": text_size,
    }


def _panel(
    title_zh: str,
    title_en: str,
    emoji: str,
    *,
    expanded: bool,
    elements: list[dict[str, Any]],
) -> dict[str, Any]:
    return {
        "tag": "collapsible_panel",
        "expanded": expanded,
        "header": {
            "title": {
                "tag": "plain_text",
                "content": f"{emoji} {title_en}",
                "i18n_content": {
                    "zh_cn": f"{emoji} {title_zh}",
                    "en_us": f"{emoji} {title_en}",
                },
                "text_color": "grey",
                "text_size": "notation",
            },
            "vertical_align": "center",
            "icon": {
                "tag": "standard_icon",
                "token": "down-small-ccm_outlined",
                "color": "grey",
                "size": "16px 16px",
            },
            "icon_position": "right",
            "icon_expanded_angle": -180,
        },
        "border": {"color": "grey", "corner_radius": "5px"},
        "vertical_spacing": "4px",
        "padding": "8px 8px 8px 8px",
        "elements": elements,
    }


def _tool_icon(step: ToolStep) -> str:
    return {"running": "⏳", "completed": "✅", "failed": "❌"}[step.status]


def _tools_panel(session: CardSession) -> dict[str, Any] | None:
    tools = session.tool_steps
    if not tools:
        return None
    elements: list[dict[str, Any]] = []
    for step in tools[-MAX_TOOL_STEPS:]:
        elapsed = f" · {_duration(step.duration_ms)}" if step.duration_ms is not None else ""
        elements.append(_markdown(f"{_tool_icon(step)} **{step.name}**{elapsed}", "notation"))
        details: list[str] = []
        if step.input_preview:
            details.append(f"**Input**\n```json\n{step.input_preview}\n```")
        if step.error:
            details.append(step.error)
        elif step.output_preview:
            details.append(step.output_preview)
        if details:
            elements.append(_markdown("\n\n".join(details), "notation"))
    return _panel(
        f"工具步骤 · {len(tools)}",
        f"Tool steps · {len(tools)}",
        "🛠️",
        expanded=False,
        elements=elements,
    )


def _progress_panel(session: CardSession) -> dict[str, Any]:
    total = len(session.tools)
    settled = sum(step.status != "running" for step in session.tools.values())
    percent = 100 if session.status == "completed" else round(settled / total * 100) if total else 5
    percent = min(100, max(0, percent))
    blocks = round(percent / 5)
    bar = "█" * blocks + "░" * (20 - blocks)
    running = [step.name for step in session.tools.values() if step.status == "running"]
    detail = f"\n\n⏳ {' · '.join(running)}" if running else ""
    return _panel(
        f"任务进度 · {percent}%",
        f"Task progress · {percent}%",
        "📊",
        expanded=session.status == "running",
        elements=[_markdown(f"`{bar}` **{percent}%**{detail}", "notation")],
    )


def _resource_panel(resource: ResourceSnapshot) -> dict[str, Any]:
    load = "-" if resource.load_average_1m is None else f"{resource.load_average_1m:.2f}"
    cpu = "-" if resource.cpu_percent is None else f"{resource.cpu_percent:.0f}"
    lines = [
        f"CPU {cpu}% · Load {load}",
        (
            f"Memory {_bytes(resource.memory_used_bytes)}/{_bytes(resource.memory_total_bytes)} "
            f"({resource.memory_percent:.0f}%)"
        ),
        f"Uptime {_duration(resource.uptime_seconds * 1000)}",
    ]
    return _panel(
        "系统资源",
        "System resources",
        "🖥️",
        expanded=False,
        elements=[_markdown("\n".join(lines), "notation")],
    )


def _status(status: str) -> str:
    return {
        "running": "⏳ 运行中",
        "completed": "✅ 已完成",
        "failed": "❌ 出错",
        "aborted": "⏹️ 已停止",
    }.get(status, status)


def _money(value: float, currency: str | None) -> str:
    symbol = "$" if currency == "USD" else "¥"
    return f"{symbol}{value:.4f}" if value < 0.01 else f"{symbol}{value:.2f}"


def _footer(
    session: CardSession,
    totals: UsageTotals,
    config: HermesCardConfig,
    now: int,
) -> dict[str, Any] | None:
    items: list[str] = []
    usage = session.usage
    footer = config.footer
    if footer.status:
        items.append(_status(session.status))
    if footer.elapsed:
        items.append(f"耗时 {_duration((session.completed_at or now) - session.started_at)}")
    if footer.first_token and session.first_token_at:
        items.append(f"首 Token {_duration(session.first_token_at - session.started_at)}")
    if footer.model and (usage.provider or usage.model):
        items.append("/".join(part for part in (usage.provider, usage.model) if part))
    if footer.tokens and usage.total_tokens:
        items.append(f"↑ {_compact(usage.input_tokens)} ↓ {_compact(usage.output_tokens)}")
    if footer.cache and (usage.cache_read_tokens or usage.cache_write_tokens):
        items.append(f"缓存 {_compact(usage.cache_read_tokens)}/{_compact(usage.cache_write_tokens)}")
    if footer.context and usage.context_token_budget:
        used = usage.context_used_tokens or usage.input_tokens
        percent = min(999, round(used / usage.context_token_budget * 100))
        items.append(f"上下文 {_compact(used)}/{_compact(usage.context_token_budget)} ({percent}%)")
    if footer.cost and usage.turn_cost is not None:
        items.append(f"本次 {_money(usage.turn_cost, usage.currency)}")
    if footer.totals:
        items.append(
            "Token 今/月/总 "
            f"{_compact(totals.today_tokens)}/{_compact(totals.month_tokens)}/{_compact(totals.all_time_tokens)}"
        )
        if totals.all_time_cost and totals.currency:
            items.append(
                "费用 今/月/总 "
                f"{_money(totals.today_cost, totals.currency)}/"
                f"{_money(totals.month_cost, totals.currency)}/"
                f"{_money(totals.all_time_cost, totals.currency)}"
            )
    if not items:
        return None
    return _panel(
        "运行统计",
        "Runtime metrics",
        "🪙",
        expanded=False,
        elements=[_markdown(" · ".join(items), "notation")],
    )


def render_card(
    session: CardSession,
    totals: UsageTotals,
    config: HermesCardConfig,
    *,
    resource: ResourceSnapshot | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    stamp = now or session.updated_at
    elements: list[dict[str, Any]] = []
    if config.panels.resources and resource is not None:
        elements.append(_resource_panel(resource))
    tools = _tools_panel(session) if config.panels.tools else None
    if tools is not None:
        elements.append(tools)
    if config.panels.progress:
        elements.append(_progress_panel(session))
    if config.panels.reasoning and session.reasoning:
        elements.append(
            _panel(
                "思考过程",
                "Reasoning",
                "💭",
                expanded=False,
                elements=[_markdown(session.reasoning[-6_000:], "notation")],
            )
        )
    if session.notices and not session.answer:
        elements.append(_markdown(session.notices[-1], "notation"))
    answer = session.answer or (
        "正在处理…"
        if session.status == "running"
        else "任务执行出错。"
        if session.status == "failed"
        else "任务已结束。"
    )
    if len(answer) > MAX_ANSWER_CHARS:
        answer = answer[: MAX_ANSWER_CHARS - 20] + "\n\n…内容已截断"
    elements.append(_markdown(answer))
    if config.panels.footer:
        footer = _footer(session, totals, config, stamp)
        if footer is not None:
            elements.append(footer)
    summary = re.sub(r"[*_`#>\[\]()~]", "", answer).strip()[:120] or "Hermes 正在处理"
    return _fit_card_byte_budget(
        {
            "schema": "2.0",
            "config": {
                "wide_screen_mode": True,
                "update_multi": True,
                "streaming_mode": session.status == "running",
                "locales": ["zh_cn", "en_us"],
                "summary": {
                    "content": summary,
                    "i18n_content": {"zh_cn": summary, "en_us": summary},
                },
            },
            "header": {
                "template": "blue"
                if session.status == "running"
                else "green"
                if session.status == "completed"
                else "red",
                "title": {
                    "tag": "plain_text",
                    "content": "Hermes",
                    "i18n_content": {"zh_cn": "Hermes", "en_us": "Hermes"},
                },
                "subtitle": {"tag": "plain_text", "content": _status(session.status)},
            },
            "body": {"elements": elements},
        }
    )


def count_card_elements(value: object) -> int:
    if isinstance(value, list):
        return sum(count_card_elements(child) for child in value)
    if not isinstance(value, dict):
        return 0
    own = 1 if isinstance(value.get("tag"), str) else 0
    return own + sum(count_card_elements(child) for child in value.values())
