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
  fastMode?: boolean;
  lastAssistant?: unknown;
  usage?: TokenUsage;
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
  fastMode?: boolean | undefined;
  contextUsedTokens?: number | undefined;
  turnCostUsd?: number | undefined;
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
const TEN_MINUTES_MS = 10 * 60 * 1_000;

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
    current.fastMode = event.fastMode ?? current.fastMode;
    const cost = extractAssistantCost(event.lastAssistant);
    if (cost !== undefined) {
      current.turnCostUsd = (current.turnCostUsd ?? 0) + cost;
    }
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

function footerElement(params: {
  data: NativeCardData;
  metrics?: NativeFooterMetrics | undefined;
  config: CardFooterConfig;
}): UnknownRecord | undefined {
  const { data, metrics, config } = params;
  if (!config.panels.footer) {
    return undefined;
  }
  const primary: string[] = [];
  if (config.footer.status) {
    primary.push(data.isError ? "出错" : data.isAborted ? "已停止" : "已完成");
  }
  if (config.footer.elapsed) {
    const elapsed = formatDuration(data.elapsedMs ?? metrics?.durationMs);
    if (elapsed) {
      primary.push(`耗时 ${elapsed}`);
    }
  }

  const model: string[] = [];
  if (config.footer.model && metrics) {
    const provider = providerLabel(metrics.provider);
    if (provider || metrics.model) {
      model.push(
        `模型 ${[provider, metrics.model].filter(Boolean).join(" · ")}`,
      );
    }
    if (metrics.reasoningEffort) {
      model.push(`推理 ${metrics.reasoningEffort}`);
    }
    if (metrics.fastMode === true) {
      model.push("快速模式");
    }
  }

  const detail: string[] = [];
  if (
    config.footer.tokens &&
    metrics?.inputTokens !== undefined &&
    metrics.outputTokens !== undefined
  ) {
    detail.push(
      `本轮 ↑ ${exactNumber(metrics.inputTokens)} ↓ ${exactNumber(metrics.outputTokens)}`,
    );
  }
  if (
    config.footer.cache &&
    metrics &&
    ((metrics.cacheRead ?? 0) > 0 || (metrics.cacheWrite ?? 0) > 0)
  ) {
    detail.push(
      `缓存 读 ${exactNumber(metrics.cacheRead ?? 0)} / 写 ${exactNumber(metrics.cacheWrite ?? 0)}`,
    );
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
    detail.push(
      `上下文 ${exactNumber(metrics.contextUsedTokens)} / ${exactNumber(metrics.contextTokens)} (${percent.toFixed(1)}%)`,
    );
  }
  if (
    config.footer.cost &&
    metrics?.turnCostUsd !== undefined &&
    metrics.turnCostUsd > 0
  ) {
    detail.push(`费用 $${metrics.turnCostUsd.toFixed(4)}`);
  }

  const lines = [
    primary.join(" · "),
    model.join(" · "),
    detail.join(" · "),
  ].filter(Boolean);
  if (lines.length === 0) {
    return undefined;
  }
  const content = lines.join("\n");
  return {
    tag: "markdown",
    content,
    i18n_content: { zh_cn: content, en_us: content },
    text_size: "notation",
  };
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
  const footer = footerElement({
    data,
    metrics: data.footerMetrics,
    config,
  });
  if (footer) {
    elements.push(footer);
  }
  const accountId = data.footerMetrics?.accountId;
  const title =
    (accountId ? config.accountTitles[accountId] : undefined) ?? config.title;
  const status = data.isError
    ? "执行异常"
    : data.isAborted
      ? "已停止"
      : "已完成";
  const color = data.isError ? "red" : data.isAborted ? "neutral" : "green";
  return {
    ...card,
    header: {
      template: data.isError ? "red" : data.isAborted ? "grey" : "green",
      title: { tag: "plain_text", content: title },
      text_tag_list: [
        {
          tag: "text_tag",
          text: { tag: "plain_text", content: status },
          color,
        },
      ],
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
    fastMode: entry.fastMode,
    contextUsedTokens: entry.contextUsedTokens,
    turnCostUsd: entry.turnCostUsd,
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

export function patchNativeLarkModules(params: {
  builder: NativeBuilderModule;
  controller: NativeControllerModule;
  registry: NativeLarkMetricsRegistry;
  config: CardFooterConfig;
}): void {
  const { builder, controller, registry, config } = params;
  const builderState = builder as NativeBuilderModule & {
    [PATCH_STATE]?: NativePatchState;
  };
  const existingState = builderState[PATCH_STATE];
  if (existingState) {
    existingState.registry = registry;
    existingState.config = config;
  } else {
    const state: NativePatchState = { registry, config };
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

export class NativeLarkIntegration {
  readonly registry = new NativeLarkMetricsRegistry();

  constructor(
    private readonly api: OpenClawPluginApi,
    private readonly config: CardFooterConfig,
  ) {}

  register(): void {
    this.api.on("llm_output", (event, ctx) => {
      this.registry.capture(event, ctx);
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
      });
      const official = officialSource.official;
      if (typeof official.register !== "function") {
        throw new Error("official plugin register() export is missing");
      }
      official.register(this.api);
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
