import { describe, expect, it } from "vitest";

import { normalizeOpenClawUsage } from "../src/openclaw/usage.js";

describe("normalizeOpenClawUsage", () => {
  it("separates the actual provider and model and keeps requested routing", () => {
    const usage = normalizeOpenClawUsage({
      provider: "configured-provider",
      model: "configured-model",
      requested: "configured-provider/configured-model",
      resolvedRef: "actual-provider/model/family-v2",
      fallbackUsed: true,
      reasoningEffort: "high",
      fastMode: false,
      overrideSource: "session",
    });

    expect(usage).toMatchObject({
      provider: "actual-provider",
      model: "model/family-v2",
      resolvedRef: "actual-provider/model/family-v2",
      requestedRef: "configured-provider/configured-model",
      fallbackUsed: true,
      reasoningEffort: "high",
      fastMode: false,
      overrideSource: "session",
    });
  });

  it("uses reported final context occupancy and preserves aggregate and last-call usage", () => {
    const usage = normalizeOpenClawUsage({
      provider: "volcengine",
      model: "doubao-seed-2-1-turbo-260628",
      resolvedRef: "volcengine/doubao-seed-2-1-turbo-260628",
      contextUsedTokens: 50_293,
      contextTokenBudget: 256_000,
      usage: {
        input: 54_437,
        output: 716,
        cacheRead: 48_952,
        total: 50_293,
      },
      lastUsage: {
        input: 1_341,
        output: 217,
        cacheRead: 48_952,
        cacheWrite: 0,
        total: 50_510,
      },
      turnUsd: 0.00540868651,
    });

    expect(usage).toMatchObject({
      provider: "volcengine",
      model: "doubao-seed-2-1-turbo-260628",
      inputTokens: 54_437,
      outputTokens: 716,
      cacheReadTokens: 48_952,
      lastInputTokens: 1_341,
      lastOutputTokens: 217,
      lastCacheReadTokens: 48_952,
      contextUsedTokens: 50_293,
      contextTokenBudget: 256_000,
      contextSource: "reported",
      turnCost: 0.00540868651,
      currency: "USD",
    });
  });

  it("derives context from the final call before the turn aggregate", () => {
    const state = {
      usage: { input: 20_000, cacheRead: 30_000 },
      lastUsage: { input: 1_000, cacheRead: 8_000, cacheWrite: 500 },
      contextTokenBudget: 128_000,
    };

    expect(normalizeOpenClawUsage(state)).toMatchObject({
      contextUsedTokens: 9_500,
      contextSource: "last_call",
    });
  });

  it("marks aggregate-only context as an estimate", () => {
    expect(
      normalizeOpenClawUsage({
        usage: { input: 1_000, cacheRead: 2_000 },
        contextTokenBudget: 128_000,
      }),
    ).toMatchObject({
      contextUsedTokens: 3_000,
      contextSource: "aggregate",
    });
  });
});
