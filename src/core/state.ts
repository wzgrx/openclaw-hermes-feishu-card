import { randomUUID } from "node:crypto";

import type {
  CardStatus,
  ReplyKind,
  RuntimeName,
  SessionRoute,
  SessionSnapshot,
  ToolStep,
  UsageSnapshot,
} from "./types.js";

const REASONING_PREFIX = "Reasoning:\n";
const THINKING_BLOCK =
  /<\s*(?:think(?:ing)?|thought|reasoning|reasoning_scratchpad|antthinking)\s*>([\s\S]*?)<\s*\/\s*(?:think(?:ing)?|thought|reasoning|reasoning_scratchpad|antthinking)\s*>/gi;

function trimPreview(value: unknown, limit = 1_500): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value, null, 2);
    } catch {
      text = Object.prototype.toString.call(value);
    }
  }
  text = text.trim();
  if (!text) {
    return undefined;
  }
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

function splitReasoning(text: string): { answer?: string; reasoning?: string } {
  const trimmed = text.trim();
  if (trimmed.startsWith(REASONING_PREFIX)) {
    return { reasoning: trimmed.slice(REASONING_PREFIX.length).trim() };
  }

  const reasoning: string[] = [];
  const answer = text
    .replace(THINKING_BLOCK, (_match, block: string) => {
      if (block.trim()) {
        reasoning.push(block.trim());
      }
      return "";
    })
    .replace(
      /<\s*\/?\s*(?:think(?:ing)?|thought|reasoning|reasoning_scratchpad|antthinking)\s*>/gi,
      "",
    )
    .trim();

  return {
    ...(answer ? { answer } : {}),
    ...(reasoning.length > 0 ? { reasoning: reasoning.join("\n\n") } : {}),
  };
}

function mergeStreamingText(current: string, incoming: string): string {
  const next = incoming.trim();
  if (!next) {
    return current;
  }
  if (
    !current ||
    next.startsWith(current) ||
    next.length >= current.length * 1.5
  ) {
    return next;
  }
  if (current.endsWith(next)) {
    return current;
  }
  return `${current}${next}`;
}

export class CardSession {
  readonly id: string;
  readonly runtime: RuntimeName;
  private route: SessionRoute | undefined;
  private status: CardStatus = "running";
  private readonly startedAt: number;
  private updatedAt: number;
  private completedAt: number | undefined;
  private firstTokenAt: number | undefined;
  private answer = "";
  private reasoning = "";
  private readonly notices: string[] = [];
  private readonly tools = new Map<string, ToolStep>();
  private usage: UsageSnapshot | undefined;
  private cardId: string | undefined;
  private messageId: string | undefined;
  private sequence = 0;

  constructor(params: {
    id?: string;
    runtime: RuntimeName;
    route?: SessionRoute;
    now?: number;
  }) {
    this.id = params.id ?? randomUUID();
    this.runtime = params.runtime;
    this.route = params.route;
    this.startedAt = params.now ?? Date.now();
    this.updatedAt = this.startedAt;
  }

  setRoute(route: SessionRoute): void {
    this.route = { ...this.route, ...route };
    this.touch();
  }

  applyReply(kind: ReplyKind, text: string, usage?: UsageSnapshot): void {
    const parsed = splitReasoning(text);
    if (parsed.reasoning) {
      this.reasoning = mergeStreamingText(this.reasoning, parsed.reasoning);
    }
    if (parsed.answer) {
      this.answer =
        kind === "final"
          ? parsed.answer
          : mergeStreamingText(this.answer, parsed.answer);
      this.firstTokenAt ??= Date.now();
    }
    if (kind === "tool" && text.trim()) {
      this.addNotice(text);
    }
    if (usage) {
      this.usage = { ...this.usage, ...usage };
    }
    if (kind === "final") {
      this.finish("completed");
    } else {
      this.touch();
    }
  }

  startTool(params: {
    id?: string | undefined;
    name: string;
    input?: unknown;
    now?: number | undefined;
  }): string {
    const id = params.id ?? `${params.name}:${randomUUID()}`;
    const now = params.now ?? Date.now();
    const inputPreview = trimPreview(params.input);
    this.tools.set(id, {
      id,
      name: params.name,
      status: "running",
      startedAt: now,
      ...(inputPreview ? { inputPreview } : {}),
    });
    this.touch(now);
    return id;
  }

  finishTool(params: {
    id?: string | undefined;
    name: string;
    output?: unknown;
    error?: unknown;
    durationMs?: number | undefined;
    now?: number | undefined;
  }): void {
    const now = params.now ?? Date.now();
    const id =
      params.id ??
      [...this.tools.values()].findLast(
        (step) => step.name === params.name && step.status === "running",
      )?.id ??
      `${params.name}:${randomUUID()}`;
    const previous = this.tools.get(id);
    const startedAt =
      previous?.startedAt ??
      Math.max(this.startedAt, now - (params.durationMs ?? 0));
    const error = trimPreview(params.error);
    const outputPreview = trimPreview(params.output);
    this.tools.set(id, {
      id,
      name: params.name,
      status: error ? "failed" : "completed",
      startedAt,
      finishedAt: now,
      durationMs: params.durationMs ?? Math.max(0, now - startedAt),
      ...(previous?.inputPreview
        ? { inputPreview: previous.inputPreview }
        : {}),
      ...(outputPreview ? { outputPreview } : {}),
      ...(error ? { error } : {}),
    });
    this.touch(now);
  }

  addNotice(notice: string): void {
    const normalized = notice.trim();
    if (!normalized || this.notices.at(-1) === normalized) {
      return;
    }
    this.notices.push(normalized);
    if (this.notices.length > 20) {
      this.notices.shift();
    }
    this.touch();
  }

  setUsage(usage: UsageSnapshot): void {
    this.usage = { ...this.usage, ...usage };
    this.touch();
  }

  setDelivery(params: {
    cardId: string;
    messageId?: string;
    sequence?: number;
  }): void {
    this.cardId = params.cardId;
    if (params.messageId) {
      this.messageId = params.messageId;
    }
    this.sequence = params.sequence ?? this.sequence;
    this.touch();
  }

  nextSequence(): number {
    this.sequence += 1;
    return this.sequence;
  }

  finish(status: Exclude<CardStatus, "running">, now = Date.now()): void {
    for (const [id, step] of this.tools) {
      if (step.status !== "running") continue;
      this.tools.set(id, {
        ...step,
        status: status === "completed" ? "completed" : "failed",
        finishedAt: now,
        durationMs: Math.max(0, now - step.startedAt),
        ...(status === "completed"
          ? {}
          : { error: status === "failed" ? "run failed" : "run stopped" }),
      });
    }
    this.status = status;
    this.completedAt = now;
    this.touch(now);
  }

  snapshot(): SessionSnapshot {
    return {
      id: this.id,
      runtime: this.runtime,
      ...(this.route ? { route: { ...this.route } } : {}),
      status: this.status,
      startedAt: this.startedAt,
      updatedAt: this.updatedAt,
      ...(this.completedAt ? { completedAt: this.completedAt } : {}),
      ...(this.firstTokenAt ? { firstTokenAt: this.firstTokenAt } : {}),
      answer: this.answer,
      reasoning: this.reasoning,
      notices: [...this.notices],
      tools: [...this.tools.values()],
      ...(this.usage ? { usage: { ...this.usage } } : {}),
      ...(this.cardId ? { cardId: this.cardId } : {}),
      ...(this.messageId ? { messageId: this.messageId } : {}),
      sequence: this.sequence,
    };
  }

  private touch(now = Date.now()): void {
    this.updatedAt = now;
  }
}

export class SessionRegistry {
  private readonly sessions = new Map<string, CardSession>();

  getOrCreate(params: {
    key: string;
    runtime: RuntimeName;
    route?: SessionRoute;
  }): CardSession {
    const existing = this.sessions.get(params.key);
    if (existing) {
      if (params.route) {
        existing.setRoute(params.route);
      }
      return existing;
    }
    const session = new CardSession({
      id: params.key,
      runtime: params.runtime,
      ...(params.route ? { route: params.route } : {}),
    });
    this.sessions.set(params.key, session);
    return session;
  }

  get(key: string): CardSession | undefined {
    return this.sessions.get(key);
  }

  delete(key: string): boolean {
    return this.sessions.delete(key);
  }

  prune(olderThanMs: number, now = Date.now()): number {
    let removed = 0;
    for (const [key, session] of this.sessions) {
      if (now - session.snapshot().updatedAt > olderThanMs) {
        this.sessions.delete(key);
        removed += 1;
      }
    }
    return removed;
  }
}
