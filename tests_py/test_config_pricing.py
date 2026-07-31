from __future__ import annotations

from openclaw_hermes_feishu_card.config import HermesCardConfig
from openclaw_hermes_feishu_card.models import UsageSnapshot
from openclaw_hermes_feishu_card.pricing import calculate_cost, resolve_pricing_rule


def test_config_supports_camel_case_and_snake_case(tmp_path) -> None:
    config = HermesCardConfig.from_extra(
        {
            "card_footer": {
                "storageDir": str(tmp_path),
                "updateIntervalMs": 100,
                "title": "Hermes Bot",
                "panels": {"reasoning": False},
                "footer": {
                    "first_token": False,
                    "backgroundTasks": False,
                    "balance": False,
                },
                "pricing": [
                    {
                        "pattern": "openrouter/*",
                        "currency": "USD",
                        "inputPerMillion": 2,
                        "output_per_million": 4,
                    }
                ],
            }
        }
    )
    assert config.storage_dir == tmp_path.resolve()
    assert config.update_interval_ms == 250
    assert config.title == "Hermes Bot"
    assert config.panels.reasoning is False
    assert config.footer.first_token is False
    assert config.footer.background_tasks is False
    assert config.footer.balance is False
    assert config.pricing[0].currency == "USD"


def test_pricing_glob_and_cost() -> None:
    config = HermesCardConfig.from_extra(
        {
            "card_footer": {
                "pricing": [
                    {
                        "pattern": "openrouter/qwen-*",
                        "inputPerMillion": 2,
                        "outputPerMillion": 6,
                        "cacheReadPerMillion": 1,
                        "cacheWritePerMillion": 3,
                    }
                ]
            }
        }
    )
    rule = resolve_pricing_rule(config.pricing, "openrouter", "qwen-3")
    usage = UsageSnapshot(
        input_tokens=1_000_000,
        output_tokens=500_000,
        cache_read_tokens=100_000,
        cache_write_tokens=100_000,
    )
    assert calculate_cost(usage, rule) == 5.4
