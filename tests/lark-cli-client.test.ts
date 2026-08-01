import { describe, expect, it } from "vitest";

import {
  LarkCliCardClient,
  type LarkCliCommandResult,
  type LarkCliExecutor,
} from "../src/lark-cli/index.js";
import type { CardJson } from "../src/core/types.js";

const card: CardJson = {
  schema: "2.0",
  config: {
    streaming_mode: true,
    summary: { content: "test" },
  },
  body: {
    elements: [{ tag: "markdown", content: "start", element_id: "content" }],
  },
};

function executorFrom(
  responses: Array<Record<string, unknown> | LarkCliCommandResult>,
  calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }>,
): LarkCliExecutor {
  return {
    run(_binary, args, options) {
      calls.push({ args, env: options.env });
      const next = responses.shift();
      if (!next) throw new Error("unexpected command");
      if ("exitCode" in next) {
        return Promise.resolve(next as LarkCliCommandResult);
      }
      return Promise.resolve({
        exitCode: 0,
        stdout: JSON.stringify(next),
        stderr: "",
      });
    },
  };
}

describe("LarkCliCardClient", () => {
  it("builds an agent-friendly CardKit dry-run without putting secrets in argv", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const client = new LarkCliCardClient({
      credentials: { appId: "cli_test", appSecret: "secret_test" },
      executor: executorFrom([{ ok: true, dry_run: true, data: {} }], calls),
    });

    const result = await client.dryRun(card);

    expect(result.dryRun).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toContain("--dry-run");
    expect(calls[0]?.args.join(" ")).not.toContain("secret_test");
    expect(calls[0]?.env.LARKSUITE_CLI_APP_SECRET).toBe("secret_test");
  });

  it("runs create, send, update and close in sequence", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const client = new LarkCliCardClient({
      credentials: { appId: "cli_test", appSecret: "secret_test" },
      tokenProvider: () => Promise.resolve("tat_test"),
      executor: executorFrom(
        [
          { ok: true, data: { data: { card_id: "card_1" } } },
          { ok: true, data: { data: { message_id: "msg_1" } } },
          { ok: true, data: { code: 0 } },
          { ok: true, data: { code: 0 } },
          { ok: true, data: { code: 0 } },
        ],
        calls,
      ),
    });

    const result = await client.smoke({
      card,
      conversationId: "oc_test",
      finalContent: "done",
    });

    expect(result).toEqual({
      dryRun: false,
      cardId: "card_1",
      messageId: "msg_1",
    });
    expect(calls.map((call) => call.args[1])).toEqual([
      "POST",
      "POST",
      "PUT",
      "PUT",
      "PATCH",
    ]);
    expect(calls[1]?.args).toContain('{"receive_id_type":"chat_id"}');
    expect(calls[2]?.args[2]).toContain("card_1/elements/content/content");
    expect(calls[0]?.env.LARKSUITE_CLI_TENANT_ACCESS_TOKEN).toBe("tat_test");
  });

  it("runs a real card entity lifecycle without sending a chat message", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    const client = new LarkCliCardClient({
      credentials: { appId: "cli_test", appSecret: "secret_test" },
      tokenProvider: () => Promise.resolve("tat_test"),
      executor: executorFrom(
        [
          { ok: true, data: { data: { card_id: "card_entity_1" } } },
          { ok: true, data: { code: 0 } },
          { ok: true, data: { code: 0 } },
          { ok: true, data: { code: 0 } },
        ],
        calls,
      ),
    });

    const result = await client.smokeEntity({ card, finalContent: "done" });

    expect(result).toEqual({ dryRun: false, cardId: "card_entity_1" });
    expect(calls.map((call) => call.args[1])).toEqual([
      "POST",
      "PUT",
      "PUT",
      "PATCH",
    ]);
    expect(calls.some((call) => call.args[2]?.includes("/im/v1/"))).toBe(false);
    expect(calls[1]?.args[2]).toContain(
      "card_entity_1/elements/content/content",
    );
    expect(calls[2]?.args[2]).toContain(
      "card_entity_1/elements/footer/content",
    );
  });

  it("preserves the failed stage in structured errors", async () => {
    const client = new LarkCliCardClient({
      credentials: { appId: "cli_test", appSecret: "secret_test" },
      executor: executorFrom(
        [
          {
            exitCode: 7,
            stdout: "",
            stderr: "credential provider failed",
          },
        ],
        [],
      ),
    });

    await expect(client.dryRun(card)).rejects.toMatchObject({
      name: "LarkCliError",
      stage: "card.create.dry-run",
      exitCode: 7,
    });
  });
});
