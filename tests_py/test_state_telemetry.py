from __future__ import annotations

from hermes_feishu_card_footer.models import CardSession
from hermes_feishu_card_footer.telemetry import TelemetryRegistry


def test_card_session_finishes_running_tools() -> None:
    session = CardSession(
        id="s",
        route_key="route",
        chat_id="chat",
        reply_to=None,
        metadata=None,
    )
    session.upsert_tool(tool_id="1", name="browser")
    session.finish()
    assert session.status == "completed"
    assert session.tool_steps[0].status == "completed"
    assert session.tool_steps[0].duration_ms is not None


def test_telemetry_accumulates_canonical_usage() -> None:
    registry = TelemetryRegistry()
    registry.post_api_request(
        platform="feishu",
        session_id="session",
        provider="openrouter",
        model="qwen",
        api_duration=0.5,
        usage={
            "input_tokens": 10,
            "output_tokens": 5,
            "cache_read_tokens": 2,
            "cache_write_tokens": 1,
        },
    )
    registry.post_api_request(
        platform="feishu",
        session_id="session",
        provider="openrouter",
        model="qwen",
        api_duration=0.25,
        usage={"input_tokens": 3, "output_tokens": 2},
    )
    session_id, usage, _, terminal_status, error_message = registry.snapshot("session")
    assert session_id == "session"
    assert usage.input_tokens == 13
    assert usage.output_tokens == 7
    assert usage.total_tokens == 23
    assert usage.duration_ms == 750
    assert terminal_status == "completed"
    assert error_message == ""


def test_telemetry_resets_per_turn_and_tracks_tool_completion() -> None:
    registry = TelemetryRegistry()
    registry.pre_api_request(platform="feishu", session_id="session", turn_id="turn-1")
    registry.post_api_request(
        platform="feishu",
        session_id="session",
        turn_id="turn-1",
        finish_reason="tool_calls",
        assistant_tool_call_count=1,
        usage={"input_tokens": 10},
    )
    registry.pre_tool_call(
        session_id="session",
        turn_id="turn-1",
        tool_call_id="tool-1",
        tool_name="browser",
        args={"url": "https://example.test"},
    )
    registry.post_tool_call(
        session_id="session",
        turn_id="turn-1",
        tool_call_id="tool-1",
        tool_name="browser",
        status="ok",
        result={"ok": True},
    )
    _, first_usage, tools, first_status, _ = registry.snapshot("session")
    assert first_usage.input_tokens == 10
    assert tools["tool-1"]["status"] == "completed"
    assert first_status is None

    registry.pre_api_request(platform="feishu", session_id="session", turn_id="turn-2")
    registry.post_api_request(
        platform="feishu",
        session_id="session",
        turn_id="turn-2",
        finish_reason="stop",
        assistant_tool_call_count=0,
        usage={"input_tokens": 4, "output_tokens": 2},
    )
    _, second_usage, second_tools, second_status, _ = registry.snapshot("session")
    assert second_usage.total_tokens == 6
    assert second_tools == {}
    assert second_status == "completed"
    unknown_id, unknown_usage, _, unknown_status, _ = registry.snapshot("another-session")
    assert unknown_id == ""
    assert unknown_usage.total_tokens == 0
    assert unknown_status is None


def test_terminal_api_error_marks_turn_failed() -> None:
    registry = TelemetryRegistry()
    registry.pre_api_request(platform="feishu", session_id="session", turn_id="turn")
    registry.api_request_error(
        platform="feishu",
        session_id="session",
        turn_id="turn",
        retryable=True,
        retry_count=1,
        max_retries=3,
        error={"message": "temporary"},
    )
    assert registry.snapshot("session")[3] is None
    registry.api_request_error(
        platform="feishu",
        session_id="session",
        turn_id="turn",
        retryable=True,
        retry_count=3,
        max_retries=3,
        error={"message": "provider unavailable"},
    )
    _, _, _, status, message = registry.snapshot("session")
    assert status == "failed"
    assert message == "provider unavailable"
