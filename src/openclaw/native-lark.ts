import {
  cpSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { resolveThinkingDefault } from "openclaw/plugin-sdk/agent-runtime";

import type { CardFooterConfig } from "../core/index.js";

interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
}

interface LlmOutputEvent {
  runId: string;
  provider: string;
  model: string;
  resolvedRef?: string;
  contextTokenBudget?: number;
  reasoningEffort?: string;
  reasoningEffortDefault?: boolean;
  fastMode?: boolean;
  lastAssistant?: unknown;
  usage?: TokenUsage;
}

interface ModelCallEndedEvent {
  runId: string;
  timeToFirstByteMs?: number;
}

interface AgentEndEvent {
  runId?: string;
  durationMs?: number;
}

interface AgentHookContext {
  runId?: string;
  sessionKey?: string;
  messageProvider?: string;
  channel?: string;
  channelId?: string;
  contextTokenBudget?: number;
}

export interface NativeLarkMetrics {
  runId: string;
  sessionKey: string;
  provider?: string | undefined;
  model?: string | undefined;
  resolvedRef?: string | undefined;
  reasoningEffort?: string | undefined;
  reasoningEffortDefault?: boolean | undefined;
  fastMode?: boolean | undefined;
  contextTokenBudget?: number | undefined;
  contextUsedTokens?: number | undefined;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  lastInputTokens?: number | undefined;
  lastOutputTokens?: number | undefined;
  lastCacheReadTokens?: number | undefined;
  lastCacheWriteTokens?: number | undefined;
  lastTotalTokens?: number | undefined;
  turnCostUsd?: number | undefined;
  firstTokenMs?: number | undefined;
  durationMs?: number | undefined;
  updatedAt: number;
}

interface NativeFooterMetrics {
  inputTokens?: number | undefined;
  outputTokens?: number | undefined;
  cacheRead?: number | undefined;
  cacheWrite?: number | undefined;
  totalTokens?: number | undefined;
  totalTokensFresh?: boolean | undefined;
  contextTokens?: number | undefined;
  model?: string | undefined;
  __openclawHermesFeishuCard?: true;
  provider?: string | undefined;
  resolvedRef?: string | undefined;
  reasoningEffort?: string | undefined;
  reasoningEffortDefault?: boolean | undefined;
  fastMode?: boolean | undefined;
  contextUsedTokens?: number | undefined;
  turnCostUsd?: number | undefined;
  firstTokenMs?: number | undefined;
  durationMs?: number | undefined;
  accountId?: string | undefined;
}

type UnknownRecord = Record<string, unknown>;

interface NativeCardData extends UnknownRecord {
  elapsedMs?: number | undefined;
  isError?: boolean | undefined;
  isAborted?: boolean | undefined;
  footer?: UnknownRecord | undefined;
  footerMetrics?: NativeFooterMetrics | undefined;
}

interface NativeBuilderModule extends UnknownRecord {
  buildCardContent: (
    state: string,
    data?: NativeCardData,
  ) => Record<string, unknown>;
  toCardKit2?: (card: Record<string, unknown>) => Record<string, unknown>;
}

interface NativeControllerModule extends UnknownRecord {
  StreamingCardController: {
    prototype: {
      getFooterSessionMetrics: () => Promise<unknown>;
    };
  };
}

interface NativePatchState {
  registry: NativeLarkMetricsRegistry;
  config: CardFooterConfig;
  logInfo?: ((message: string) => void) | undefined;
}

interface OfficialPluginDefinition {
  register?: (api: OpenClawPluginApi) => void;
}

const require = createRequire(import.meta.url);
const PATCH_STATE = Symbol.for(
  "openclaw-hermes-feishu-card.native-lark-patch-state",
);
const PATCHED_CONTROLLER = Symbol.for(
  "openclaw-hermes-feishu-card.native-lark-controller-patched",
);
const PATCHED_CARDKIT = Symbol.for(
  "openclaw-hermes-feishu-card.native-lark-cardkit-patched",
);
const TEN_MINUTES_MS = 10 * 60 * 1_000;

interface NativeMetricsGlobal {
  __openclawHermesFeishuCardNativeMetrics?: NativeLarkMetricsRegistry;
}

function record(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as UnknownRecord)
    : {};
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(0, value)
    : undefined;
}

function add(left: number, right: number | undefined): number {
  return left + (right ?? 0);
}

function normalizeSessionKey(value: string | undefined): string | undefined {
  const key = value?.trim().toLowerCase();
  return key || undefined;
}

function isFeishuContext(ctx: AgentHookContext): boolean {
  const provider = (ctx.messageProvider ?? ctx.channel ?? "").toLowerCase();
  const sessionKey = normalizeSessionKey(ctx.sessionKey) ?? "";
  return (
    provider === "feishu" ||
    provider === "openclaw-lark" ||
    sessionKey.includes(":feishu:") ||
    sessionKey.includes(":openclaw-lark:")
  );
}

function extractAssistantCost(value: unknown, depth = 0): number | undefined {
  if (depth > 3) {
    return undefined;
  }
  const source = record(value);
  const usage = record(source.usage);
  const cost = record(usage.cost);
  const total = finite(cost.total);
  if (total !== undefined) {
    return total;
  }
  for (const key of ["message", "lastAssistant", "assistant"]) {
    const nested = extractAssistantCost(source[key], depth + 1);
    if (nested !== undefined) {
      return nested;
    }
  }
  return undefined;
}

function lastContextUsage(usage: TokenUsage | undefined): number | undefined {
  if (!usage) {
    return undefined;
  }
  const input = finite(usage.input);
  const cacheRead = finite(usage.cacheRead);
  const cacheWrite = finite(usage.cacheWrite);
  if (
    input === undefined &&
    cacheRead === undefined &&
    cacheWrite === undefined
  ) {
    return undefined;
  }
  return (input ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0);
}

export class NativeLarkMetricsRegistry {
  private readonly entries = new Map<string, NativeLarkMetrics>();

  capture(event: LlmOutputEvent, ctx: AgentHookContext): void {
    if (!isFeishuContext(ctx)) {
      return;
    }
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey) {
      return;
    }
    this.prune();
    const previous = this.entries.get(sessionKey);
    const current =
      previous?.runId === event.runId
        ? previous
        : {
            runId: event.runId,
            sessionKey,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            updatedAt: Date.now(),
          };
    const usage = event.usage;
    const input = finite(usage?.input);
    const output = finite(usage?.output);
    const cacheRead = finite(usage?.cacheRead);
    const cacheWrite = finite(usage?.cacheWrite);
    const total = finite(usage?.total);
    current.inputTokens = add(current.inputTokens, input);
    current.outputTokens = add(current.outputTokens, output);
    current.cacheReadTokens = add(current.cacheReadTokens, cacheRead);
    current.cacheWriteTokens = add(current.cacheWriteTokens, cacheWrite);
    current.totalTokens = add(
      current.totalTokens,
      total ??
        (input ?? 0) + (output ?? 0) + (cacheRead ?? 0) + (cacheWrite ?? 0),
    );
    current.lastInputTokens = input;
    current.lastOutputTokens = output;
    current.lastCacheReadTokens = cacheRead;
    current.lastCacheWriteTokens = cacheWrite;
    current.lastTotalTokens = total;
    current.contextUsedTokens = lastContextUsage(usage);
    current.contextTokenBudget =
      finite(event.contextTokenBudget) ??
      finite(ctx.contextTokenBudget) ??
      current.contextTokenBudget;
    current.provider = event.provider || current.provider;
    current.model = event.model || current.model;
    current.resolvedRef = event.resolvedRef ?? current.resolvedRef;
    current.reasoningEffort = event.reasoningEffort ?? current.reasoningEffort;
    current.reasoningEffortDefault =
      event.reasoningEffortDefault ?? current.reasoningEffortDefault;
    current.fastMode = event.fastMode ?? current.fastMode;
    const cost = extractAssistantCost(event.lastAssistant);
    if (cost !== undefined) {
      current.turnCostUsd = (current.turnCostUsd ?? 0) + cost;
    }
    current.updatedAt = Date.now();
    this.entries.set(sessionKey, current);
  }

  captureModelCallEnded(
    event: ModelCallEndedEvent,
    ctx: AgentHookContext,
  ): void {
    if (!isFeishuContext(ctx)) {
      return;
    }
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey) {
      return;
    }
    const timeToFirstByteMs = finite(event.timeToFirstByteMs);
    if (timeToFirstByteMs === undefined) {
      return;
    }
    this.prune();
    const previous = this.entries.get(sessionKey);
    const current =
      previous?.runId === event.runId
        ? previous
        : {
            runId: event.runId,
            sessionKey,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            totalTokens: 0,
            updatedAt: Date.now(),
          };
    current.firstTokenMs ??= timeToFirstByteMs;
    current.updatedAt = Date.now();
    this.entries.set(sessionKey, current);
  }

  finish(event: AgentEndEvent, ctx: AgentHookContext): void {
    const sessionKey = normalizeSessionKey(ctx.sessionKey);
    if (!sessionKey) {
      return;
    }
    const entry = this.entries.get(sessionKey);
    if (!entry || (event.runId && entry.runId !== event.runId)) {
      return;
    }
    const durationMs = finite(event.durationMs);
    if (durationMs !== undefined) {
      entry.durationMs = durationMs;
    }
    entry.updatedAt = Date.now();
  }

  get(sessionKey: string | undefined): NativeLarkMetrics | undefined {
    const key = normalizeSessionKey(sessionKey);
    return key ? this.entries.get(key) : undefined;
  }

  prune(maxAgeMs = TEN_MINUTES_MS): void {
    const oldest = Date.now() - maxAgeMs;
    for (const [key, entry] of this.entries) {
      if (entry.updatedAt < oldest) {
        this.entries.delete(key);
      }
    }
  }
}

function sharedNativeMetricsRegistry(): NativeLarkMetricsRegistry {
  const store = globalThis as unknown as NativeMetricsGlobal;
  store.__openclawHermesFeishuCardNativeMetrics ??=
    new NativeLarkMetricsRegistry();
  return store.__openclawHermesFeishuCardNativeMetrics;
}

function exactNumber(value: number): string {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(
    Math.max(0, value),
  );
}

function formatDuration(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) {
    return undefined;
  }
  if (value < 1_000) {
    return `${Math.round(value)}ms`;
  }
  if (value < 60_000) {
    return `${(value / 1_000).toFixed(1)}s`;
  }
  const minutes = Math.floor(value / 60_000);
  const seconds = Math.round((value % 60_000) / 1_000);
  return `${minutes}m ${seconds}s`;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  azure: "Azure OpenAI",
  dashscope: "阿里云百炼",
  deepseek: "DeepSeek",
  google: "Google",
  groq: "Groq",
  moonshot: "Moonshot",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  qwen: "阿里云百炼",
  siliconflow: "硅基流动",
  together: "Together AI",
  volcengine: "火山引擎",
  zhipu: "智谱 AI",
};

function providerLabel(provider: string | undefined): string | undefined {
  const id = provider?.trim();
  if (!id) {
    return undefined;
  }
  const brand = PROVIDER_LABELS[id.toLowerCase()];
  if (!brand || brand.toLowerCase() === id.toLowerCase()) {
    return brand ?? id;
  }
  return `${brand} (${id})`;
}

function footerElements(params: {
  data: NativeCardData;
  metrics?: NativeFooterMetrics | undefined;
  config: CardFooterConfig;
}): UnknownRecord[] {
  const { data, metrics, config } = params;
  if (!config.panels.footer) {
    return [];
  }
  const summary: string[] = [];
  if (config.footer.status) {
    summary.push(
      data.isError ? "执行异常" : data.isAborted ? "已停止" : "已完成",
    );
  }
  if (config.footer.elapsed) {
    const elapsed = formatDuration(data.elapsedMs ?? metrics?.durationMs);
    if (elapsed) {
      summary.push(`耗时 ${elapsed}`);
    }
  }
  if (config.footer.firstToken) {
    const firstToken = formatDuration(metrics?.firstTokenMs);
    if (firstToken) {
      summary.push(`首字节 ${firstToken}`);
    }
  }

  const rows: string[] = [];
  if (config.footer.model && metrics) {
    const provider = providerLabel(metrics.provider);
    if (metrics.model) {
      rows.push(`**模型**  ${metrics.model}`);
    }
    const mode: string[] = [];
    if (metrics.reasoningEffort) {
      mode.push(
        `推理 ${metrics.reasoningEffort}${metrics.reasoningEffortDefault ? "（默认）" : ""}`,
      );
    }
    if (metrics.fastMode === true) {
      mode.push("快速模式");
    }
    const providerAndMode = [
      provider ? `**提供方**  ${provider}` : undefined,
      mode.length > 0 ? `**模式**  ${mode.join(" · ")}` : undefined,
    ].filter(Boolean);
    if (providerAndMode.length > 0) {
      rows.push(providerAndMode.join("  ·  "));
    }
  }

  const usage: string[] = [];
  if (
    config.footer.tokens &&
    metrics?.inputTokens !== undefined &&
    metrics.outputTokens !== undefined
  ) {
    usage.push(
      `输入 ${exactNumber(metrics.inputTokens)} · 输出 ${exactNumber(metrics.outputTokens)}`,
    );
  }
  if (
    config.footer.cache &&
    metrics &&
    ((metrics.cacheRead ?? 0) > 0 || (metrics.cacheWrite ?? 0) > 0)
  ) {
    usage.push(
      `缓存读 ${exactNumber(metrics.cacheRead ?? 0)} · 缓存写 ${exactNumber(metrics.cacheWrite ?? 0)}`,
    );
  }
  if (usage.length > 0) {
    rows.push(`**本轮用量**  ${usage.join("  ·  ")}`);
  }
  if (
    config.footer.context &&
    metrics?.contextUsedTokens !== undefined &&
    metrics.contextTokens !== undefined &&
    metrics.contextTokens > 0
  ) {
    const percent = Math.min(
      999,
      (metrics.contextUsedTokens / metrics.contextTokens) * 100,
    );
    const cost =
      config.footer.cost &&
      metrics.turnCostUsd !== undefined &&
      metrics.turnCostUsd > 0
        ? `  ·  **费用**  $${metrics.turnCostUsd.toFixed(4)}`
        : "";
    rows.push(
      `**上下文**  ${exactNumber(metrics.contextUsedTokens)} / ${exactNumber(metrics.contextTokens)} · ${percent.toFixed(1)}%${cost}`,
    );
  } else if (
    config.footer.cost &&
    metrics?.turnCostUsd !== undefined &&
    metrics.turnCostUsd > 0
  ) {
    rows.push(`**费用**  $${metrics.turnCostUsd.toFixed(4)}`);
  }

  if (summary.length === 0 && rows.length === 0) {
    return [];
  }
  const title = `📊 运行详情${summary.length > 0 ? ` · ${summary.join(" · ")}` : ""}`;
  const content = rows.join("\n");
  return [
    { tag: "hr", margin: "6px 0px 2px 0px" },
    {
      tag: "collapsible_panel",
      expanded: true,
      margin: "2px 0px 0px 0px",
      header: {
        title: {
          tag: "plain_text",
          content: title,
          i18n_content: { zh_cn: title, en_us: title },
        },
        background_color: "grey",
        vertical_align: "center",
        padding: "8px 12px 8px 12px",
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          color: "grey",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      border: { color: "grey", corner_radius: "8px" },
      vertical_spacing: "6px",
      padding: "10px 12px 10px 12px",
      elements:
        content.length > 0
          ? [
              {
                tag: "markdown",
                content,
                i18n_content: { zh_cn: content, en_us: content },
                text_size: "notation",
              },
            ]
          : [],
    },
  ];
}

export function enrichNativeLarkCard(params: {
  card: Record<string, unknown>;
  data: NativeCardData;
  config: CardFooterConfig;
}): Record<string, unknown> {
  const { card, data, config } = params;
  const rawElements: unknown = card.elements;
  const elements: unknown[] = Array.isArray(rawElements)
    ? rawElements.map((element: unknown) => element)
    : [];
  const footer = footerElements({
    data,
    metrics: data.footerMetrics,
    config,
  });
  // The official complete-card builder renders the execution accordion before
  // the answer. Move the final top-level markdown answer to the front so the
  // result is visually primary and logs remain contextual detail.
  const answerIndex = elements.findLastIndex(
    (element) => record(element).tag === "markdown",
  );
  if (answerIndex > 0) {
    const [answer] = elements.splice(answerIndex, 1);
    if (answer) {
      elements.unshift(answer);
    }
  }
  elements.push(...footer);
  const accountId = data.footerMetrics?.accountId;
  const title =
    (accountId ? config.accountTitles[accountId] : undefined) ?? config.title;
  const status = data.isError
    ? "执行异常"
    : data.isAborted
      ? "已停止"
      : "已完成";
  const color = data.isError ? "red" : data.isAborted ? "neutral" : "green";
  const toolCount = Array.isArray(data.toolUseSteps)
    ? data.toolUseSteps.length
    : 0;
  const tags: UnknownRecord[] = [
    {
      tag: "text_tag",
      text: { tag: "plain_text", content: status },
      color,
    },
  ];
  if (toolCount > 0) {
    tags.push({
      tag: "text_tag",
      text: { tag: "plain_text", content: `${toolCount} 步` },
      color: "neutral",
    });
  }
  return {
    ...card,
    header: {
      template: data.isError ? "red" : data.isAborted ? "grey" : "green",
      padding: "12px 16px 12px 16px",
      title: { tag: "plain_text", content: title },
      subtitle: { tag: "plain_text", content: "智能任务卡片" },
      text_tag_list: tags,
    },
    elements,
  };
}

function asFooterMetrics(
  entry: NativeLarkMetrics,
  accountId?: string,
): NativeFooterMetrics {
  return {
    __openclawHermesFeishuCard: true,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheRead: entry.cacheReadTokens,
    cacheWrite: entry.cacheWriteTokens,
    totalTokens: entry.contextUsedTokens,
    totalTokensFresh: entry.contextUsedTokens !== undefined,
    contextTokens: entry.contextTokenBudget,
    model: entry.model,
    provider: entry.provider,
    resolvedRef: entry.resolvedRef,
    reasoningEffort: entry.reasoningEffort,
    reasoningEffortDefault: entry.reasoningEffortDefault,
    fastMode: entry.fastMode,
    contextUsedTokens: entry.contextUsedTokens,
    turnCostUsd: entry.turnCostUsd,
    firstTokenMs: entry.firstTokenMs,
    durationMs: entry.durationMs,
    accountId,
  };
}

function packageRoot(entry: string): string {
  let current = path.dirname(entry);
  for (let depth = 0; depth < 5; depth += 1) {
    try {
      const manifest = JSON.parse(
        readFileSync(path.join(current, "package.json"), "utf8"),
      ) as { name?: string };
      if (manifest.name === "@larksuite/openclaw-lark") {
        return current;
      }
    } catch {
      // Continue walking toward the package root.
    }
    current = path.dirname(current);
  }
  throw new Error(`@larksuite/openclaw-lark root not found from ${entry}`);
}

function prepareOfficialCommonJsShadow(root: string): string {
  const manifest = JSON.parse(
    readFileSync(path.join(root, "package.json"), "utf8"),
  ) as UnknownRecord & { version?: string };
  const version = String(manifest.version ?? "unknown");
  const shadow = path.join(root, `.openclaw-hermes-feishu-card-cjs-${version}`);
  const marker = path.join(shadow, ".ready");
  try {
    if (readFileSync(marker, "utf8") === version) {
      return shadow;
    }
  } catch {
    // Prepare or repair the private compatibility copy below.
  }

  rmSync(shadow, { recursive: true, force: true });
  mkdirSync(shadow, { recursive: true, mode: 0o700 });
  cpSync(path.join(root, "index.js"), path.join(shadow, "index.js"));
  cpSync(path.join(root, "src"), path.join(shadow, "src"), {
    recursive: true,
  });
  writeFileSync(
    path.join(shadow, "package.json"),
    `${JSON.stringify({ ...manifest, type: "commonjs" }, null, 2)}\n`,
  );

  const tokenStorePath = path.join(shadow, "src", "core", "token-store.js");
  const tokenStore = readFileSync(tokenStorePath, "utf8")
    .replace(
      "// CJS (tsc output) has __filename; ESM (tsdown output) has import.meta.url.\n",
      "",
    )
    .replace(
      "const _require = (0, node_module_1.createRequire)(typeof __filename !== 'undefined' ? __filename : import.meta.url);",
      "const _require = (0, node_module_1.createRequire)(__filename);",
    );
  const versionPath = path.join(shadow, "src", "core", "version.js");
  const versionSource = readFileSync(versionPath, "utf8")
    .replace(/^\s*const __filename = .*import\.meta\.url\);\r?\n/m, "")
    .replace(/^\s*const __dirname = .*__filename\);\r?\n/m, "");
  if (
    tokenStore.includes("import.meta") ||
    versionSource.includes("import.meta")
  ) {
    rmSync(shadow, { recursive: true, force: true });
    throw new Error(
      `unsupported @larksuite/openclaw-lark ${version} CommonJS source format`,
    );
  }
  writeFileSync(tokenStorePath, tokenStore);
  writeFileSync(versionPath, versionSource);
  writeFileSync(marker, version);
  return shadow;
}

function loadOfficialSourceModules(root: string): {
  builder: NativeBuilderModule;
  controller: NativeControllerModule;
  official: OfficialPluginDefinition;
} {
  const builder = require(
    path.join(root, "src", "card", "builder.js"),
  ) as NativeBuilderModule;
  const controller = require(
    path.join(root, "src", "card", "streaming-card-controller.js"),
  ) as NativeControllerModule;
  const officialModule = require(path.join(root, "index.js")) as {
    default?: OfficialPluginDefinition;
  } & OfficialPluginDefinition;
  return {
    builder,
    controller,
    official: officialModule.default ?? officialModule,
  };
}

export function createOfficialPluginApi(
  api: OpenClawPluginApi,
): OpenClawPluginApi {
  const runtime = record(api.runtime);
  const runtimeConfig = record(runtime.config);
  if (typeof runtimeConfig.loadConfig === "function") {
    return api;
  }
  const current = runtimeConfig.current;
  if (typeof current !== "function") {
    throw new Error(
      "OpenClaw runtime config exposes neither loadConfig() nor current()",
    );
  }
  const currentConfig = current as (this: UnknownRecord) => unknown;
  const compatibleConfig: UnknownRecord = {
    ...runtimeConfig,
    loadConfig: () => currentConfig.call(runtimeConfig),
  };
  const compatibleRuntime: UnknownRecord = {
    ...runtime,
    config: compatibleConfig,
  };
  return { ...api, runtime: compatibleRuntime } as unknown as OpenClawPluginApi;
}

export function patchNativeLarkModules(params: {
  builder: NativeBuilderModule;
  controller: NativeControllerModule;
  registry: NativeLarkMetricsRegistry;
  config: CardFooterConfig;
  logInfo?: ((message: string) => void) | undefined;
}): void {
  const { builder, controller, registry, config, logInfo } = params;
  const builderState = builder as NativeBuilderModule & {
    [PATCH_STATE]?: NativePatchState;
  };
  const existingState = builderState[PATCH_STATE];
  if (existingState) {
    existingState.registry = registry;
    existingState.config = config;
    existingState.logInfo = logInfo;
  } else {
    const state: NativePatchState = { registry, config, logInfo };
    const originalBuild = builder.buildCardContent.bind(builder);
    builder.buildCardContent = (cardState, rawData = {}) => {
      if (cardState !== "complete") {
        return originalBuild(cardState, rawData);
      }
      const data: NativeCardData = {
        ...rawData,
        footer: {
          status: false,
          elapsed: false,
          tokens: false,
          cache: false,
          context: false,
          model: false,
        },
      };
      const card = originalBuild(cardState, data);
      return enrichNativeLarkCard({
        card,
        data: rawData,
        config: state.config,
      });
    };
    builderState[PATCH_STATE] = state;
  }

  const cardKitBuilder = builder as NativeBuilderModule & {
    [PATCHED_CARDKIT]?: boolean;
  };
  if (!cardKitBuilder[PATCHED_CARDKIT] && builder.toCardKit2) {
    const originalToCardKit2 = builder.toCardKit2.bind(builder);
    builder.toCardKit2 = (card) => {
      const result = originalToCardKit2(card);
      return {
        ...result,
        config: {
          ...record(result.config),
          width_mode: "fill",
          update_multi: true,
          locales: ["zh_cn", "en_us"],
        },
        body: {
          ...record(result.body),
          direction: "vertical",
          vertical_spacing: "12px",
          padding: "14px 16px 16px 16px",
        },
      };
    };
    cardKitBuilder[PATCHED_CARDKIT] = true;
  }

  const prototype = controller.StreamingCardController
    .prototype as typeof controller.StreamingCardController.prototype & {
    [PATCHED_CONTROLLER]?: boolean;
    deps?: { sessionKey?: string; accountId?: string };
  };
  if (!prototype[PATCHED_CONTROLLER]) {
    const originalGet = prototype.getFooterSessionMetrics;
    prototype.getFooterSessionMetrics = async function getFooterMetrics() {
      const state = builderState[PATCH_STATE];
      const entry = state?.registry.get(this.deps?.sessionKey);
      if (entry) {
        state?.logInfo?.(
          `[openclaw-hermes-feishu-card] native metrics applied provider=${entry.provider ?? "-"} model=${entry.model ?? "-"} input=${entry.inputTokens} output=${entry.outputTokens} context=${entry.contextUsedTokens ?? "-"}/${entry.contextTokenBudget ?? "-"}`,
        );
        return asFooterMetrics(entry, this.deps?.accountId);
      }
      return originalGet.call(this);
    };
    prototype[PATCHED_CONTROLLER] = true;
  }
}

function externalLarkEnabled(config: unknown): boolean {
  const entries = record(record(config).plugins).entries;
  const entry = record(record(entries)["openclaw-lark"]);
  return entry.enabled === true;
}

function configuredThinkingEffort(
  api: OpenClawPluginApi,
  event: LlmOutputEvent,
): string | undefined {
  try {
    const runtimeConfig = record(record(api.runtime).config);
    const loader =
      typeof runtimeConfig.loadConfig === "function"
        ? runtimeConfig.loadConfig
        : runtimeConfig.current;
    if (typeof loader !== "function") {
      return undefined;
    }
    const cfg = loader.call(runtimeConfig) as Parameters<
      typeof resolveThinkingDefault
    >[0]["cfg"];
    return resolveThinkingDefault({
      cfg,
      provider: event.provider,
      model: event.model,
    });
  } catch {
    return undefined;
  }
}

export class NativeLarkIntegration {
  readonly registry = sharedNativeMetricsRegistry();

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly config: CardFooterConfig,
  ) {}

  register(): void {
    this.api.on("llm_output", (event, ctx) => {
      const reasoningEffort =
        event.reasoningEffort ?? configuredThinkingEffort(this.api, event);
      this.registry.capture(
        {
          ...event,
          ...(reasoningEffort ? { reasoningEffort } : {}),
          ...(!event.reasoningEffort && reasoningEffort
            ? { reasoningEffortDefault: true }
            : {}),
        },
        ctx,
      );
      const entry = this.registry.get(ctx.sessionKey);
      if (entry?.runId === event.runId) {
        this.api.logger.info(
          `[openclaw-hermes-feishu-card] native metrics captured provider=${entry.provider ?? "-"} model=${entry.model ?? "-"} reasoning=${entry.reasoningEffort ?? "-"}${entry.reasoningEffortDefault ? "(default)" : ""} input=${entry.inputTokens} output=${entry.outputTokens} context=${entry.contextUsedTokens ?? "-"}/${entry.contextTokenBudget ?? "-"}`,
        );
      }
    });
    this.api.on("model_call_ended", (event, ctx) => {
      this.registry.captureModelCallEnded(event, ctx);
    });
    this.api.on("agent_end", (event, ctx) => {
      this.registry.finish(event, ctx);
    });

    if (!this.config.embeddedLark) {
      this.api.logger.info(
        "[openclaw-hermes-feishu-card] embedded Feishu channel disabled; routed payload bridge only",
      );
      return;
    }
    if (externalLarkEnabled(this.api.config)) {
      this.api.logger.warn(
        "[openclaw-hermes-feishu-card] external openclaw-lark is enabled; disable that entry so the integrated native-card channel can own Feishu delivery",
      );
      return;
    }
    try {
      const root = packageRoot(
        fileURLToPath(import.meta.resolve("@larksuite/openclaw-lark")),
      );
      const sourceRoot = prepareOfficialCommonJsShadow(root);
      const officialSource = loadOfficialSourceModules(sourceRoot);
      patchNativeLarkModules({
        builder: officialSource.builder,
        controller: officialSource.controller,
        registry: this.registry,
        config: this.config,
        logInfo: (message) => this.api.logger.info(message),
      });
      const official = officialSource.official;
      if (typeof official.register !== "function") {
        throw new Error("official plugin register() export is missing");
      }
      official.register(createOfficialPluginApi(this.api));
      const version = (
        JSON.parse(readFileSync(path.join(root, "package.json"), "utf8")) as {
          version?: string;
        }
      ).version;
      this.api.logger.info(
        `[openclaw-hermes-feishu-card] integrated @larksuite/openclaw-lark ${version ?? "unknown"}; native streaming cards enriched`,
      );
    } catch (error) {
      this.api.logger.error(
        `[openclaw-hermes-feishu-card] integrated Feishu channel startup failed: ${String(error)}`,
      );
      throw error;
    }
  }
}
