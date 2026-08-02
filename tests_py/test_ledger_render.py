from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from openclaw_hermes_feishu_card.config import HermesCardConfig
from openclaw_hermes_feishu_card.ledger import UsageLedger
from openclaw_hermes_feishu_card.models import (
    BalanceSummary,
    CardSession,
    LegacyRuntimeSnapshot,
    LegacyTaskSummary,
    ResourceSnapshot,
    UsageSnapshot,
    UsageTotals,
)
from openclaw_hermes_feishu_card.render import (
    MAX_CARD_JSON_BYTES,
    MAX_CARD_TABLES,
    count_card_elements,
    render_card,
)


def test_ledger_aggregates_day_month_and_all_time(tmp_path) -> None:
    ledger = UsageLedger(tmp_path, "Asia/Shanghai")
    now = datetime(2026, 7, 30, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
    earlier = datetime(2026, 6, 1, 12, tzinfo=ZoneInfo("Asia/Shanghai"))
    assert ledger.append(
        "hermes",
        "today",
        UsageSnapshot(total_tokens=100, turn_cost=0.2, currency="USD"),
        round(now.timestamp() * 1000),
    )
    assert not ledger.append(
        "hermes",
        "today",
        UsageSnapshot(total_tokens=999, turn_cost=9.9, currency="USD"),
        round(now.timestamp() * 1000),
    )
    assert ledger.append(
        "openclaw",
        "old",
        UsageSnapshot(total_tokens=50, turn_cost=0.1, currency="USD"),
        round(earlier.timestamp() * 1000),
    )
    with (tmp_path / "usage.ndjson").open("a", encoding="utf-8") as handle:
        handle.write(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "id": "openclaw-canonical",
                    "runtime": "openclaw",
                    "timestamp": round(now.timestamp() * 1000),
                    "usage": {
                        "totalTokens": 25,
                        "turnCost": 0.05,
                        "currency": "USD",
                    },
                }
            )
            + "\n"
        )
    totals = ledger.totals(round(now.timestamp() * 1000))
    assert totals.today_tokens == 125
    assert totals.month_tokens == 125
    assert totals.all_time_tokens == 175
    assert totals.all_time_cost == pytest.approx(0.35)
    assert totals.currency == "USD"


def test_ledger_preserves_resolved_model_api_identity(tmp_path) -> None:
    ledger = UsageLedger(tmp_path, "UTC")
    assert ledger.append(
        "hermes",
        "identity",
        UsageSnapshot(
            provider="volcengine",
            model="doubao-seed",
            resolved_ref="volcengine/doubao-seed",
            api="openai-completions",
            transport="fetch",
        ),
        1_000,
    )

    record = json.loads((tmp_path / "usage.ndjson").read_text(encoding="utf-8"))
    assert record["usage"] == {
        "provider": "volcengine",
        "model": "doubao-seed",
        "resolvedRef": "volcengine/doubao-seed",
        "api": "openai-completions",
        "transport": "fetch",
        "inputTokens": 0,
        "outputTokens": 0,
        "cacheReadTokens": 0,
        "cacheWriteTokens": 0,
        "totalTokens": 0,
        "contextUsedTokens": 0,
        "contextTokenBudget": 0,
        "durationMs": 0,
        "turnCost": None,
        "currency": None,
    }


def test_render_card_has_cardkit_v2_panels(tmp_path) -> None:
    config = HermesCardConfig.from_extra(
        {
            "card_footer": {
                "storage_dir": str(tmp_path),
                "title": "Hermes Bot",
                "panels": {"resources": True, "progress": True},
                "footer": {
                    "totals": True,
                    "today_tokens": True,
                    "month_tokens": True,
                    "background_tasks": True,
                    "balance": True,
                },
            }
        }
    )
    session = CardSession(
        id="s1",
        route_key="chat",
        chat_id="chat",
        reply_to=None,
        metadata=None,
    )
    session.set_answer("hello **Feishu**")
    session.usage = UsageSnapshot(
        provider="volcengine",
        model="doubao-seed",
        resolved_ref="volcengine/doubao-seed",
        api="openai-completions",
        input_tokens=1200,
        output_tokens=300,
        total_tokens=1500,
        context_used_tokens=2000,
        context_token_budget=128000,
    )
    session.attachments = ["📎 report.pdf (application/pdf, 12 KB)"]
    session.upsert_tool(tool_id="0", name="search", input_preview='{"q":"test"}')
    card = render_card(
        session,
        UsageTotals(),
        config,
        resource=ResourceSnapshot(
            sampled_at=session.updated_at,
            memory_used_bytes=1,
            memory_total_bytes=2,
            memory_percent=50,
            uptime_seconds=60,
            gpu_name="RTX",
            gpu_utilization_percent=25,
        ),
        legacy=LegacyRuntimeSnapshot(
            tasks=(
                LegacyTaskSummary(
                    id="sync",
                    name="同步知识库",
                    status="running",
                    progress=42,
                ),
            ),
            balances=(BalanceSummary(platform="DeepSeek", total=12.34),),
        ),
        now=session.updated_at,
    )
    assert card["schema"] == "2.0"
    assert card["config"]["streaming_mode"] is True
    assert count_card_elements(card) >= 10
    assert "hello" in str(card)
    assert "header" not in card
    assert "🛠️ 工具执行 · 1 步" in str(card)
    assert "loading_icon" in str(card)
    assert "Diagnostics" in str(card)
    assert "report.pdf" in str(card)
    assert "RTX" in str(card)
    assert "同步知识库" in str(card)
    assert "DeepSeek" in str(card)


def test_completed_card_matches_legacy_visual_contract(tmp_path) -> None:
    config = HermesCardConfig.from_extra({"card_footer": {"storage_dir": str(tmp_path), "title": "Hermes"}})
    session = CardSession(
        id="complete",
        route_key="chat",
        chat_id="chat",
        reply_to="om_input",
        metadata=None,
        started_at=1_000,
    )
    session.set_answer("最终答案")
    session.usage = UsageSnapshot(
        model="deepseek-v4",
        input_tokens=1_200,
        output_tokens=300,
        context_used_tokens=2_000,
        context_token_budget=128_000,
        duration_ms=61_000,
    )
    session.upsert_tool(
        tool_id="search",
        name="搜索",
        status="completed",
        output_preview="完成",
        duration_ms=2_000,
    )
    session.finish()

    card = render_card(session, UsageTotals(), config, now=session.updated_at)
    assert "header" not in card
    elements = card["body"]["elements"]
    assert [element["tag"] for element in elements] == [
        "collapsible_panel",
        "markdown",
        "markdown",
    ]
    assert elements[0]["expanded"] is False
    assert elements[0]["border"] == {"color": "grey", "corner_radius": "5px"}
    assert elements[0]["header"]["title"]["i18n_content"]["zh_cn"] == "🛠️ 执行耗时 2.0s"
    assert elements[-1] == {
        "tag": "markdown",
        "content": "Completed · Elapsed 1m 1s · deepseek-v4\n↑ 1.2k ↓ 300 · Cache 0/0 (0%) · Context 2.0k/128k (2%)",
        "text_size": "notation",
        "i18n_content": {
            "zh_cn": "已完成 · 耗时 1m 1s · deepseek-v4\n↑ 1.2k ↓ 300 · 缓存 0/0 (0%) · 上下文 2.0k/128k (2%)",
            "en_us": "Completed · Elapsed 1m 1s · deepseek-v4\n↑ 1.2k ↓ 300 · Cache 0/0 (0%) · Context 2.0k/128k (2%)",
        },
    }


def test_completed_footer_uses_exact_provider_model_and_api(tmp_path) -> None:
    config = HermesCardConfig.from_extra({"card_footer": {"storage_dir": str(tmp_path)}})
    session = CardSession(
        id="identity",
        route_key="chat",
        chat_id="chat",
        reply_to=None,
        metadata=None,
    )
    session.set_answer("done")
    session.usage = UsageSnapshot(
        provider="volcengine",
        model="doubao-seed",
        resolved_ref="volcengine/doubao-seed",
        api="openai-completions",
    )
    session.finish()

    card = render_card(session, UsageTotals(), config, now=session.updated_at)
    assert "volcengine/doubao-seed · API openai-completions" in str(card)


def test_render_card_enforces_size_and_table_limits(tmp_path) -> None:
    config = HermesCardConfig.from_extra({"card_footer": {"storage_dir": str(tmp_path)}})
    session = CardSession(
        id="large",
        route_key="chat",
        chat_id="chat",
        reply_to=None,
        metadata=None,
    )
    table = "| A | B |\n| --- | --- |\n| 甲 | 乙 |"
    session.set_answer("\n\n".join([table] * 7) + "\n" + "大" * 30_000)
    for index in range(20):
        session.upsert_tool(
            tool_id=str(index),
            name=f"tool-{index}",
            input_preview="入" * 2_000,
            output_preview=f"{table}\n{'出' * 2_000}",
            status="completed",
        )
    card = render_card(session, UsageTotals(), config)
    payload = json.dumps(card, ensure_ascii=False, separators=(",", ":")).encode()
    assert len(payload) <= MAX_CARD_JSON_BYTES

    markdown_contents: list[str] = []

    def visit(value: object) -> None:
        if isinstance(value, list):
            for child in value:
                visit(child)
        elif isinstance(value, dict):
            if value.get("tag") == "markdown" and isinstance(value.get("content"), str):
                markdown_contents.append(value["content"])
            for child in value.values():
                visit(child)

    visit(card)
    separator_count = sum(_count_rendered_table_separators(content) for content in markdown_contents)
    assert separator_count <= MAX_CARD_TABLES


def test_render_card_ignores_fenced_table_examples_for_budget(tmp_path) -> None:
    config = HermesCardConfig.from_extra({"card_footer": {"storage_dir": str(tmp_path)}})
    session = CardSession(
        id="tables",
        route_key="chat",
        chat_id="chat",
        reply_to=None,
        metadata=None,
    )
    table = "| A | B |\n| --- | --- |\n| 1 | 2 |"
    session.set_answer(f"```markdown\n{table}\n```\n\n" + "\n\n".join([table] * 3))
    card = render_card(session, UsageTotals(), config)
    answer = next(
        element["content"]
        for element in card["body"]["elements"]
        if element.get("tag") == "markdown" and "| A" in element.get("content", "")
    )
    assert _count_rendered_table_separators(answer) == 3


def _count_rendered_table_separators(content: str) -> int:
    fenced = False
    count = 0
    for line in content.splitlines():
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif not fenced and line == "| --- | --- |":
            count += 1
    return count
