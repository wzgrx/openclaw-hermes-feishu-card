import type {
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";

import {
  ResourceSampler,
  LegacyRuntimeSampler,
  SessionRegistry,
  UsageLedger,
  applyPricing,
  renderCard,
  type CardFooterConfig,
  type SessionRoute,
} from "../core/index.js";
import { resolveFeishuCredentials } from "./credentials.js";
import { FeishuCardClient } from "./feishu-client.js";
import { normalizeOpenClawUsage } from "./usage.js";

type BeforeToolEvent = {
  toolName: string;
  params?: unknown;
  toolCallId?: string;
  runId?: string;
};

interface MessageContext {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  replyToId?: string;
}

interface MessageReceivedEvent {
  sessionKey?: string;
  runId?: string;
  messageId?: string;
  threadId?: string | number;
}

interface ToolContext {
  channelId?: string;
  sessionKey?: string;
  runId?: string;
  toolCallId?: string;
}

interface AfterToolEvent {
  toolName: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
  toolCallId?: string;
  runId?: string;
}

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
  ctx: MessageContext,
  event?: MessageReceivedEvent,
): SessionRoute {
  const conversationId = resolveConversationId(ctx);
  return {
    channelId: ctx.channelId,
    ...(ctx.accountId ? { accountId: ctx.accountId } : {}),
    ...(conversationId ? { conversationId } : {}),
    ...((event?.messageId ?? ctx.messageId ?? ctx.replyToId)
      ? { replyToId: event?.messageId ?? ctx.messageId ?? ctx.replyToId }
      : {}),
    ...(event?.threadId ? { threadId: String(event.threadId) } : {}),
  };
}

function normalizeConversationTarget(
  value: string | undefined,
): string | undefined {
  const target = value?.trim();
  if (!target) {
    return undefined;
  }
  return target
    .replace(/^(?:feishu|openclaw-lark):/i, "")
    .replace(/^(?:chat|group|user):/i, "");
}

function conversationIdFromSessionKey(
  sessionKey: string | undefined,
): string | undefined {
  const key = sessionKey?.trim();
  if (!key) {
    return undefined;
  }
  const match = key.match(/:(?:group|direct|channel):([^:]+)$/i);
  return normalizeConversationTarget(match?.[1]);
}

function resolveConversationId(ctx: MessageContext): string | undefined {
  return (
    normalizeConversationTarget(ctx.conversationId) ??
    conversationIdFromSessionKey(ctx.sessionKey)
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function hasNativeChannelPayload(payload: Record<string, unknown>): boolean {
  const channelData = record(payload.channelData);
  const feishu = record(channelData.feishu ?? channelData["openclaw-lark"]);
  return (
    feishu.card !== undefined ||
    channelData.execApproval !== undefined ||
    channelData.location !== undefined ||
    channelData.message !== undefined
  );
}

function presentationHasControls(value: unknown): boolean {
  const blocks = record(value).blocks;
  return (
    Array.isArray(blocks) &&
    blocks.some((block) => {
      const type = record(block).type;
      return type === "buttons" || type === "select";
    })
  );
}

function presentationText(value: unknown): string {
  const presentation = record(value);
  const parts: string[] = [];
  if (typeof presentation.title === "string" && presentation.title.trim()) {
    parts.push(`**${presentation.title.trim()}**`);
  }
  if (Array.isArray(presentation.blocks)) {
    for (const rawBlock of presentation.blocks) {
      const block = record(rawBlock);
      if (
        (block.type === "text" || block.type === "context") &&
        typeof block.text === "string" &&
        block.text.trim()
      ) {
        parts.push(block.text.trim());
      } else if (block.type === "divider") {
        parts.push("---");
      }
    }
  }
  return parts.join("\n\n");
}

function requestsPin(payload: Record<string, unknown>): boolean {
  const pin = record(payload.delivery).pin;
  return pin === true || record(pin).enabled === true;
}

function nativeDeliveryReason(
  payload: Record<string, unknown>,
): string | undefined {
  if (
    typeof payload.mediaUrl === "string" ||
    (Array.isArray(payload.mediaUrls) && payload.mediaUrls.length > 0)
  ) {
    return "media";
  }
  if (presentationHasControls(payload.presentation)) {
    return "presentation-controls";
  }
  if (payload.interactive !== undefined) {
    return "interactive";
  }
  if (requestsPin(payload)) {
    return "pin";
  }
  if (hasNativeChannelPayload(payload)) {
    return "channel-native-payload";
  }
  if (payload.btw !== undefined) {
    return "btw";
  }
  if (payload.location !== undefined) {
    return "location";
  }
  if (payload.ttsSupplement !== undefined) {
    return "tts";
  }
  if (payload.isCompactionNotice === true) {
    return "compaction-notice";
  }
  if (payload.isFallbackNotice === true) {
    return "fallback-notice";
  }
  if (payload.isStatusNotice === true) {
    return "status-notice";
  }
  return undefined;
}

export class OpenClawCardBridge {
  private readonly api: OpenClawPluginApi;
  private readonly config: CardFooterConfig;
  private readonly sessions = new SessionRegistry();
  private readonly ledger: UsageLedger;
  private readonly resourceSampler = new ResourceSampler();
  private readonly legacyRuntimeSampler: LegacyRuntimeSampler;
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
    this.legacyRuntimeSampler = new LegacyRuntimeSampler(
      this.config.legacyTaskDir,
      this.config.balanceCachePath,
    );
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
    event: MessageReceivedEvent,
    ctx: MessageContext,
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
    this.api.logger.debug?.(
      `[openclaw-hermes-feishu-card] inbound captured channel=${ctx.channelId} key=${key} conversation=${ctx.conversationId ?? "missing"} message=${event.messageId ?? ctx.messageId ?? "missing"}`,
    );
  }

  private onBeforeTool(event: BeforeToolEvent, ctx: ToolContext): void {
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

  private onAfterTool(event: AfterToolEvent, ctx: ToolContext): void {
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
    this.api.logger.debug?.(
      `[openclaw-hermes-feishu-card] reply hook channel=${channel ?? "missing"} kind=${event.kind} session=${event.sessionKey ?? ctx.sessionKey ?? "missing"} run=${event.runId ?? ctx.runId ?? "missing"} conversation=${ctx.conversationId ?? "missing"} payloadKeys=${Object.keys(
        event.payload,
      )
        .sort()
        .join(",")}`,
    );
    if (!this.captures(channel)) {
      return;
    }
    const payload = event.payload as Record<string, unknown>;
    const nativeReason = nativeDeliveryReason(payload);
    if (nativeReason) {
      if (event.kind === "final") {
        this.api.logger.info(
          `[openclaw-hermes-feishu-card] native passthrough reason=${nativeReason} channel=${channel}`,
        );
      }
      return;
    }
    const text =
      typeof payload.text === "string" && payload.text.trim()
        ? payload.text
        : presentationText(payload.presentation);
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
    const usage = normalizeOpenClawUsage(event.usageState);
    if (event.kind === "final") {
      this.api.logger.info(
        `[openclaw-hermes-feishu-card] final captured key=${key} route=${resolveConversationId(ctx) ?? "missing"} usage=${usage ? "present" : "missing"} resolved=${usage?.resolvedRef ?? "missing"} context=${usage?.contextUsedTokens ?? "missing"}/${usage?.contextTokenBudget ?? "missing"}`,
      );
    }
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
    if (delivered && event.kind === "final") {
      this.api.logger.info(
        `[openclaw-hermes-feishu-card] card delivered channel=${channel} conversation=${ctx.conversationId ?? "unknown"}`,
      );
    }
    if (event.kind === "final") {
      this.cleanup(key);
    }
    if (!delivered) {
      return;
    }
    return {
      cancel: true,
      reason: "rendered by openclaw-hermes-feishu-card",
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
          `[openclaw-hermes-feishu-card] update failed: ${String(error)}`,
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
    if (!session) {
      return false;
    }
    if (!snapshot?.route?.conversationId) {
      this.api.logger.warn(
        `[openclaw-hermes-feishu-card] delivery route missing key=${key} session=${snapshot?.id ?? "unknown"}`,
      );
      return false;
    }
    const credentials = resolveFeishuCredentials(
      this.api.config,
      snapshot.route.accountId,
    );
    if (!credentials) {
      this.api.logger.warn(
        "[openclaw-hermes-feishu-card] Feishu credentials were not resolved; native channel delivery remains active",
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
    const legacy =
      this.config.footer.backgroundTasks || this.config.footer.balance
        ? await this.legacyRuntimeSampler.sample()
        : undefined;
    const card = renderCard({
      session: snapshot,
      totals: this.ledger.totals(),
      config: this.config,
      ...(resource ? { resource } : {}),
      ...(legacy ? { legacy } : {}),
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
