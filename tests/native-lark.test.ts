import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

  it("keeps the legacy visual contract across thinking and tool-running states", () => {
    const pendingPanel = {
      tag: "collapsible_panel",
      expanded: true,
      elements: [],
    };
    const streamingElement = {
      tag: "markdown",
      element_id: "streaming_content",
      content: "",
    };
    const loadingElement = {
      tag: "markdown",
      element_id: "loading_icon",
      content: " ",
    };
    const builder = {
      buildCardContent: (_state: string, data?: Record<string, unknown>) => ({
        config: { wide_screen_mode: true },
        elements: [
          pendingPanel,
          { tag: "markdown", content: data?.text ?? "" },
        ],
      }),
      buildStreamingThinkingCard: (showToolUse?: boolean) => {
        void showToolUse;
        return {
          schema: "2.0",
          config: { streaming_mode: true },
          body: {
            elements: [pendingPanel, streamingElement, loadingElement],
          },
        };
      },
      buildStreamingPreAnswerCard: (params: {
        steps?: unknown[] | undefined;
        elapsedMs?: number | undefined;
        showToolUse?: boolean | undefined;
      }) => ({
        schema: "2.0",
        config: { streaming_mode: true },
        body: {
          elements: [
            {
              ...pendingPanel,
              elements: params.steps?.map(() => ({
                tag: "markdown",
                content: "执行步骤",
              })),
            },
            streamingElement,
            loadingElement,
          ],
        },
      }),
    };
    class Controller {
      getFooterSessionMetrics(): Promise<unknown> {
        return Promise.resolve(undefined);
      }
    }
    patchNativeLarkModules({
      builder,
      controller: { StreamingCardController: Controller },
      registry: new NativeLarkMetricsRegistry(),
      config: resolveConfig({ title: "OpenClaw" }),
    });

    const thinking = builder.buildStreamingThinkingCard(true) as unknown as {
      header: Record<string, unknown>;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(thinking.header).toEqual({
      template: "indigo",
      title: { tag: "plain_text", content: "OpenClaw" },
    });
    const thinkingElements = thinking.body.elements;
    expect(thinkingElements.map((element) => element.element_id)).toEqual([
      "streaming_content",
      "auxiliary_timeline",
      "main_divider",
      "footer",
    ]);
    expect(thinkingElements[1]).toMatchObject({
      expanded: false,
      header: {
        title: { content: "思考与工具 · 0 次工具调用" },
      },
      elements: [
        {
          content: '<font color="grey">等待工具事件…</font>',
          text_size: "x-small",
        },
      ],
    });
    expect(thinkingElements.at(-1)).toMatchObject({
      content: "⠋ 生成中",
      text_size: "x-small",
    });

    const running = builder.buildStreamingPreAnswerCard({
      steps: [{ title: "终端", status: "running" }],
    }) as unknown as {
      header: Record<string, unknown>;
      body: { elements: Array<Record<string, unknown>> };
    };
    expect(running.header).toMatchObject({
      template: "blue",
      subtitle: { content: "正在执行：终端" },
    });
    const runningElements = running.body.elements;
    expect(runningElements[1]).toMatchObject({
      element_id: "auxiliary_timeline",
      expanded: false,
      header: {
        title: { content: "思考与工具 · 1 次工具调用" },
      },
      elements: [{ content: "执行步骤" }],
    });

    const fallback = builder.buildCardContent("streaming", {
      text: "流式回答",
      toolUseSteps: [{ title: "浏览器" }],
    }) as Record<string, unknown>;
    expect(fallback.header).toMatchObject({
      template: "blue",
      subtitle: { content: "正在执行：浏览器" },
    });
    expect(
      (fallback.elements as Array<Record<string, unknown>>)[0]?.content,
    ).toBe("流式回答");
  });

  it("preserves the legacy stopped-state header and footer", () => {
    const failed = enrichNativeLarkCard({
      card: { elements: [{ tag: "markdown", content: "执行失败" }] },
      data: { isError: true },
      config: resolveConfig({ title: "OpenClaw" }),
    });
    expect(failed.header).toEqual({
      template: "red",
      title: { tag: "plain_text", content: "OpenClaw" },
    });
    const failedElements = failed.elements as Array<Record<string, unknown>>;
    expect(failedElements.at(-1)).toMatchObject({
      content: "已停止",
      text_size: "x-small",
    });

    const aborted = enrichNativeLarkCard({
      card: { elements: [{ tag: "markdown", content: "任务终止" }] },
      data: { isAborted: true },
      config: resolveConfig({ title: "OpenClaw" }),
    });
    expect(aborted.header).toMatchObject({ template: "grey" });
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

  it("patches the pinned official channel builders with the same golden contract", () => {
    const require = createRequire(import.meta.url);
    const entry = fileURLToPath(
      import.meta.resolve("@larksuite/openclaw-lark"),
    );
    const root = path.dirname(path.dirname(entry));
    const builder = require(
      path.join(root, "src", "card", "builder.js"),
    ) as unknown as {
      buildCardContent: (
        state: string,
        data?: Record<string, unknown>,
      ) => Record<string, unknown>;
      buildStreamingThinkingCard: (
        showToolUse?: boolean,
      ) => Record<string, unknown>;
      buildStreamingPreAnswerCard: (params: {
        steps?: unknown[] | undefined;
        elapsedMs?: number | undefined;
        showToolUse?: boolean | undefined;
      }) => Record<string, unknown>;
      toCardKit2: (card: Record<string, unknown>) => Record<string, unknown>;
    };
    class Controller {
      getFooterSessionMetrics(): Promise<unknown> {
        return Promise.resolve(undefined);
      }
    }
    patchNativeLarkModules({
      builder,
      controller: { StreamingCardController: Controller },
      registry: new NativeLarkMetricsRegistry(),
      config: resolveConfig({ title: "OpenClaw" }),
    });

    const step = {
      title: "终端",
      detail: "echo ok",
      iconToken: "terminal_outlined",
      status: "success",
    };
    const complete = builder.buildCardContent("complete", {
      text: "官方通道最终答案",
      elapsedMs: 61_000,
      showToolUse: true,
      toolUseSteps: [step],
      footerMetrics: {
        model: "gpt-5.4-mini",
        inputTokens: 86_000,
        outputTokens: 303,
        contextUsedTokens: 86_000,
        contextTokens: 272_000,
      },
    });
    expect(complete).not.toHaveProperty("header");
    const completeElements = complete.elements as Array<
      Record<string, unknown>
    >;
    expect(completeElements.map((element) => element.element_id)).toEqual([
      undefined,
      "auxiliary_timeline",
      "main_divider",
      "footer",
    ]);
    expect(completeElements[1]).toMatchObject({
      header: {
        title: { content: "思考与工具 · 1 次工具调用" },
      },
    });
    expect(completeElements.at(-1)?.content).toBe(
      '已完成 · 1m1s · <font color="blue">gpt-5.4-mini</font> · ↑86k · ↓303 · ctx 86k/272k 32%',
    );
    const completeCardKit = builder.toCardKit2(complete);
    expect(completeCardKit).not.toHaveProperty("header");
    expect(completeCardKit).toMatchObject({
      schema: "2.0",
      body: { elements: completeElements },
    });

    const running = builder.buildStreamingPreAnswerCard({
      steps: [step],
      elapsedMs: 2_000,
      showToolUse: true,
    });
    expect(running.header).toMatchObject({
      template: "blue",
      subtitle: { content: "正在执行：终端" },
    });
    const runningBody = running.body as { elements: unknown[] };
    expect(recordElement(runningBody.elements[1])).toMatchObject({
      element_id: "auxiliary_timeline",
      header: {
        title: { content: "思考与工具 · 1 次工具调用" },
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

function recordElement(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
