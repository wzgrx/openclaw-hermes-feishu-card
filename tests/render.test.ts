import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/core/config.js";
import {
  MAX_CARD_JSON_BYTES,
  MAX_CARD_TABLES,
  countCardElements,
  renderCard,
} from "../src/core/render.js";
import { CardSession } from "../src/core/state.js";

describe("renderCard", () => {
  it("renders the redesigned hierarchy in CardKit 2.0 format", () => {
    const session = new CardSession({
      id: "render-1",
      runtime: "openclaw",
      route: {
        channelId: "feishu",
        accountId: "work",
      },
      now: Date.parse("2026-07-30T01:00:00Z"),
    });
    session.applyReply("block", "<think>Inspecting</think>Answer in progress");
    session.startTool({
      id: "tool-1",
      name: "shell",
      input: { command: "pnpm test" },
    });
    session.finishTool({
      id: "tool-1",
      name: "shell",
      output: "passed",
      durationMs: 500,
    });
    session.setUsage({
      provider: "deepseek",
      model: "deepseek-v4",
      resolvedRef: "deepseek/deepseek-v4",
      requestedRef: "router/auto",
      fallbackUsed: true,
      reasoningEffort: "high",
      inputTokens: 1_200,
      outputTokens: 300,
      cacheReadTokens: 400,
      lastInputTokens: 200,
      lastOutputTokens: 100,
      lastCacheReadTokens: 400,
      contextUsedTokens: 2_000,
      contextTokenBudget: 128_000,
      contextSource: "reported",
      turnCost: 0.02,
      currency: "CNY",
    });

    const card = renderCard({
      session: session.snapshot(),
      config: resolveConfig({
        storageDir: "./tmp-test",
        title: "Default Bot",
        accountTitles: { work: "Work Bot" },
        panels: { resources: true },
        footer: {
          totals: true,
          todayTokens: true,
          monthTokens: true,
          backgroundTasks: true,
          balance: true,
        },
      }),
      totals: {
        todayTokens: 10_000,
        monthTokens: 100_000,
        allTimeTokens: 1_000_000,
        todayCost: 0.1,
        monthCost: 1,
        allTimeCost: 10,
        currency: "CNY",
      },
      resource: {
        sampledAt: Date.now(),
        cpuPercent: 25,
        loadAverage1m: 2,
        memoryUsedBytes: 8 * 1024 ** 3,
        memoryTotalBytes: 16 * 1024 ** 3,
        memoryPercent: 50,
        uptimeSeconds: 3_600,
      },
      legacy: {
        tasks: [
          {
            id: "sync",
            name: "同步知识库",
            status: "running",
            progress: 42,
          },
        ],
        balances: [
          {
            platform: "DeepSeek",
            total: 12.34,
            available: true,
          },
        ],
      },
      now: Date.parse("2026-07-30T01:00:05Z"),
    });

    expect(card.schema).toBe("2.0");
    expect((card.config as Record<string, unknown>).width_mode).toBe("fill");
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("Work Bot");
    expect(serialized).toContain("主机资源");
    expect(serialized).toContain("Execution log");
    expect(serialized).toContain("正在持续更新结果");
    expect(serialized).toContain("Diagnostics");
    expect(serialized).toContain("模型 DeepSeek · deepseek-v4");
    expect(serialized).toContain("deepseek-v4");
    expect(serialized).toContain("模型路由");
    expect(serialized).toContain("router/auto");
    expect(serialized).toContain("推理 high");
    expect(serialized).toContain("本轮 ↑ 1,200 ↓ 300");
    expect(serialized).toContain("上下文 2,000 / 128,000 (1.6%)");
    expect(serialized).toContain("末次模型调用");
    expect(serialized).toContain("插件本地累计");
    expect(serialized).toContain("后台任务");
    expect(serialized).toContain("DeepSeek");
    expect(serialized).not.toContain("100%");
    expect(serialized.indexOf("Answer in progress")).toBeLessThan(
      serialized.indexOf("Execution log"),
    );
    expect(countCardElements(card)).toBeLessThan(200);
    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThan(
      28_000,
    );
  });

  it("keeps a completed simple reply clean and removes fake progress", () => {
    const session = new CardSession({
      id: "simple",
      runtime: "openclaw",
      now: Date.parse("2026-07-30T01:00:00Z"),
    });
    session.applyReply("final", "这是最终答案。", {
      resolvedRef: "provider/model",
      inputTokens: 100,
      outputTokens: 20,
    });

    const card = renderCard({
      session: session.snapshot(),
      config: resolveConfig({ storageDir: "./tmp-test" }),
      totals: {
        todayTokens: 0,
        monthTokens: 0,
        allTimeTokens: 0,
        todayCost: 0,
        monthCost: 0,
        allTimeCost: 0,
      },
      now: Date.parse("2026-07-30T01:00:05Z"),
    });
    const serialized = JSON.stringify(card);

    expect(serialized).toContain("这是最终答案。");
    expect(serialized).toContain("已完成");
    expect(serialized).not.toContain("Diagnostics");
    expect(serialized).not.toContain("Task progress");
    expect(serialized).not.toContain("100%");
    expect(serialized).not.toContain("累计用量");
    expect(serialized).not.toContain("Execution log");
  });

  it("enforces the CardKit byte and markdown-table budgets", () => {
    const session = new CardSession({ id: "large", runtime: "openclaw" });
    const table = "| A | B |\n| --- | --- |\n| 甲 | 乙 |";
    session.applyReply(
      "block",
      `${Array.from({ length: 7 }, () => table).join("\n\n")}\n${"大".repeat(30_000)}`,
    );
    for (let index = 0; index < 20; index += 1) {
      session.startTool({
        id: `tool-${index}`,
        name: `tool-${index}`,
        input: "入".repeat(2_000),
      });
      session.finishTool({
        id: `tool-${index}`,
        name: `tool-${index}`,
        output: `${table}\n${"出".repeat(2_000)}`,
      });
    }

    const card = renderCard({
      session: session.snapshot(),
      config: resolveConfig({ storageDir: "./tmp-test" }),
      totals: {
        todayTokens: 0,
        monthTokens: 0,
        allTimeTokens: 0,
        todayCost: 0,
        monthCost: 0,
        allTimeCost: 0,
      },
    });
    const contents: string[] = [];
    const visit = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const child of value as unknown[]) {
          visit(child);
        }
      } else if (value && typeof value === "object") {
        const record = value as Record<string, unknown>;
        if (record.tag === "markdown" && typeof record.content === "string") {
          contents.push(record.content);
        }
        for (const child of Object.values(record)) {
          visit(child);
        }
      }
    };
    visit(card);

    expect(Buffer.byteLength(JSON.stringify(card), "utf8")).toBeLessThanOrEqual(
      MAX_CARD_JSON_BYTES,
    );
    const separatorCount = contents
      .flatMap((content) => content.split("\n"))
      .filter((line) => /^\| --- \| --- \|$/.test(line)).length;
    expect(separatorCount).toBeLessThanOrEqual(MAX_CARD_TABLES);
  });
});
