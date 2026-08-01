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

  it("adds an answer-first header and an expanded structured runtime panel", () => {
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

    expect(card.header).toMatchObject({
      template: "green",
      title: { content: "OpenClaw" },
      subtitle: { content: "智能任务卡片" },
      text_tag_list: [
        { text: { content: "已完成" } },
        { text: { content: "1 步" } },
      ],
    });
    const elements = card.elements as Array<Record<string, unknown>>;
    expect(elements).toHaveLength(4);
    expect(elements[0]?.content).toBe("最终答案");
    expect(elements.at(-1)?.tag).toBe("collapsible_panel");
    expect(elements.at(-1)?.header).toMatchObject({
      title: {
        content: "📊 运行详情 · 已完成 · 耗时 28.8s · 首字节 5.4s",
      },
    });
    const runtimeContent = (
      elements.at(-1)?.elements as Array<Record<string, unknown>>
    )[0]?.content;
    expect(runtimeContent).toContain("**模型**  doubao-seed-2-1-turbo-260628");
    expect(runtimeContent).toContain(
      "**提供方**  火山引擎 (volcengine)  ·  **模式**  推理 medium（默认）",
    );
    expect(runtimeContent).toContain("**本轮用量**  输入 57,370 · 输出 22");
    expect(runtimeContent).toContain(
      "**上下文**  57,370 / 256,000 · 22.4%  ·  **费用**  $0.0254",
    );
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
    expect(card.elements).toHaveLength(3);
    const cardKit = builder.toCardKit2(card);
    expect(cardKit).toMatchObject({
      config: { width_mode: "fill", update_multi: true },
      body: {
        direction: "vertical",
        vertical_spacing: "12px",
        padding: "14px 16px 16px 16px",
      },
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
