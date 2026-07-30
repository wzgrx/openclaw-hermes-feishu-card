import { describe, expect, it, vi } from "vitest";

import { FeishuCardClient } from "../src/openclaw/feishu-client.js";

interface ClientHarness {
  client: {
    cardkit: {
      v1: {
        card: {
          create: ReturnType<typeof vi.fn>;
          update: ReturnType<typeof vi.fn>;
          settings: ReturnType<typeof vi.fn>;
        };
      };
    };
    im: {
      message: {
        create: ReturnType<typeof vi.fn>;
        reply: ReturnType<typeof vi.fn>;
      };
    };
  };
}

function createClient(): {
  client: FeishuCardClient;
  harness: ClientHarness["client"];
} {
  const client = new FeishuCardClient({
    appId: "cli_fixture",
    appSecret: "secret_fixture",
    domain: "feishu",
  });
  const harness = {
    cardkit: {
      v1: {
        card: {
          create: vi.fn(() =>
            Promise.resolve({ code: 0, data: { card_id: "card-1" } }),
          ),
          update: vi.fn(() => Promise.resolve({ code: 0 })),
          settings: vi.fn(() => Promise.resolve({ code: 0 })),
        },
      },
    },
    im: {
      message: {
        create: vi.fn(() =>
          Promise.resolve({ code: 0, data: { message_id: "om-create" } }),
        ),
        reply: vi.fn(() =>
          Promise.resolve({ code: 0, data: { message_id: "om-reply" } }),
        ),
      },
    },
  };
  (client as unknown as ClientHarness).client = harness;
  return { client, harness };
}

describe("Feishu CardKit client", () => {
  it("creates a card and replies with its card reference", async () => {
    const { client, harness } = createClient();
    const result = await client.create({
      card: { schema: "2.0", body: { elements: [] } },
      conversationId: "oc-chat",
      replyToId: "om-input",
      replyInThread: true,
    });

    expect(result).toEqual({ cardId: "card-1", messageId: "om-reply" });
    expect(harness.im.message.reply.mock.calls[0]?.[0]).toMatchObject({
      path: { message_id: "om-input" },
      data: {
        msg_type: "interactive",
        reply_in_thread: true,
      },
    });
  });

  it("sends monotonic update and settings sequences", async () => {
    const { client, harness } = createClient();
    await client.update({
      cardId: "card-1",
      card: { schema: "2.0" },
      sequence: 4,
    });
    await client.setStreamingMode({
      cardId: "card-1",
      enabled: false,
      sequence: 5,
    });

    expect(harness.cardkit.v1.card.update.mock.calls[0]?.[0]).toMatchObject({
      path: { card_id: "card-1" },
      data: { sequence: 4 },
    });
    expect(harness.cardkit.v1.card.settings.mock.calls[0]?.[0]).toMatchObject({
      path: { card_id: "card-1" },
      data: { sequence: 5 },
    });
  });
});
