import type { PricingRule, UsageSnapshot } from "./types.js";

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", ".*")
    .replaceAll("?", ".");
  return new RegExp(`^${escaped}$`, "i");
}

export function findPricingRule(
  model: string | undefined,
  rules: PricingRule[],
): PricingRule | undefined {
  if (!model) {
    return undefined;
  }
  return rules.find((rule) => globToRegExp(rule.pattern).test(model));
}

export function applyPricing(
  usage: UsageSnapshot,
  rules: PricingRule[],
): UsageSnapshot {
  const model =
    usage.resolvedRef ??
    (usage.provider && usage.model
      ? `${usage.provider}/${usage.model}`
      : usage.model);
  const rule = findPricingRule(model, rules);
  if (!rule) {
    return usage;
  }
  const cost =
    ((usage.inputTokens ?? 0) * rule.inputPerMillion +
      (usage.outputTokens ?? 0) * rule.outputPerMillion +
      (usage.cacheReadTokens ?? 0) * rule.cacheReadPerMillion +
      (usage.cacheWriteTokens ?? 0) * rule.cacheWritePerMillion) /
    1_000_000;
  return {
    ...usage,
    turnCost: cost,
    currency: rule.currency,
  };
}
