import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/core/config.js";
import {
  createOfficialPluginApi,
  enrichNativeLarkCard,
  NativeLarkMetricsRegistry,
  patchNativeLarkModules,
  NativeLarkIntegration,
} from "../src/openclaw/native-lark.js";

describe("native @larksuite/openclaw-lark integration", () => {
  it("shares one metrics registry across repeated OpenClaw plugin registrations", () => {
    const api = {} as Parameters<typeof createOfficialPluginApi>[0];
    const config = resolveConfig({});
    expect(new NativeLarkIntegration(api, config).registry).toBe(
      new NativeLarkIntegration(api, config).registry,
    );
  });

  it("adapts OpenClaw beta config.current() to the stable loadConfig() contract", () => {
    const config = { channels: { feishu: { enabled: true } } };
    const api = {
      runtime: { config: { current: () => config } },
    } as unknown as Parameters<typeof createOfficialPluginApi>[0];

    const compatible = createOfficialPluginApi(api) as unknown as {
      runtime: { config: { loadConfig: () => unknown } };
    };
    expect(compatible.runtime.config.loadConfig()).toBe(config);
  });

  it("captures real per-call usage and keeps aggregate and context semantics separate", () => {
    const registry = new NativeLarkMetricsRegistry();
    const ctx = {
      sessionKey: "agent:main:feishu:group:oc_test",
      messageProvider: "feishu",
      contextTokenBudget: 256_000,
    };
    registry.capture(
      {
        runId: "run-1",
        provider: "volcengine",
        model: "doubao-seed-2-1-turbo-260628",
        resolvedRef: "volcengine/doubao-seed-2-1-turbo-260628",
        reasoningEffort: "medium",
        usage: {
          input: 50_000,
          output: 20,
          cacheRead: 5_000,
          cacheWrite: 0,
          total: 55_020,
        },
        lastAssistant: { usage: { cost: { total: 0.02 } } },
      },
      ctx,
    );
    registry.capture(
      {
        runId: "run-1",
        provider: "volcengine",
        model: "doubao-seed-2-1-turbo-260628",
        reasoningEffort: "medium",
        usage: {
          input: 2_000,
          output: 22,
          cacheRead: 55_000,
          cacheWrite: 0,
          total: 57_022,
        },
        lastAssistant: { message: { usage: { cost: { total: 0.0054 } } } },
      },
      ctx,
    );

    expect(registry.get(ctx.sessionKey)).toMatchObject({
      inputTokens: 52_000,
      outputTokens: 42,
      cacheReadTokens: 60_000,
      contextUsedTokens: 57_000,
      contextTokenBudget: 256_000,
      turnCostUsd: 0.0254,
      provider: "volcengine",
      model: "doubao-seed-2-1-turbo-260628",
    });
  });

  it("restores the legacy answer-first card, timeline, and compact footer", () => {
    const card = enrichNativeLarkCard({
      card: {
        config: { wide_screen_mode: true },
        elements: [
          { tag: "collapsible_panel", elements: [], expanded: false },
          { tag: "markdown", content: "最终答案" },
        ],
      },
      data: {
        elapsedMs: 28_800,
        toolUseSteps: [{ name: "system" }],
        footerMetrics: {
          provider: "volcengine",
          model: "doubao-seed-2-1-turbo-260628",
          reasoningEffort: "medium",
          reasoningEffortDefault: true,
          firstTokenMs: 5_420,
          inputTokens: 57_370,
          outputTokens: 22,
          contextUsedTokens: 57_370,
          contextTokens: 256_000,
          turnCostUsd: 0.0254,
        },
      },
      config: resolveConfig({}),
    });

    expect(card).not.toHaveProperty("header");
    const elements = card.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(4);
    expect(elements[0]?.content).toBe("最终答案");
    expect(elements[1]).toMatchObject({
      tag: "collapsible_panel",
      element_id: "auxiliary_timeline",
      expanded: false,
      header: {
        title: {
          tag: "plain_text",
          content: "思考与工具 · 1 次工具调用",
        },
        vertical_align: "center",
      },
      border: { color: "grey", corner_radius: "8px" },
      padding: "8px 8px 8px 8px",
    });
    expect(elements[2]).toEqual({ tag: "hr", element_id: "main_divider" });
    expect(elements[3]).toEqual({
      tag: "markdown",
      element_id: "footer",
      content:
        "已完成 · 29s · doubao-seed-2-1-turbo-260628 · ↑57.4k · ↓22 · ctx 57.4k/256k 22%",
      text_size: "x-small",
    });
  });

  it("patches the channel-owned controller without duplicating its native footer", async () => {
    const registry = new NativeLarkMetricsRegistry();
    const ctx = {
      sessionKey: "agent:main:feishu:group:oc_patch",
      messageProvider: "feishu",
    };
    registry.capture(
      {
        runId: "run-patch",
        provider: "openai",
        model: "gpt-test",
        contextTokenBudget: 10_000,
        usage: { input: 1_000, output: 50, total: 1_050 },
      },
      ctx,
    );
    let originalData: Record<string, unknown> | undefined;
    const builder = {
      buildCardContent: (_state: string, data?: Record<string, unknown>) => {
        originalData = data;
        return { elements: [{ tag: "markdown", content: "answer" }] };
      },
      toCardKit2: (card: Record<string, unknown>) => ({
        schema: "2.0",
        config: {},
        body: { elements: card.elements },
      }),
    };
    class Controller {
      deps = { sessionKey: ctx.sessionKey, accountId: "default" };
      getFooterSessionMetrics(): Promise<unknown> {
        return Promise.resolve({ model: "stale-store-model" });
      }
    }
    const controller = { StreamingCardController: Controller };
    patchNativeLarkModules({
      builder,
      controller,
      registry,
      config: resolveConfig({}),
    });

    const metrics =
      (await new Controller().getFooterSessionMetrics()) as Record<
        string,
        unknown
      >;
    expect(metrics).toMatchObject({
      provider: "openai",
      model: "gpt-test",
      inputTokens: 1_000,
      contextTokens: 10_000,
      accountId: "default",
    });
    const card = builder.buildCardContent("complete", {
      elapsedMs: 1_500,
      footer: { status: true, model: true },
      footerMetrics: metrics,
    }) as { elements: Array<Record<string, unknown>> };
    expect(originalData?.footer).toMatchObject({
      status: false,
      model: false,
    });
    expect(card.elements).toHaveLength(4);
    expect(card.elements[1]).toMatchObject({
      tag: "markdown",
      element_id: "tool_summary",
      content: "工具调用 0 次",
    });
    expect(card.elements.at(-1)).toMatchObject({
      content:
        '已完成 · 2s · <font color="blue">gpt-test</font> · ↑1k · ↓50 · ctx 1k/10k 10%',
      text_size: "x-small",
    });
    const cardKit = builder.toCardKit2(card);
    expect(cardKit).toMatchObject({
      config: {},
      body: { elements: card.elements },
    });
  });

  it("captures the first model response byte for the run summary", () => {
    const registry = new NativeLarkMetricsRegistry();
    const ctx = {
      sessionKey: "agent:main:feishu:group:oc_ttfb",
      messageProvider: "feishu",
    };
    registry.captureModelCallEnded(
      { runId: "run-ttfb", timeToFirstByteMs: 5_420 },
      ctx,
    );
    registry.captureModelCallEnded(
      { runId: "run-ttfb", timeToFirstByteMs: 8_300 },
      ctx,
    );
    expect(registry.get(ctx.sessionKey)).toMatchObject({
      runId: "run-ttfb",
      firstTokenMs: 5_420,
    });
  });
});
