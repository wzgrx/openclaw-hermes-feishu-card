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
  it("keeps optional diagnostics behind the installed classic hierarchy", () => {
    const session = new CardSession({
      id: "render-1",
      runtime: "openclaw",
      route: {
        channelId: "feishu",
        accountId: "work",
      },
      now: Date.parse("2026-07-30T01:00:00Z"),
    });
    session.applyReply("block", "<think>Inspecting</think>");
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
    session.applyReply("final", "Answer in progress");
    session.setUsage({
      provider: "deepseek",
      model: "deepseek-v4",
      resolvedRef: "deepseek/deepseek-v4",
      api: "openai-completions",
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
    const serialized = JSON.stringify(card);
    expect(serialized).toContain("主机资源");
    expect(serialized).toContain("🛠️ 执行耗时 0.5s");
    expect(serialized).toContain("💭 思考");
    expect(serialized).toContain("Diagnostics");
    expect(serialized).toContain(
      "deepseek/deepseek-v4 · API openai-completions",
    );
    expect(serialized).toContain("模型路由");
    expect(serialized).toContain("router/auto");
    expect(serialized).toContain("末次模型调用");
    expect(serialized).toContain("插件本地累计");
    expect(serialized).toContain("后台任务");
    expect(serialized).not.toContain("100%");
    const bodyElements = (
      card.body as { elements: Array<Record<string, unknown>> }
    ).elements;
    expect(bodyElements[0]?.tag).toBe("collapsible_panel");
    expect(bodyElements[2]?.content).toBe("Answer in progress");
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
    expect(card).not.toHaveProperty("header");
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    expect(elements.map((element) => element.tag)).toEqual([
      "collapsible_panel",
      "markdown",
      "markdown",
    ]);
    expect(elements[0]).toMatchObject({
      expanded: false,
      border: { color: "grey", corner_radius: "5px" },
    });
    expect(elements.at(-1)).toMatchObject({
      tag: "markdown",
      text_size: "notation",
    });
    expect(serialized).not.toContain("Diagnostics");
    expect(serialized).not.toContain("Task progress");
    expect(serialized).not.toContain("100%");
    expect(serialized).not.toContain("累计用量");
    expect(serialized).toContain("未调用工具");
  });

  it("uses the old no-header streaming card with an expanded active tool panel", () => {
    const session = new CardSession({
      id: "running",
      runtime: "openclaw",
      now: Date.parse("2026-07-30T01:00:00Z"),
    });
    session.startTool({
      id: "tool",
      name: "终端",
      input: "echo ok",
      now: Date.parse("2026-07-30T01:00:00Z"),
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
      now: Date.parse("2026-07-30T01:00:02Z"),
    });
    expect(card).not.toHaveProperty("header");
    const elements = (card.body as { elements: Array<Record<string, unknown>> })
      .elements;
    expect(
      elements.map((element) => element.element_id ?? element.tag),
    ).toEqual(["collapsible_panel", "streaming_content", "loading_icon"]);
    expect(elements[0]).toMatchObject({
      expanded: true,
      border: { color: "grey", corner_radius: "5px" },
      header: {
        title: {
          i18n_content: { zh_cn: "🛠️ 工具执行 · 1 步 · (2.0s)" },
        },
      },
    });
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
