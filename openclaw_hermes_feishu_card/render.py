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
    text_nodes: list[dict[str, Any]] = []

    def visit(value: object) -> None:
        if isinstance(value, list):
            for child in value:
                visit(child)
        elif isinstance(value, dict):
            if isinstance(value.get("content"), str):
                text_nodes.append(value)
            for child in value.values():
                visit(child)

    visit(card)
    table_state = [0]
    for node in text_nodes:
        node["content"] = _limit_markdown_tables(str(node["content"]), table_state)
    encoded_size = len(json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode())
    while encoded_size > MAX_CARD_JSON_BYTES:
        candidates = [
            node
            for node in text_nodes
            if isinstance(node.get("content"), str) and len(str(node["content"]).encode()) > 48
        ]
        if not candidates:
            break
        largest = max(candidates, key=lambda node: len(str(node["content"]).encode()))
        content = str(largest["content"])
        largest["content"] = _truncate_utf8(
            content,
            max(48, len(content.encode()) - (encoded_size - MAX_CARD_JSON_BYTES) - 32),
        )
        encoded_size = len(json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode())
    return card


def _compact(value: int | float) -> str:
    count = max(0, round(value))
    if count >= 1_000_000:
        scaled = count / 1_000_000
        return f"{round(scaled)}m" if scaled >= 100 else f"{scaled:.1f}m"
    if count >= 1_000:
        scaled = count / 1_000
        return f"{round(scaled)}k" if scaled >= 100 else f"{scaled:.1f}k"
    return str(count)


def _duration(milliseconds: int | float) -> str:
    seconds = max(0.0, float(milliseconds)) / 1000
    return f"{seconds:.1f}s" if seconds < 60 else f"{int(seconds // 60)}m {int(seconds % 60)}s"


def _bytes(value: int) -> str:
    gib = value / 1024**3
    return f"{gib:.1f} GiB" if gib >= 10 else f"{gib:.2f} GiB"


def _markdown(content: str, text_size: str | None = None, **extra: object) -> dict[str, Any]:
    return {
        "tag": "markdown",
        "content": content,
        **({"text_size": text_size} if text_size else {}),
        **extra,
    }


def _panel(
    title_en: str,
    title_zh: str,
    *,
    expanded: bool,
    elements: list[dict[str, Any]],
    reasoning: bool = False,
) -> dict[str, Any]:
    title: dict[str, Any] = {
        "tag": "markdown" if reasoning else "plain_text",
        "content": title_en,
        "i18n_content": {"zh_cn": title_zh, "en_us": title_en},
    }
    if not reasoning:
        title.update({"text_color": "grey", "text_size": "notation"})
    return {
        "tag": "collapsible_panel",
        "expanded": expanded,
        "header": {
            "title": title,
            "vertical_align": "center",
            "icon": {
                "tag": "standard_icon",
                "token": "down-small-ccm_outlined",
                **({} if reasoning else {"color": "grey"}),
                "size": "16px 16px",
            },
            "icon_position": "follow_text" if reasoning else "right",
            "icon_expanded_angle": -180,
        },
        "border": {"color": "grey", "corner_radius": "5px"},
        "vertical_spacing": "8px" if reasoning else "4px",
        "padding": "8px 8px 8px 8px",
        "elements": elements,
    }


def _tool_state(step: ToolStep) -> tuple[str, str]:
    if step.status == "completed":
        return "Succeeded", "green"
    if step.status == "failed":
        return "Failed", "red"
    return "Running", "turquoise"


def _tool_elements(step: ToolStep) -> list[dict[str, Any]]:
    label, color = _tool_state(step)
    elements: list[dict[str, Any]] = [
        {
            "tag": "div",
            "icon": {"tag": "standard_icon", "token": "tool_02", "color": "grey"},
            "text": {
                "tag": "lark_md",
                "content": f"**{step.name}** · <font color='{color}'>{label}</font>",
                "text_size": "notation",
            },
        }
    ]
    if step.input_preview:
        elements.append(
            {
                "tag": "div",
                "margin": "0px 0px 0px 22px",
                "text": {
                    "tag": "plain_text",
                    "content": step.input_preview,
                    "text_color": "grey",
                    "text_size": "notation",
                },
            }
        )
    output = step.error or step.output_preview
    if output:
        elements.append(
            {
                "tag": "div",
                "margin": "0px 0px 0px 22px",
                "text": {
                    "tag": "lark_md",
                    "content": f"{'**Error**' if step.error else '**Result**'}\n{output}",
                    "text_size": "notation",
                },
            }
        )
    return elements


def _tools_panel(session: CardSession, now: int) -> dict[str, Any]:
    tools = session.tool_steps[-MAX_TOOL_STEPS:]
    running = session.status == "running"
    elapsed = _duration(now - session.started_at)
    if running and not tools:
        title_en, title_zh = "🛠️ Tool use pending", "🛠️ 等待工具执行"
    elif running:
        suffix = "" if len(tools) == 1 else "s"
        title_en = f"🛠️ Tool use · {len(tools)} step{suffix} · ({elapsed})"
        title_zh = f"🛠️ 工具执行 · {len(tools)} 步 · ({elapsed})"
    else:
        tool_ms = sum(step.duration_ms or 0 for step in tools)
        title_en = f"🛠️ Tool use for {_duration(tool_ms)}" if tool_ms else "🛠️ Tool use"
        title_zh = f"🛠️ 执行耗时 {_duration(tool_ms)}" if tool_ms else "🛠️ 工具执行"
    elements = [element for step in tools for element in _tool_elements(step)]
    if not running and not elements:
        elements.append(
            {
                "tag": "div",
                "icon": {"tag": "standard_icon", "token": "tool_02", "color": "grey"},
                "text": {
                    "tag": "plain_text",
                    "content": "No tools were used",
                    "i18n_content": {"zh_cn": "未调用工具", "en_us": "No tools were used"},
                    "text_color": "grey",
                    "text_size": "notation",
                },
            }
        )
    return _panel(
        title_en,
        title_zh,
        expanded=running and bool(tools),
        elements=elements,
    )


def _reasoning_panel(reasoning: str) -> dict[str, Any]:
    return _panel(
        "💭 Thought",
        "💭 思考",
        expanded=False,
        reasoning=True,
        elements=[_markdown(reasoning[-6_000:], "notation")],
    )


def _footer(session: CardSession, config: HermesCardConfig, now: int) -> dict[str, Any] | None:
    if session.status == "running":
        return None
    footer = config.footer
    usage = session.usage
    primary_en: list[str] = []
    primary_zh: list[str] = []
    if footer.status:
        status = (
            ("Completed", "已完成")
            if session.status == "completed"
            else ("Error", "出错")
            if session.status == "failed"
            else ("Stopped", "已停止")
        )
        primary_en.append(status[0])
        primary_zh.append(status[1])
    if footer.elapsed:
        elapsed = _duration(usage.duration_ms or (session.completed_at or now) - session.started_at)
        primary_en.append(f"Elapsed {elapsed}")
        primary_zh.append(f"耗时 {elapsed}")
    if footer.model and usage.model:
        primary_en.append(usage.model)
        primary_zh.append(usage.model)

    detail_en: list[str] = []
    detail_zh: list[str] = []
    if footer.tokens:
        tokens = f"↑ {_compact(usage.input_tokens)} ↓ {_compact(usage.output_tokens)}"
        detail_en.append(tokens)
        detail_zh.append(tokens)
    if footer.cache:
        total = usage.cache_read_tokens + usage.cache_write_tokens + usage.input_tokens
        hit = round(usage.cache_read_tokens / total * 100) if total else 0
        detail_en.append(f"Cache {_compact(usage.cache_read_tokens)}/{_compact(usage.cache_write_tokens)} ({hit}%)")
        detail_zh.append(f"缓存 {_compact(usage.cache_read_tokens)}/{_compact(usage.cache_write_tokens)} ({hit}%)")
    if footer.context and usage.context_token_budget:
        percent = round(usage.context_used_tokens / usage.context_token_budget * 100)
        value = f"{_compact(usage.context_used_tokens)}/{_compact(usage.context_token_budget)} ({percent}%)"
        detail_en.append(f"Context {value}")
        detail_zh.append(f"上下文 {value}")

    en = "\n".join(filter(None, (" · ".join(primary_en), " · ".join(detail_en))))
    zh = "\n".join(filter(None, (" · ".join(primary_zh), " · ".join(detail_zh))))
    if not en:
        return None
    if session.status == "failed":
        en = f"<font color='red'>{en}</font>"
        zh = f"<font color='red'>{zh}</font>"
    return _markdown(en, "notation", i18n_content={"zh_cn": zh, "en_us": en})


def _money(value: float, currency: str | None) -> str:
    return (
        f"{'$' if currency == 'USD' else '¥'}{value:.4f}"
        if value < 1
        else f"{'$' if currency == 'USD' else '¥'}{value:.2f}"
    )


def _diagnostics(
    totals: UsageTotals,
    config: HermesCardConfig,
    legacy: LegacyRuntimeSnapshot | None,
    resource: ResourceSnapshot | None,
) -> dict[str, Any] | None:
    lines: list[str] = []
    footer = config.footer
    if footer.totals and totals.all_time_tokens:
        token_parts = [
            *([f"今 {_compact(totals.today_tokens)}"] if footer.today_tokens else []),
            *([f"月 {_compact(totals.month_tokens)}"] if footer.month_tokens else []),
            f"总 {_compact(totals.all_time_tokens)}",
        ]
        lines.append("**插件本地累计**  " + " · ".join(token_parts))
        if totals.all_time_cost:
            lines.append(f"**插件本地费用**  {_money(totals.all_time_cost, totals.currency)}")
    if config.panels.resources and resource is not None:
        cpu = "-" if resource.cpu_percent is None else f"{resource.cpu_percent:.0f}"
        memory = f"{_bytes(resource.memory_used_bytes)}/{_bytes(resource.memory_total_bytes)}"
        lines.append(f"**主机资源**  CPU {cpu}% · 内存 {memory} ({resource.memory_percent:.0f}%)")
        if resource.gpu_name:
            lines.append(f"GPU {resource.gpu_name}")
    if footer.background_tasks and legacy is not None:
        running = [task for task in legacy.tasks if task.status == "running"]
        if running:
            lines.append("**后台任务**  " + "、".join(task.name for task in running[:3]))
    if footer.balance and legacy is not None and legacy.balances:
        lines.append(
            "**余额缓存**  " + " · ".join(f"{balance.platform} ¥{balance.total:.2f}" for balance in legacy.balances[:3])
        )
    if not lines:
        return None
    return _panel(
        "🔎 Diagnostics",
        "🔎 诊断信息",
        expanded=False,
        elements=[_markdown("\n".join(lines), "notation")],
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
    running = session.status == "running"
    elements: list[dict[str, Any]] = []
    if config.panels.progress and running:
        current = next((step for step in reversed(session.tool_steps) if step.status == "running"), None)
        elements.append(
            _markdown(
                f"⏳ {'执行 ' + current.name if current else '处理中'} · {_duration(stamp - session.started_at)}",
                "notation",
            )
        )
    if config.panels.tools:
        elements.append(_tools_panel(session, stamp))

    reasoning = session.reasoning.strip()
    answer = session.answer.strip()
    if config.panels.reasoning and reasoning and reasoning != answer:
        if running and not answer:
            elements.append(_markdown(f"💭 **思考中...**\n\n{reasoning[-6_000:]}", "notation"))
        else:
            elements.append(_reasoning_panel(reasoning))
    if session.notices and not answer:
        elements.append(_markdown(session.notices[-1], "notation"))
    if session.attachments:
        elements.append(_markdown("附件: " + "、".join(session.attachments[:8]), "notation"))

    fallback = (
        "本次任务执行异常。"
        if session.status == "failed"
        else "任务已停止。"
        if session.status == "aborted"
        else "任务已完成, 本次没有生成可显示的文本。"
        if session.status == "completed"
        else ""
    )
    visible_answer = answer or fallback
    if visible_answer or running:
        if len(visible_answer) > MAX_ANSWER_CHARS:
            visible_answer = visible_answer[: MAX_ANSWER_CHARS - 20] + "\n\n…内容已截断"
        elements.append(
            _markdown(
                visible_answer,
                "normal_v2" if running else None,
                **(
                    {
                        "element_id": "streaming_content",
                        "text_align": "left",
                        "margin": "0px 0px 0px 0px",
                    }
                    if running
                    else {}
                ),
            )
        )

    diagnostics = _diagnostics(totals, config, legacy, resource)
    if diagnostics is not None:
        elements.append(diagnostics)
    if running:
        elements.append(
            _markdown(
                " ",
                None,
                icon={
                    "tag": "custom_icon",
                    "img_key": "img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg",
                    "size": "16px 16px",
                },
                element_id="loading_icon",
            )
        )
    elif config.panels.footer:
        footer = _footer(session, config, stamp)
        if footer is not None:
            elements.append(footer)

    summary = re.sub(r"[*_`#>\[\]()~]", "", answer or reasoning).strip()[:120] or "Hermes 正在处理"
    card: dict[str, Any] = {
        "schema": "2.0",
        "config": {
            **(
                {
                    "streaming_mode": True,
                    "streaming_config": {
                        "print_frequency_ms": {"default": 15},
                        "print_step": {"default": 1},
                        "print_strategy": "fast",
                    },
                }
                if running
                else {"wide_screen_mode": True, "update_multi": True}
            ),
            "locales": ["zh_cn", "en_us"],
            "summary": {
                "content": summary,
                "i18n_content": {"zh_cn": summary, "en_us": summary},
            },
        },
        "body": {"elements": elements},
    }
    return _fit_card_byte_budget(card)


def count_card_elements(value: object) -> int:
    if isinstance(value, list):
        return sum(count_card_elements(child) for child in value)
    if not isinstance(value, dict):
        return 0
    own = 1 if isinstance(value.get("tag"), str) else 0
    return own + sum(count_card_elements(child) for child in value.values())
