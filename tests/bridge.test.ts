import os from "node:os";
import path from "node:path";

import type {
  PluginHookReplyPayloadSendingContext,
  PluginHookReplyPayloadSendingEvent,
  PluginHookReplyPayloadSendingResult,
  OpenClawPluginApi,
} from "openclaw/plugin-sdk/core";
import { describe, expect, it, vi } from "vitest";

import { resolveConfig } from "../src/core/config.js";
import type { SessionRegistry } from "../src/core/state.js";
import { OpenClawCardBridge } from "../src/openclaw/bridge.js";

interface BridgeHarness {
  sessions: SessionRegistry;
  flush(key: string): Promise<boolean>;
  onMessageReceived(event: MessageReceivedEvent, ctx: MessageContext): void;
  onReplyPayload(
    event: PluginHookReplyPayloadSendingEvent,
    ctx: PluginHookReplyPayloadSendingContext,
  ): Promise<PluginHookReplyPayloadSendingResult | void>;
}

interface MessageReceivedEvent {
  from?: string;
  content?: string;
  messageId?: string;
  sessionKey?: string;
  runId?: string;
}

interface MessageContext {
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  runId?: string;
  isGroup?: boolean;
}

function createHarness(): {
  bridge: BridgeHarness;
  flush: ReturnType<typeof vi.fn>;
} {
  const api = {
    config: {},
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
  const instance = new OpenClawCardBridge({
    api,
    config: resolveConfig({
      storageDir: path.join(os.tmpdir(), "openclaw-feishu-card-footer-test"),
      panels: { resources: false },
    }),
  });
  const bridge = instance as unknown as BridgeHarness;
  const flush = vi.fn(() => Promise.resolve(true));
  bridge.flush = flush;
  return { bridge, flush };
}

const context = {
  channelId: "feishu",
  accountId: "default",
  conversationId: "oc_chat",
  sessionKey: "session",
  runId: "run-1",
  isGroup: false,
} satisfies MessageContext;

describe("OpenClaw card bridge delivery policy", () => {
  it("keys state by turn run id and removes it after final delivery", async () => {
    const { bridge } = createHarness();
    bridge.onMessageReceived(
      {
        from: "ou_user",
        content: "hello",
        messageId: "om_input",
        sessionKey: "session",
        runId: "run-1",
      },
      context,
    );
    expect(bridge.sessions.get("run-1")).toBeDefined();
    expect(bridge.sessions.get("session")).toBeUndefined();

    const result = await bridge.onReplyPayload(
      {
        payload: { text: "done" },
        kind: "final",
        channel: "feishu",
        sessionKey: "session",
        runId: "run-1",
      },
      context,
    );
    expect(result).toMatchObject({ cancel: true });
    expect(bridge.sessions.get("run-1")).toBeUndefined();
  });

  it("leaves rich and empty payloads on the native delivery path", async () => {
    const { bridge, flush } = createHarness();
    const richResult = await bridge.onReplyPayload(
      {
        payload: {
          text: "approval",
          presentation: { blocks: [] },
        },
        kind: "final",
        channel: "feishu",
        runId: "rich-run",
      } as unknown as PluginHookReplyPayloadSendingEvent,
      context,
    );
    const emptyResult = await bridge.onReplyPayload(
      {
        payload: {},
        kind: "final",
        channel: "feishu",
        runId: "empty-run",
      },
      context,
    );
    expect(richResult).toBeUndefined();
    expect(emptyResult).toBeUndefined();
    expect(flush).not.toHaveBeenCalled();
  });
});
