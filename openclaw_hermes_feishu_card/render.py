from __future__ import annotations

import json
import re
from typing import Any

from .config import HermesCardConfig
from .models import CardSession, LegacyRuntimeSnapshot, ResourceSnapshot, ToolStep, UsageTotals

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


def _exact(value: int | float) -> str:
    return f"{round(value):,}"


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
    completed = sum(step.status == "completed" for step in tools)
    failed = sum(step.status == "failed" for step in tools)
    running = sum(step.status == "running" for step in tools)
    summary = " · ".join(
        [
            f"{completed} 已完成",
            *([f"{running} 执行中"] if running else []),
            *([f"{failed} 失败"] if failed else []),
        ]
    )
    return _panel(
        f"执行记录 · {summary}",
        f"Execution log · {len(tools)} steps",
        "🛠️",
        expanded=running > 0 or failed > 0,
        elements=elements,
    )


def _progress_panel(session: CardSession) -> dict[str, Any]:
    total = len(session.tools)
    settled = sum(step.status != "running" for step in session.tools.values())
    percent = round(settled / total * 100) if total else 0
    percent = min(100, max(0, percent))
    blocks = round(percent / 5)
    bar = "█" * blocks + "░" * (20 - blocks)
    running = [step.name for step in session.tools.values() if step.status == "running"]
    detail = f"\n\n⏳ {' · '.join(running)}" if running else ""
    return _panel(
        f"任务进度 · {percent}%",
        f"Task progress · {percent}%",
        "📊",
        expanded=True,
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
    if resource.gpu_name:
        utilization = "-" if resource.gpu_utilization_percent is None else f"{resource.gpu_utilization_percent:.0f}"
        memory_used = "-" if resource.gpu_memory_used_mib is None else f"{resource.gpu_memory_used_mib:.0f}"
        memory_total = "-" if resource.gpu_memory_total_mib is None else f"{resource.gpu_memory_total_mib:.0f}"
        temperature = "-" if resource.gpu_temperature_c is None else f"{resource.gpu_temperature_c:.0f}"
        lines.append(f"GPU {resource.gpu_name} · {utilization}% · {memory_used}/{memory_total} MiB · {temperature}°C")
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


_PROVIDER_LABELS = {
    "anthropic": "Anthropic",
    "azure": "Azure OpenAI",
    "dashscope": "阿里云百炼",
    "deepseek": "DeepSeek",
    "google": "Google",
    "groq": "Groq",
    "moonshot": "Moonshot",
    "openai": "OpenAI",
    "openrouter": "OpenRouter",
    "qwen": "阿里云百炼",
    "siliconflow": "硅基流动",
    "together": "Together AI",
    "volcengine": "火山引擎",
    "zhipu": "智谱 AI",
}


def _provider_label(provider: str) -> str:
    provider_id = provider.strip()
    if not provider_id:
        return ""
    brand = _PROVIDER_LABELS.get(provider_id.lower())
    if not brand:
        return provider_id
    return brand if brand.lower() == provider_id.lower() else f"{brand} ({provider_id})"


def _footer(session: CardSession, config: HermesCardConfig, now: int) -> dict[str, Any] | None:
    usage = session.usage
    footer = config.footer
    primary: list[str] = []
    model: list[str] = []
    detail: list[str] = []
    if footer.status:
        primary.append(_status(session.status).split(" ", 1)[-1])
    if footer.elapsed:
        elapsed = (
            usage.duration_ms
            if session.status != "running" and usage.duration_ms
            else (session.completed_at or now) - session.started_at
        )
        primary.append(f"耗时 {_duration(elapsed)}")
    if footer.first_token and session.first_token_at:
        primary.append(f"首 Token {_duration(session.first_token_at - session.started_at)}")
    if footer.model and (usage.provider or usage.model):
        model.append("模型 " + " · ".join(part for part in (_provider_label(usage.provider), usage.model) if part))
    if footer.tokens and (usage.input_tokens or usage.output_tokens or usage.total_tokens):
        detail.append(f"本轮 ↑ {_exact(usage.input_tokens)} ↓ {_exact(usage.output_tokens)}")
    if footer.cache and (usage.cache_read_tokens or usage.cache_write_tokens):
        detail.append(f"缓存 读 {_exact(usage.cache_read_tokens)} / 写 {_exact(usage.cache_write_tokens)}")
    if footer.context and usage.context_token_budget:
        used = usage.context_used_tokens or usage.input_tokens
        percent = min(999, used / usage.context_token_budget * 100)
        detail.append(f"上下文 {_exact(used)} / {_exact(usage.context_token_budget)} ({percent:.1f}%)")
    if footer.cost and usage.turn_cost is not None and usage.turn_cost > 0:
        detail.append(f"费用 {_money(usage.turn_cost, usage.currency)}")
    lines = [" · ".join(parts) for parts in (primary, model, detail) if parts]
    return _markdown("\n".join(lines), "notation") if lines else None


def _diagnostics(
    totals: UsageTotals,
    config: HermesCardConfig,
    legacy: LegacyRuntimeSnapshot | None,
    resource: ResourceSnapshot | None,
) -> dict[str, Any] | None:
    sections: list[str] = []
    footer = config.footer
    if footer.totals and totals.all_time_tokens:
        token_totals = [
            *([f"今 {_compact(totals.today_tokens)}"] if footer.today_tokens else []),
            *([f"月 {_compact(totals.month_tokens)}"] if footer.month_tokens else []),
            f"总 {_compact(totals.all_time_tokens)}",
        ]
        lines = [
            "**插件本地累计**  " + " · ".join(token_totals),
            "<font color='grey'>仅统计由本插件成功捕获并记录的回复, 不代表供应商账户总量。</font>",
        ]
        if totals.all_time_cost and totals.currency:
            cost_totals = [
                *([f"今 {_money(totals.today_cost, totals.currency)}"] if footer.today_tokens else []),
                *([f"月 {_money(totals.month_cost, totals.currency)}"] if footer.month_tokens else []),
                f"总 {_money(totals.all_time_cost, totals.currency)}",
            ]
            lines.append("**插件本地费用**  " + " · ".join(cost_totals))
        sections.append("\n".join(lines))
    if config.panels.resources and resource is not None:
        load = "-" if resource.load_average_1m is None else f"{resource.load_average_1m:.2f}"
        cpu = "-" if resource.cpu_percent is None else f"{resource.cpu_percent:.0f}"
        memory = f"{_bytes(resource.memory_used_bytes)} / {_bytes(resource.memory_total_bytes)}"
        uptime = _duration(resource.uptime_seconds * 1000)
        resource_lines = [
            f"**主机资源**  CPU {cpu}% · Load {load} · 内存 {memory} ({resource.memory_percent:.0f}%) · Uptime {uptime}"
        ]
        if resource.gpu_name:
            resource_lines.append(f"GPU {resource.gpu_name}")
        sections.append("\n".join(resource_lines))
    runtime_lines: list[str] = []
    if footer.background_tasks and legacy is not None:
        running = [task for task in legacy.tasks if task.status == "running"]
        stalled = [task for task in legacy.tasks if task.status == "stalled"]
        if running:
            names = "、".join(
                task.name if task.progress is None else f"{task.name} {round(task.progress)}%" for task in running[:3]
            )
            runtime_lines.append(f"后台任务 {len(running)} 个进行中: {names}")
        if stalled:
            runtime_lines.append(f"⚠️ {len(stalled)} 个任务停滞: " + "、".join(task.name for task in stalled[:3]))
    if footer.balance and legacy is not None and legacy.balances:
        runtime_lines.append(
            "余额缓存 "
            + " · ".join(
                f"{'' if balance.available else '⚠️'}{balance.platform} ¥{balance.total:.2f}"
                for balance in legacy.balances[:3]
            )
        )
    if runtime_lines:
        sections.append("\n".join(runtime_lines))
    if not sections:
        return None
    return _panel(
        "诊断信息",
        "Diagnostics",
        "🔎",
        expanded=False,
        elements=[_markdown(section, "notation") for section in sections],
    )


def render_card(
    session: CardSession,
    totals: UsageTotals,
    config: HermesCardConfig,
    *,
    resource: ResourceSnapshot | None = None,
    legacy: LegacyRuntimeSnapshot | None = None,
    now: int | None = None,
) -> dict[str, Any]:
    stamp = now or session.updated_at
    elements: list[dict[str, Any]] = []
    if config.panels.progress and session.status == "running":
        elements.append(_progress_panel(session))
    if session.notices and not session.answer:
        elements.append(_markdown(session.notices[-1], "notation"))
    if session.attachments:
        elements.append(_markdown("附件: " + "、".join(session.attachments[:8]), "notation"))
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
    tools = _tools_panel(session) if config.panels.tools else None
    if tools is not None:
        elements.append(tools)
    if config.panels.reasoning and session.status != "running" and session.reasoning.strip() != session.answer.strip():
        elements.append(
            _panel(
                "分析摘要",
                "Analysis summary",
                "🧭",
                expanded=False,
                elements=[_markdown(session.reasoning[-6_000:], "notation")],
            )
        )
    if config.panels.footer:
        footer = _footer(session, config, stamp)
        if footer is not None:
            elements.append(footer)
    diagnostics = _diagnostics(totals, config, legacy, resource)
    if diagnostics is not None:
        elements.append(diagnostics)
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
                    "content": config.title,
                    "i18n_content": {"zh_cn": config.title, "en_us": config.title},
                },
                **(
                    {
                        "subtitle": {
                            "tag": "plain_text",
                            "content": "正在生成回复" if session.answer else "正在分析任务",
                        }
                    }
                    if session.status == "running"
                    else {}
                ),
                "text_tag_list": [
                    {
                        "tag": "text_tag",
                        "text": {"tag": "plain_text", "content": _status(session.status).split(" ", 1)[-1]},
                        "color": "blue"
                        if session.status == "running"
                        else "green"
                        if session.status == "completed"
                        else "red",
                    }
                ],
            },
            "body": {
                "direction": "vertical",
                "vertical_spacing": "12px",
                "padding": "14px 16px 16px 16px",
                "elements": elements,
            },
        }
    )


def count_card_elements(value: object) -> int:
    if isinstance(value, list):
        return sum(count_card_elements(child) for child in value)
    if not isinstance(value, dict):
        return 0
    own = 1 if isinstance(value.get("tag"), str) else 0
    return own + sum(count_card_elements(child) for child in value.values())
