from __future__ import annotations

import os
from dataclasses import dataclass, field
from math import isfinite
from pathlib import Path
from typing import Any

from .models import Currency


def _bool(value: object, default: bool) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _int(value: object, default: int, minimum: int, maximum: int) -> int:
    if isinstance(value, bool) or not isinstance(value, (str, bytes, bytearray, int, float)):
        return default
    try:
        parsed = int(value)
    except (OverflowError, TypeError, ValueError):
        return default
    return min(maximum, max(minimum, parsed))


def _float(value: object, default: float) -> float:
    if isinstance(value, bool) or not isinstance(value, (str, bytes, bytearray, int, float)):
        return default
    try:
        parsed = float(value)
    except (OverflowError, TypeError, ValueError):
        return default
    return max(0.0, parsed) if isfinite(parsed) else default


@dataclass(frozen=True, slots=True)
class PricingRule:
    pattern: str
    currency: Currency = "CNY"
    input_per_million: float = 0.0
    output_per_million: float = 0.0
    cache_read_per_million: float = 0.0
    cache_write_per_million: float = 0.0


@dataclass(frozen=True, slots=True)
class Panels:
    reasoning: bool = True
    tools: bool = True
    progress: bool = True
    resources: bool = True
    footer: bool = True


@dataclass(frozen=True, slots=True)
class Footer:
    status: bool = True
    elapsed: bool = True
    first_token: bool = True
    model: bool = True
    tokens: bool = True
    cache: bool = True
    context: bool = True
    cost: bool = True
    totals: bool = True


@dataclass(frozen=True, slots=True)
class HermesCardConfig:
    enabled: bool = True
    timezone: str = "Asia/Shanghai"
    storage_dir: Path = field(
        default_factory=lambda: Path(
            os.getenv(
                "FEISHU_CARD_FOOTER_HOME",
                "~/.local/share/feishu-card-footer",
            )
        ).expanduser()
    )
    update_interval_ms: int = 800
    panels: Panels = field(default_factory=Panels)
    footer: Footer = field(default_factory=Footer)
    pricing: tuple[PricingRule, ...] = ()

    @classmethod
    def from_extra(cls, extra: dict[str, Any] | None) -> HermesCardConfig:
        root = dict(extra or {})
        raw_value = root.get("card_footer") or root.get("cardFooter")
        raw: dict[str, Any] = dict(raw_value) if isinstance(raw_value, dict) else {}
        panel_value = raw.get("panels")
        footer_value = raw.get("footer")
        pricing_value = raw.get("pricing")
        panel_raw: dict[str, Any] = dict(panel_value) if isinstance(panel_value, dict) else {}
        footer_raw: dict[str, Any] = dict(footer_value) if isinstance(footer_value, dict) else {}
        pricing_raw: list[Any] = list(pricing_value) if isinstance(pricing_value, list) else []

        pricing: list[PricingRule] = []
        for item in pricing_raw:
            if not isinstance(item, dict) or not str(item.get("pattern", "")).strip():
                continue
            currency: Currency = "USD" if str(item.get("currency", "CNY")).upper() == "USD" else "CNY"
            pricing.append(
                PricingRule(
                    pattern=str(item["pattern"]).strip(),
                    currency=currency,
                    input_per_million=_float(item.get("inputPerMillion", item.get("input_per_million")), 0),
                    output_per_million=_float(item.get("outputPerMillion", item.get("output_per_million")), 0),
                    cache_read_per_million=_float(
                        item.get("cacheReadPerMillion", item.get("cache_read_per_million")),
                        0,
                    ),
                    cache_write_per_million=_float(
                        item.get("cacheWritePerMillion", item.get("cache_write_per_million")),
                        0,
                    ),
                )
            )

        storage = str(
            raw.get("storageDir")
            or raw.get("storage_dir")
            or os.getenv("FEISHU_CARD_FOOTER_HOME")
            or "~/.local/share/feishu-card-footer"
        )
        return cls(
            enabled=_bool(raw.get("enabled"), True),
            timezone=str(raw.get("timezone") or "Asia/Shanghai"),
            storage_dir=Path(storage).expanduser().resolve(),
            update_interval_ms=_int(
                raw.get("updateIntervalMs", raw.get("update_interval_ms")),
                800,
                250,
                10_000,
            ),
            panels=Panels(
                reasoning=_bool(panel_raw.get("reasoning"), True),
                tools=_bool(panel_raw.get("tools"), True),
                progress=_bool(panel_raw.get("progress"), True),
                resources=_bool(panel_raw.get("resources"), True),
                footer=_bool(panel_raw.get("footer"), True),
            ),
            footer=Footer(
                status=_bool(footer_raw.get("status"), True),
                elapsed=_bool(footer_raw.get("elapsed"), True),
                first_token=_bool(footer_raw.get("firstToken", footer_raw.get("first_token")), True),
                model=_bool(footer_raw.get("model"), True),
                tokens=_bool(footer_raw.get("tokens"), True),
                cache=_bool(footer_raw.get("cache"), True),
                context=_bool(footer_raw.get("context"), True),
                cost=_bool(footer_raw.get("cost"), True),
                totals=_bool(footer_raw.get("totals"), True),
            ),
            pricing=tuple(pricing),
        )
