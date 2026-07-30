import type {
  PluginHookAfterToolCallEvent,
  PluginHookMessageContext,
  PluginHookMessageReceivedEvent,
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  PluginHookToolContext,
} from "openclaw/plugin-sdk/plugin-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk";

import {
  ResourceSampler,
  SessionRegistry,
  UsageLedger,
  applyPricing,
  renderCard,
  type CardFooterConfig,
  type SessionRoute,
  type UsageSnapshot,
} from "../core/index.js";
import { resolveFeishuCredentials } from "./credentials.js";
import { FeishuCardClient } from "./feishu-client.js";

type BeforeToolEvent = {
  toolName: string;
  params?: unknown;
  toolCallId?: string;
  runId?: string;
};

function keyFrom(params: {
  sessionKey?: string | undefined;
  runId?: string | undefined;
  conversationId?: string | undefined;
  fallback?: string | undefined;
}): string {
  return (
    params.runId ??
    params.sessionKey ??
    (params.conversationId
      ? `conversation:${params.conversationId}`
      : undefined) ??
    params.fallback ??
    "unknown"
  );
}

function normalizeRoute(
  ctx: PluginHookMessageContext,
  event?: PluginHookMessageReceivedEvent,
): SessionRoute {
  return {
    channelId: ctx.channelId,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(ctx.conversationId ? { conversationId: ctx.conversationId } : {}),
    ...((event?.messageId ?? ctx.messageId)
      ? { replyToId: event?.messageId ?? ctx.messageId }
      : {}),
    ...(event?.threadId ? { threadId: String(event.threadId) } : {}),
  };
}

function normalizeUsage(
  event: PluginHookReplyPayloadSendingEvent,
): UsageSnapshot | undefined {
  const state = event.usageState;
  if (!state) {
    return undefined;
  }
  const usage = state.usage;
  return {
    ...(state.provider ? { provider: state.provider } : {}),
    ...(state.model ? { model: state.model } : {}),
    ...(state.resolvedRef ? { resolvedRef: state.resolvedRef } : {}),
    ...(usage?.input !== undefined ? { inputTokens: usage.input } : {}),
    ...(usage?.output !== undefined ? { outputTokens: usage.output } : {}),
    ...(usage?.cacheRead !== undefined
      ? { cacheReadTokens: usage.cacheRead }
      : {}),
    ...(usage?.cacheWrite !== undefined
      ? { cacheWriteTokens: usage.cacheWrite }
      : {}),
    ...(usage?.total !== undefined ? { totalTokens: usage.total } : {}),
    ...(state.contextUsedTokens !== undefined
      ? { contextUsedTokens: state.contextUsedTokens }
      : {}),
    ...(state.contextTokenBudget !== undefined
      ? { contextTokenBudget: state.contextTokenBudget }
      : {}),
    ...(state.durationMs !== undefined ? { durationMs: state.durationMs } : {}),
    ...(state.turnUsd !== undefined
      ? { turnCost: state.turnUsd, currency: "USD" as const }
      : {}),
  };
}

function needsNativeDelivery(payload: Record<string, unknown>): boolean {
  return (
    typeof payload.mediaUrl === "string" ||
    (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0) ||
    payload.presentation !== undefined ||
    payload.interactive !== undefined ||
    payload.channelData !== undefined ||
    payload.delivery !== undefined ||
    payload.btw !== undefined ||
    payload.ttsSupplement !== undefined ||
    payload.isCompactionNotice === true ||
    payload.isFallbackNotice === true ||
    payload.isStatusNotice === true
  );
}

export class OpenClawCardBridge {
  private readonly api: OpenClawPluginApi;
  private readonly config: CardFooterConfig;
  private readonly sessions = new SessionRegistry();
  private readonly ledger: UsageLedger;
  private readonly resourceSampler = new ResourceSampler();
  private readonly clients = new Map<string, FeishuCardClient>();
  private readonly flushChains = new Map<string, Promise<boolean>>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly lastSentAt = new Map<string, number>();

  constructor(params: { api: OpenClawPluginApi; config: CardFooterConfig }) {
    this.api = params.api;
    this.config = params.config;
    this.ledger = new UsageLedger({
      storageDir: this.config.storageDir,
      timezone: this.config.timezone,
    });
  }

  register(): void {
    this.api.on("message_received", (event, ctx) =>
      this.onMessageReceived(event, ctx),
    );
    this.api.on("before_tool_call", (event, ctx) =>
      this.onBeforeTool(event, ctx),
    );
    this.api.on("after_tool_call", (event, ctx) =>
      this.onAfterTool(event, ctx),
    );
    this.api.on(
      "reply_payload_sending",
      (event, ctx) => this.onReplyPayload(event, ctx),
      { priority: 100 },
    );
    this.api.on("gateway_stop", () => this.stop());
  }

  private onMessageReceived(
    event: PluginHookMessageReceivedEvent,
    ctx: PluginHookMessageContext,
  ): void {
    if (!this.captures(ctx.channelId)) {
      return;
    }
    this.sessions.prune(6 * 60 * 60 * 1_000);
    const key = keyFrom({
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      runId: event.runId ?? ctx.runId,
      conversationId: ctx.conversationId,
      fallback: event.messageId,
    });
    this.sessions.getOrCreate({
      key,
      runtime: "openclaw",
      route: normalizeRoute(ctx, event),
    });
  }

  private onBeforeTool(
    event: BeforeToolEvent,
    ctx: PluginHookToolContext,
  ): void {
    const key = keyFrom({
      sessionKey: ctx.sessionKey,
      runId: event.runId ?? ctx.runId,
      fallback: event.toolCallId ?? ctx.toolCallId,
    });
    const session =
      this.sessions.get(key) ??
      (this.captures(ctx.channelId)
        ? this.sessions.getOrCreate({ key, runtime: "openclaw" })
        : undefined);
    if (!session) {
      return;
    }
    session.startTool({
      id: event.toolCallId ?? ctx.toolCallId,
      name: event.toolName,
      input: event.params,
    });
    this.scheduleFlush(key);
  }

  private onAfterTool(
    event: PluginHookAfterToolCallEvent,
    ctx: PluginHookToolContext,
  ): void {
    const key = keyFrom({
      sessionKey: ctx.sessionKey,
      runId: event.runId ?? ctx.runId,
      fallback: event.toolCallId ?? ctx.toolCallId,
    });
    const session =
      this.sessions.get(key) ??
      (this.captures(ctx.channelId)
        ? this.sessions.getOrCreate({ key, runtime: "openclaw" })
        : undefined);
    if (!session) {
      return;
    }
    session.finishTool({
      id: event.toolCallId ?? ctx.toolCallId,
      name: event.toolName,
      output: event.result,
      error: event.error,
      durationMs: event.durationMs,
    });
    this.scheduleFlush(key);
  }

  private async onReplyPayload(
    event: PluginHookReplyPayloadSendingEvent,
    ctx: PluginHookReplyPayloadSendingContext,
  ): Promise<PluginHookReplyPayloadSendingResult | void> {
    const channel = event.channel ?? ctx.channelId;
    if (!this.captures(channel)) {
      return;
    }
    const payload = event.payload as Record<string, unknown>;
    if (needsNativeDelivery(payload)) {
      return;
    }
    const text = typeof payload.text === "string" ? payload.text : "";
    if (!text.trim() && event.kind !== "final") {
      return;
    }
    const key = keyFrom({
      sessionKey: event.sessionKey ?? ctx.sessionKey,
      runId: event.runId ?? ctx.runId,
      conversationId: ctx.conversationId,
    });
    const existing = this.sessions.get(key)?.snapshot();
    if (!text.trim() && event.kind === "final" && !existing?.answer.trim()) {
      return;
    }
    const session = this.sessions.getOrCreate({
      key,
      runtime: "openclaw",
      route: normalizeRoute(ctx),
    });
    const usage = normalizeUsage(event);
    const renderedText =
      payload.isReasoning === true ? `Reasoning:\n${text}` : text;
    session.applyReply(
      event.kind,
      renderedText,
      usage ? applyPricing(usage, this.config.pricing) : undefined,
    );
    if (event.kind === "final" && payload.isError === true) {
      session.finish("failed");
    }

    if (event.kind === "final" && session.snapshot().usage) {
      this.ledger.append({
        id: event.runId ?? `${key}:${session.snapshot().startedAt}`,
        runtime: "openclaw",
        usage: session.snapshot().usage ?? {},
      });
    }

    const delivered = await this.flush(key);
    if (event.kind === "final") {
      this.cleanup(key);
    }
    if (!delivered) {
      return;
    }
    return {
      cancel: true,
      reason: "rendered by openclaw-feishu-card-footer",
    };
  }

  private captures(channel: string | undefined): boolean {
    return (
      this.config.enabled &&
      typeof channel === "string" &&
      this.config.captureChannels.some((candidate) => candidate === channel)
    );
  }

  private scheduleFlush(key: string): void {
    const session = this.sessions.get(key)?.snapshot();
    if (!session?.route?.conversationId) {
      return;
    }
    const now = Date.now();
    const wait = Math.max(
      0,
      this.config.updateIntervalMs - (now - (this.lastSentAt.get(key) ?? 0)),
    );
    const previous = this.timers.get(key);
    if (previous) {
      clearTimeout(previous);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        void this.flush(key);
      }, wait),
    );
  }

  private async flush(key: string): Promise<boolean> {
    const previous = this.flushChains.get(key) ?? Promise.resolve(true);
    const next = previous
      .catch(() => false)
      .then(async () => this.flushNow(key))
      .catch((error: unknown) => {
        this.api.logger.error(
          `[openclaw-feishu-card-footer] update failed: ${String(error)}`,
        );
        return false;
      });
    this.flushChains.set(key, next);
    const result = await next;
    if (this.flushChains.get(key) === next) {
      this.flushChains.delete(key);
    }
    return result;
  }

  private async flushNow(key: string): Promise<boolean> {
    const session = this.sessions.get(key);
    const snapshot = session?.snapshot();
    if (!session || !snapshot?.route?.conversationId) {
      return false;
    }
    const credentials = resolveFeishuCredentials(
      this.api.config,
      snapshot.route.accountId,
    );
    if (!credentials) {
      this.api.logger.warn(
        "[openclaw-feishu-card-footer] Feishu credentials were not resolved; native channel delivery remains active",
      );
      return false;
    }
    const clientKey = `${snapshot.route.accountId ?? "default"}:${credentials.appId}:${credentials.domain}`;
    let client = this.clients.get(clientKey);
    if (!client) {
      client = new FeishuCardClient(credentials);
      this.clients.set(clientKey, client);
    }
    const resource = this.config.panels.resources
      ? await this.resourceSampler.sample()
      : undefined;
    const card = renderCard({
      session: snapshot,
      totals: this.ledger.totals(),
      config: this.config,
      ...(resource ? { resource } : {}),
    });
    if (!snapshot.cardId) {
      const created = await client.create({
        card,
        conversationId: snapshot.route.conversationId,
        ...(snapshot.route.replyToId
          ? { replyToId: snapshot.route.replyToId }
          : {}),
        replyInThread: Boolean(snapshot.route.threadId),
      });
      session.setDelivery({
        cardId: created.cardId,
        ...(created.messageId ? { messageId: created.messageId } : {}),
      });
    } else {
      await client.update({
        cardId: snapshot.cardId,
        card,
        sequence: session.nextSequence(),
      });
    }
    if (snapshot.status !== "running") {
      const current = session.snapshot();
      await client.setStreamingMode({
        cardId: current.cardId ?? snapshot.cardId ?? "",
        enabled: false,
        sequence: session.nextSequence(),
      });
    }
    this.lastSentAt.set(key, Date.now());
    return true;
  }

  private stop(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
  }

  private cleanup(key: string): void {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.sessions.delete(key);
    this.lastSentAt.delete(key);
  }
}
