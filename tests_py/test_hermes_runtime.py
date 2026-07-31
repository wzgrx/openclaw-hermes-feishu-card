from __future__ import annotations

import importlib.util
import sys
import types
from pathlib import Path
from types import SimpleNamespace
from typing import Any, ClassVar
from uuid import uuid4

import pytest

gateway_config = pytest.importorskip("gateway.config")
gateway_base = pytest.importorskip("gateway.platforms.base")
gateway_events = pytest.importorskip("gateway.stream_events")

PlatformConfig = gateway_config.PlatformConfig
SendResult = gateway_base.SendResult
Commentary = gateway_events.Commentary


class FakeCardKit:
    instances: ClassVar[list[FakeCardKit]] = []

    def __init__(self, _client: object) -> None:
        self.created: list[dict[str, Any]] = []
        self.updated: list[tuple[str, dict[str, Any], int]] = []
        self.closed: list[tuple[str, int]] = []
        self.__class__.instances.append(self)

    async def create(self, card: dict[str, Any]) -> str:
        self.created.append(card)
        return "card-1"

    async def update(self, card_id: str, card: dict[str, Any], sequence: int) -> None:
        self.updated.append((card_id, card, sequence))

    async def close_stream(self, card_id: str, sequence: int) -> None:
        self.closed.append((card_id, sequence))


@pytest.mark.asyncio
async def test_adapter_send_edit_segment_and_final_lifecycle(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    import hermes_feishu_card_footer.adapter as adapter_module
    from hermes_feishu_card_footer.adapter import HermesFeishuCardAdapter
    from hermes_feishu_card_footer.telemetry import telemetry_registry

    session_id = f"runtime-{uuid4()}"
    FakeCardKit.instances.clear()
    monkeypatch.setattr(adapter_module, "CardKitClient", FakeCardKit)
    monkeypatch.setenv("HERMES_SESSION_ID", session_id)
    config = PlatformConfig(
        enabled=True,
        extra={
            "app_id": "cli_fixture",
            "app_secret": "secret_fixture",
            "card_footer": {
                "storage_dir": str(tmp_path),
                "panels": {"resources": False},
            },
        },
    )
    adapter = HermesFeishuCardAdapter(config)
    adapter._client = object()

    async def fake_reference(
        _self: HermesFeishuCardAdapter,
        _session: object,
        _card_id: str,
    ) -> SendResult:
        return SendResult(success=True, message_id="om-card")

    monkeypatch.setattr(
        adapter,
        "_send_card_reference",
        types.MethodType(fake_reference, adapter),
    )

    commentary_deltas: list[str] = []
    adapter.render_message_event(
        Commentary(text="Checking the source"),
        SimpleNamespace(on_delta=commentary_deltas.append),
    )
    assert commentary_deltas == ["<reasoning>Checking the source</reasoning>"]

    telemetry_registry.pre_api_request(
        platform="feishu",
        session_id=session_id,
        turn_id="turn-runtime",
    )
    telemetry_registry.post_api_request(
        platform="feishu",
        session_id=session_id,
        turn_id="turn-runtime",
        provider="fixture",
        model="fixture-model",
        finish_reason="tool_calls",
        assistant_tool_call_count=1,
        usage={"input_tokens": 10, "output_tokens": 2},
    )

    initial = await adapter.send(
        "oc-chat",
        "Searching…",
        reply_to="om-input",
        metadata={"expect_edits": True},
    )
    assert initial.success and initial.message_id == "om-card"
    session = adapter._by_message["om-card"]
    assert session.status == "running"

    marker = adapter.format_tool_event(
        SimpleNamespace(
            tool_name="browser",
            index=0,
            preview="https://example.test",
            args={"url": "https://example.test"},
        ),
        mode="verbose",
    )
    assert marker
    marker_result = await adapter.send(
        "oc-chat",
        marker,
        metadata={"reply_to_message_id": "om-input"},
    )
    assert marker_result.message_id
    assert marker_result.message_id.startswith("hfc-tool-")

    segment = await adapter.edit_message(
        "oc-chat",
        "om-card",
        "Searching…",
        finalize=True,
    )
    assert segment.success
    assert session.status == "running"
    assert not any(instance.closed for instance in FakeCardKit.instances)

    telemetry_registry.pre_tool_call(
        session_id=session_id,
        turn_id="turn-runtime",
        tool_call_id="tool-1",
        tool_name="browser",
        args={"url": "https://example.test"},
    )
    telemetry_registry.post_tool_call(
        session_id=session_id,
        turn_id="turn-runtime",
        tool_call_id="tool-1",
        tool_name="browser",
        status="ok",
        result={"title": "Example"},
        duration_ms=25,
    )
    telemetry_registry.pre_api_request(
        platform="feishu",
        session_id=session_id,
        turn_id="turn-runtime",
    )
    telemetry_registry.post_api_request(
        platform="feishu",
        session_id=session_id,
        turn_id="turn-runtime",
        provider="fixture",
        model="fixture-model",
        finish_reason="stop",
        assistant_tool_call_count=0,
        usage={"input_tokens": 4, "output_tokens": 6},
    )

    final = await adapter.edit_message(
        "oc-chat",
        "om-card",
        "Finished.",
        finalize=True,
    )
    assert final.success
    assert session.status == "completed"
    assert session.usage.total_tokens == 22
    assert session.tools["0"].status == "completed"
    assert sum(len(instance.closed) for instance in FakeCardKit.instances) == 1
    assert (tmp_path / "usage.ndjson").exists()


def test_directory_plugin_registration_contract() -> None:
    class Context:
        def __init__(self) -> None:
            self.platform: dict[str, Any] = {}
            self.hooks: list[str] = []

        def register_platform(self, **kwargs: Any) -> None:
            self.platform = kwargs

        def register_hook(self, name: str, _handler: object) -> None:
            self.hooks.append(name)

    root = Path(__file__).resolve().parents[1]
    module_name = f"_hfc_directory_plugin_{uuid4().hex}"
    spec = importlib.util.spec_from_file_location(
        module_name,
        root / "__init__.py",
        submodule_search_locations=[str(root)],
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    try:
        spec.loader.exec_module(module)
        context = Context()
        module.register(context)
    finally:
        for name in [name for name in sys.modules if name.startswith(module_name)]:
            sys.modules.pop(name, None)

    assert context.platform["name"] == "feishu"
    assert context.hooks == [
        "pre_api_request",
        "post_api_request",
        "api_request_error",
        "pre_tool_call",
        "post_tool_call",
    ]
    adapter = context.platform["adapter_factory"](
        PlatformConfig(
            enabled=True,
            extra={
                "app_id": "cli_fixture",
                "app_secret": "secret_fixture",
                "card_footer": {"panels": {"resources": False}},
            },
        )
    )
    assert adapter.__class__.__name__ == "HermesFeishuCardAdapter"
