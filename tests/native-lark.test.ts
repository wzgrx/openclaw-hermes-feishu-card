import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { resolveConfig } from "../src/core/config.js";
import {
  createOfficialPluginApi,
  NativeLarkIntegration,
  NativeLarkMetricsRegistry,
  patchNativeLarkModules,
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

  it("changes only the channel metric source and leaves builder data untouched", async () => {
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
    const originalBuild = (_state: string, data?: Record<string, unknown>) => {
      originalData = data;
      return { elements: [{ tag: "markdown", content: "answer" }] };
    };
    const builder = { buildCardContent: originalBuild };
    class Controller {
      deps = { sessionKey: ctx.sessionKey, accountId: "default" };
      getFooterSessionMetrics(): Promise<unknown> {
        return Promise.resolve({ model: "stale-store-model" });
      }
    }
    patchNativeLarkModules({
      builder,
      controller: { StreamingCardController: Controller },
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

    const data = {
      elapsedMs: 1_500,
      footer: { status: true, model: true },
      footerMetrics: metrics,
    };
    expect(builder.buildCardContent).toBe(originalBuild);
    expect(builder.buildCardContent("complete", data)).toEqual({
      elements: [{ tag: "markdown", content: "answer" }],
    });
    expect(originalData).toBe(data);
  });

  it("matches the exact visual contract from the pre-migration installed builder", () => {
    const require = createRequire(import.meta.url);
    const entry = fileURLToPath(
      import.meta.resolve("@larksuite/openclaw-lark"),
    );
    const root = path.dirname(path.dirname(entry));
    const builderPath = path.join(root, "src", "card", "builder.js");
    const builder = require(builderPath) as unknown as {
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
    const originalBuild = builder.buildCardContent;
    const originalThinking = builder.buildStreamingThinkingCard;
    const originalPreAnswer = builder.buildStreamingPreAnswerCard;
    class Controller {
      getFooterSessionMetrics(): Promise<unknown> {
        return Promise.resolve(undefined);
      }
    }
    patchNativeLarkModules({
      builder,
      controller: { StreamingCardController: Controller },
      registry: new NativeLarkMetricsRegistry(),
      config: resolveConfig({}),
    });

    expect(builder.buildCardContent).toBe(originalBuild);
    expect(builder.buildStreamingThinkingCard).toBe(originalThinking);
    expect(builder.buildStreamingPreAnswerCard).toBe(originalPreAnswer);

    const step = {
      title: "终端",
      detail: "echo ok",
      iconToken: "terminal_outlined",
      status: "success",
    };
    const footer = {
      status: true,
      elapsed: true,
      model: true,
      tokens: true,
      cache: true,
      context: true,
    };
    const complete = builder.toCardKit2(
      builder.buildCardContent("complete", {
        text: "官方通道最终答案",
        elapsedMs: 61_000,
        reasoningText: "先分析再执行",
        reasoningElapsedMs: 2_500,
        showToolUse: true,
        toolUseSteps: [step],
        toolUseElapsedMs: 2_000,
        footer,
        footerMetrics: {
          model: "gpt-5.4-mini",
          inputTokens: 86_000,
          outputTokens: 303,
          cacheRead: 20_000,
          cacheWrite: 1_000,
          totalTokens: 86_000,
          totalTokensFresh: true,
          contextTokens: 272_000,
        },
      }),
    );
    const running = builder.buildStreamingPreAnswerCard({
      steps: [step],
      elapsedMs: 2_000,
      showToolUse: true,
    });
    const thinking = builder.buildStreamingThinkingCard(true);
    const withoutPanels = builder.toCardKit2(
      builder.buildCardContent("complete", {
        text: "无工具答案",
        elapsedMs: 1_000,
        showToolUse: false,
        toolUseSteps: [],
        footer,
        footerMetrics: {
          model: "gpt-5.4-mini",
          inputTokens: 10,
          outputTokens: 2,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 10,
          totalTokensFresh: true,
          contextTokens: 1_000,
        },
      }),
    );

    const fixturePath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "fixtures",
      "legacy-card-visual-contract.json",
    );
    const contract = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      source: { sha256: string };
      thinking: unknown;
      toolRunning: unknown;
      completed: unknown;
      completedWithoutPanels: unknown;
    };
    expect(
      createHash("sha256").update(readFileSync(builderPath)).digest("hex"),
    ).toBe(contract.source.sha256);
    expect(projectVisualContract(thinking)).toEqual(contract.thinking);
    expect(projectVisualContract(running)).toEqual(contract.toolRunning);
    expect(projectVisualContract(complete)).toEqual(contract.completed);
    expect(projectVisualContract(withoutPanels)).toEqual(
      contract.completedWithoutPanels,
    );
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

function localizedContent(value: unknown): string | undefined {
  const element = recordElement(value);
  const i18n = recordElement(element.i18n_content);
  const content = i18n.zh_cn ?? element.content;
  return typeof content === "string" ? content : undefined;
}

function elementRole(element: Record<string, unknown>): string {
  if (element.element_id === "streaming_content") return "streaming";
  if (element.element_id === "loading_icon") return "loading";
  if (element.tag === "collapsible_panel") {
    const title = recordElement(recordElement(element.header).title);
    return localizedContent(title)?.startsWith("🛠️") ? "tools" : "reasoning";
  }
  if (element.text_size === "notation" && element.i18n_content) return "footer";
  return "answer";
}

function projectVisualContract(card: Record<string, unknown>): unknown {
  const body = recordElement(card.body);
  const elements = (Array.isArray(body.elements) ? body.elements : []).map(
    recordElement,
  );
  const tools = elements.find((element) => elementRole(element) === "tools");
  const reasoning = elements.find(
    (element) => elementRole(element) === "reasoning",
  );
  const answer = elements.find((element) => elementRole(element) === "answer");
  const footer = elements.find((element) => elementRole(element) === "footer");
  return {
    hasHeader: Object.keys(recordElement(card.header)).length > 0,
    elementRoles: elements.map(elementRole),
    ...(tools
      ? {
          toolsExpanded: tools.expanded,
          toolsTitle: localizedContent(
            recordElement(recordElement(tools.header).title),
          ),
          toolsBorder: recordElement(tools.border),
        }
      : {}),
    ...(reasoning
      ? {
          reasoningExpanded: reasoning.expanded,
          reasoningTitle: localizedContent(
            recordElement(recordElement(reasoning.header).title),
          ),
        }
      : {}),
    ...(answer ? { answer: localizedContent(answer) } : {}),
    ...(footer ? { footer: localizedContent(footer) } : {}),
  };
}
