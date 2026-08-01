import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { UsageLedger } from "../src/core/ledger.js";
import { applyPricing, findPricingRule } from "../src/core/pricing.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("pricing", () => {
  const rules = [
    {
      pattern: "deepseek/*",
      currency: "CNY" as const,
      inputPerMillion: 2,
      outputPerMillion: 8,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 2,
    },
  ];

  it("matches model globs and calculates a per-turn price", () => {
    expect(findPricingRule("deepseek/deepseek-v4", rules)).toBe(rules[0]);
    expect(
      applyPricing(
        {
          resolvedRef: "deepseek/deepseek-v4",
          inputTokens: 1_000_000,
          outputTokens: 500_000,
          cacheReadTokens: 1_000_000,
        },
        rules,
      ),
    ).toEqual(
      expect.objectContaining({
        turnCost: 6.2,
        currency: "CNY",
      }),
    );
    expect(
      applyPricing(
        {
          provider: "deepseek",
          model: "deepseek-v4",
          inputTokens: 1_000_000,
        },
        rules,
      ).turnCost,
    ).toBe(2);
  });

  it("keeps an authoritative runtime-reported cost", () => {
    expect(
      applyPricing(
        {
          resolvedRef: "deepseek/deepseek-v4",
          inputTokens: 1_000_000,
          turnCost: 0.1234,
          currency: "USD",
        },
        rules,
      ),
    ).toMatchObject({ turnCost: 0.1234, currency: "USD" });
  });
});

describe("UsageLedger", () => {
  it("deduplicates event ids and rolls up day/month/all-time values", () => {
    const storageDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "card-footer-ledger-"),
    );
    temporaryDirectories.push(storageDir);
    const ledger = new UsageLedger({ storageDir, timezone: "Asia/Shanghai" });
    const morning = Date.parse("2026-07-30T00:00:00+08:00");
    const previousMonth = Date.parse("2026-06-30T00:00:00+08:00");

    expect(
      ledger.append({
        id: "turn-1",
        runtime: "openclaw",
        timestamp: morning,
        usage: { totalTokens: 120, turnCost: 1.5, currency: "CNY" },
      }),
    ).toBe(true);
    expect(
      ledger.append({
        id: "turn-1",
        runtime: "openclaw",
        timestamp: morning,
        usage: { totalTokens: 999 },
      }),
    ).toBe(false);
    ledger.append({
      id: "turn-2",
      runtime: "hermes",
      timestamp: previousMonth,
      usage: { totalTokens: 30, turnCost: 0.5, currency: "CNY" },
    });
    fs.appendFileSync(
      ledger.filePath,
      `${JSON.stringify({
        schemaVersion: 1,
        id: "hermes-turn",
        runtime: "hermes",
        timestamp: morning,
        usage: { totalTokens: 80, turnCost: 0.25, currency: "CNY" },
      })}\n`,
    );

    expect(ledger.totals(morning + 3_600_000)).toEqual({
      todayTokens: 200,
      monthTokens: 200,
      allTimeTokens: 230,
      todayCost: 1.75,
      monthCost: 1.75,
      allTimeCost: 2.25,
      currency: "CNY",
    });
  });
});
