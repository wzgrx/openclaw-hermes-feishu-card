import { describe, expect, it, vi } from "vitest";

import { CardSession, SessionRegistry } from "../src/core/state.js";

describe("CardSession", () => {
  it("keeps cumulative answer text, usage and tool lifecycle", () => {
    vi.setSystemTime(new Date("2026-07-30T02:00:00Z"));
    const session = new CardSession({
      id: "session-1",
      runtime: "openclaw",
      now: Date.now(),
    });

    session.applyReply("block", "Hel");
    session.applyReply("block", "Hello");
    session.startTool({
      id: "tool-1",
      name: "search",
      input: { q: "CardKit" },
      now: Date.now() + 10,
    });
    session.finishTool({
      id: "tool-1",
      name: "search",
      output: { ok: true },
      durationMs: 25,
      now: Date.now() + 35,
    });
    session.applyReply("final", "Hello, world", {
      model: "provider/model",
      inputTokens: 100,
      outputTokens: 20,
    });

    const snapshot = session.snapshot();
    expect(snapshot.answer).toBe("Hello, world");
    expect(snapshot.status).toBe("completed");
    expect(snapshot.firstTokenAt).toBeDefined();
    expect(snapshot.tools).toEqual([
      expect.objectContaining({
        id: "tool-1",
        name: "search",
        status: "completed",
        durationMs: 25,
      }),
    ]);
    expect(snapshot.usage?.inputTokens).toBe(100);
    vi.useRealTimers();
  });

  it("extracts thinking blocks from the visible answer", () => {
    const session = new CardSession({ id: "session-2", runtime: "hermes" });
    session.applyReply(
      "final",
      "<REASONING_SCRATCHPAD>check assumptions</REASONING_SCRATCHPAD>\nResult",
    );
    expect(session.snapshot().reasoning).toBe("check assumptions");
    expect(session.snapshot().answer).toBe("Result");
  });
});

describe("SessionRegistry", () => {
  it("reuses a session key and merges its route", () => {
    const registry = new SessionRegistry();
    const first = registry.getOrCreate({
      key: "same",
      runtime: "openclaw",
      route: { channelId: "feishu", conversationId: "oc_1" },
    });
    const second = registry.getOrCreate({
      key: "same",
      runtime: "openclaw",
      route: { channelId: "feishu", replyToId: "om_1" },
    });
    expect(second).toBe(first);
    expect(second.snapshot().route).toEqual({
      channelId: "feishu",
      conversationId: "oc_1",
      replyToId: "om_1",
    });
  });
});
