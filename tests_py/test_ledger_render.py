from __future__ import annotations

import json
from datetime import datetime
from zoneinfo import ZoneInfo

import pytest

from hermes_feishu_card_footer.config import HermesCardConfig
from hermes_feishu_card_footer.ledger import UsageLedger
from hermes_feishu_card_footer.models import CardSession, UsageSnapshot, UsageTotals
from hermes_feishu_card_footer.render import (
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


def test_render_card_has_cardkit_v2_panels(tmp_path) -> None:
    config = HermesCardConfig.from_extra({"card_footer": {"storage_dir": str(tmp_path)}})
    session = CardSession(
        id="s1",
        route_key="chat",
        chat_id="chat",
        reply_to=None,
        metadata=None,
    )
    session.set_answer("hello **Feishu**")
    session.upsert_tool(tool_id="0", name="search", input_preview='{"q":"test"}')
    card = render_card(session, UsageTotals(), config, now=session.updated_at)
    assert card["schema"] == "2.0"
    assert card["config"]["streaming_mode"] is True
    assert count_card_elements(card) >= 10
    assert "hello" in str(card)


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
    separator_count = sum(line == "| --- | --- |" for content in markdown_contents for line in content.splitlines())
    assert separator_count <= MAX_CARD_TABLES
