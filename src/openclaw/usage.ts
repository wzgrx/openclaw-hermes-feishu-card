import type { PluginHookReplyPayloadSendingEvent } from "openclaw/plugin-sdk/core";

import type { UsageSnapshot } from "../core/types.js";

type PluginHookReplyUsageState = NonNullable<
  PluginHookReplyPayloadSendingEvent["usageState"]
>;

function cleanText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

function splitModelRef(value: string | undefined): {
  provider?: string;
  model?: string;
} {
  const ref = cleanText(value);
  if (!ref) {
    return {};
  }
  const separator = ref.indexOf("/");
  if (separator <= 0 || separator === ref.length - 1) {
    return { model: ref };
  }
  return {
    provider: ref.slice(0, separator),
    model: ref.slice(separator + 1),
  };
}

function promptTokens(
  usage:
    | {
        input?: number;
        cacheRead?: number;
        cacheWrite?: number;
      }
    | undefined,
): number | undefined {
  if (!usage) {
    return undefined;
  }
  const parts = [
    tokenCount(usage.input),
    tokenCount(usage.cacheRead),
    tokenCount(usage.cacheWrite),
  ];
  if (parts.every((part) => part === undefined)) {
    return undefined;
  }
  return parts.reduce<number>((total, part) => total + (part ?? 0), 0);
}

/** Normalize OpenClaw's authoritative per-turn metadata for card rendering. */
export function normalizeOpenClawUsage(
  state: PluginHookReplyUsageState | undefined,
): UsageSnapshot | undefined {
  if (!state) {
    return undefined;
  }

  const stateProvider = cleanText(state.provider);
  const stateModel = cleanText(state.model);
  const resolvedRef =
    cleanText(state.resolvedRef) ??
    (stateProvider && stateModel
      ? `${stateProvider}/${stateModel}`
      : stateModel);
  const resolved = splitModelRef(resolvedRef);
  const modelRef = splitModelRef(stateModel);
  const provider = resolved.provider ?? stateProvider ?? modelRef.provider;
  const model = resolved.model ?? modelRef.model ?? stateModel;
  const requestedRef = cleanText(state.requested);
  const reasoningEffort = cleanText(state.reasoningEffort);
  const authMode = cleanText(state.authMode);
  const overrideSource = cleanText(state.overrideSource);
  const usage = state.usage;
  const lastUsage = state.lastUsage;

  const reportedContext = tokenCount(state.contextUsedTokens);
  const lastCallContext = promptTokens(lastUsage);
  const aggregateContext = promptTokens(usage);
  const contextUsedTokens =
    reportedContext ?? lastCallContext ?? aggregateContext;
  const contextSource =
    reportedContext !== undefined
      ? ("reported" as const)
      : lastCallContext !== undefined
        ? ("last_call" as const)
        : aggregateContext !== undefined
          ? ("aggregate" as const)
          : undefined;

  const fallbackUsed =
    state.fallbackUsed === true ||
    Boolean(
      requestedRef &&
      resolvedRef &&
      requestedRef.toLowerCase() !== resolvedRef.toLowerCase(),
    );

  const normalized: UsageSnapshot = {};
  if (provider) normalized.provider = provider;
  if (model) normalized.model = model;
  if (resolvedRef) normalized.resolvedRef = resolvedRef;
  if (requestedRef) normalized.requestedRef = requestedRef;
  if (reasoningEffort) normalized.reasoningEffort = reasoningEffort;
  if (state.fastMode !== undefined) normalized.fastMode = state.fastMode;
  if (fallbackUsed) normalized.fallbackUsed = true;
  if (authMode) normalized.authMode = authMode;
  if (overrideSource) normalized.overrideSource = overrideSource;

  const tokenFields: Array<[keyof UsageSnapshot, number | undefined]> = [
    ["inputTokens", tokenCount(usage?.input)],
    ["outputTokens", tokenCount(usage?.output)],
    ["cacheReadTokens", tokenCount(usage?.cacheRead)],
    ["cacheWriteTokens", tokenCount(usage?.cacheWrite)],
    ["totalTokens", tokenCount(usage?.total)],
    ["lastInputTokens", tokenCount(lastUsage?.input)],
    ["lastOutputTokens", tokenCount(lastUsage?.output)],
    ["lastCacheReadTokens", tokenCount(lastUsage?.cacheRead)],
    ["lastCacheWriteTokens", tokenCount(lastUsage?.cacheWrite)],
    ["lastTotalTokens", tokenCount(lastUsage?.total)],
    ["contextUsedTokens", contextUsedTokens],
    ["contextTokenBudget", tokenCount(state.contextTokenBudget)],
    ["durationMs", tokenCount(state.durationMs)],
  ];
  for (const [field, value] of tokenFields) {
    if (value !== undefined) {
      (normalized as Record<string, unknown>)[field] = value;
    }
  }
  if (contextSource) normalized.contextSource = contextSource;
  const turnUsd = tokenCount(state.turnUsd);
  if (turnUsd !== undefined) {
    normalized.turnCost = turnUsd;
    normalized.currency = "USD";
  }
  return normalized;
}
