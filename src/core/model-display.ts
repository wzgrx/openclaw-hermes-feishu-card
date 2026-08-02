import type { UsageSnapshot } from "./types.js";

function clean(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized || undefined;
}

/**
 * Render the exact runtime identity without guessing a vendor display name.
 * The resolved provider/model ref and adapter API come from OpenClaw hooks.
 */
export function formatModelRuntimeIdentity(usage: {
  provider?: UsageSnapshot["provider"] | undefined;
  model?: UsageSnapshot["model"] | undefined;
  resolvedRef?: UsageSnapshot["resolvedRef"] | undefined;
  api?: UsageSnapshot["api"] | undefined;
}): string | undefined {
  const provider = clean(usage.provider);
  const model = clean(usage.model);
  const resolvedRef = clean(usage.resolvedRef);
  const identity =
    resolvedRef ??
    (provider && model
      ? model.toLowerCase().startsWith(`${provider.toLowerCase()}/`)
        ? model
        : `${provider}/${model}`
      : (model ?? provider));
  if (!identity) return undefined;
  const api = clean(usage.api);
  return api ? `${identity} · API ${api}` : identity;
}
