from __future__ import annotations

from fnmatch import fnmatchcase

from .config import PricingRule
from .models import UsageSnapshot


def resolve_pricing_rule(rules: tuple[PricingRule, ...], provider: str, model: str) -> PricingRule | None:
    ref = f"{provider}/{model}".strip("/")
    for rule in rules:
        if fnmatchcase(ref.lower(), rule.pattern.lower()):
            return rule
    return None


def calculate_cost(usage: UsageSnapshot, rule: PricingRule | None) -> float | None:
    if rule is None:
        return None
    return (
        usage.input_tokens * rule.input_per_million
        + usage.output_tokens * rule.output_per_million
        + usage.cache_read_tokens * rule.cache_read_per_million
        + usage.cache_write_tokens * rule.cache_write_per_million
    ) / 1_000_000
