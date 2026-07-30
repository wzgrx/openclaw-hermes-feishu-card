from __future__ import annotations

from typing import Any

from plugins.platforms.feishu.adapter import _apply_yaml_config as _native_apply_yaml_config
from plugins.platforms.feishu.adapter import (
    _is_connected,
    _standalone_send,
    check_feishu_requirements,
    interactive_setup,
)

from .adapter import HermesFeishuCardAdapter
from .telemetry import (
    on_api_request_error,
    on_post_api_request,
    on_post_tool_call,
    on_pre_api_request,
    on_pre_tool_call,
)


def _apply_yaml_config(
    yaml_cfg: dict[str, Any],
    feishu_cfg: dict[str, Any],
) -> dict[str, Any] | None:
    native = _native_apply_yaml_config(yaml_cfg, feishu_cfg) or {}
    result = dict(native)
    card_footer = feishu_cfg.get("card_footer") or feishu_cfg.get("cardFooter")
    if isinstance(card_footer, dict):
        result["card_footer"] = dict(card_footer)
    return result or None


def register(ctx: Any) -> None:
    """Register the CardKit-enhanced native Feishu platform."""
    ctx.register_platform(
        name="feishu",
        label="Feishu / Lark · CardKit",
        adapter_factory=lambda cfg: HermesFeishuCardAdapter(cfg),
        check_fn=check_feishu_requirements,
        is_connected=_is_connected,
        validate_config=_is_connected,
        required_env=["FEISHU_APP_ID", "FEISHU_APP_SECRET"],
        install_hint="Run `hermes setup` to install Feishu support.",
        setup_fn=interactive_setup,
        apply_yaml_config_fn=_apply_yaml_config,
        allowed_users_env="FEISHU_ALLOWED_USERS",
        allow_all_env="FEISHU_ALLOW_ALL_USERS",
        cron_deliver_env_var="FEISHU_HOME_CHANNEL",
        standalone_sender_fn=_standalone_send,
        max_message_length=8000,
        emoji="🪽",
        allow_update_command=True,
    )
    ctx.register_hook("pre_api_request", on_pre_api_request)
    ctx.register_hook("post_api_request", on_post_api_request)
    ctx.register_hook("api_request_error", on_api_request_error)
    ctx.register_hook("pre_tool_call", on_pre_tool_call)
    ctx.register_hook("post_tool_call", on_post_tool_call)
