import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import plugin from "../src/index.js";

function createApi(pluginConfig: Record<string, unknown> = {}): {
  api: OpenClawPluginApi;
  on: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
} {
  const on = vi.fn((_hook: string, ..._args: unknown[]) => {
    void _hook;
    void _args;
  });
  const info = vi.fn();
  const api = {
    pluginConfig,
    config: {},
    on,
    logger: {
      debug: vi.fn(),
      info,
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as OpenClawPluginApi;
  return { api, on, info };
}

describe("OpenClaw plugin entry point", () => {
  it("registers the current hook set", () => {
    const { api, on, info } = createApi();
    plugin.register(api);

    const hookNames: string[] = [];
    for (const rawCall of on.mock.calls) {
      const call: unknown[] = rawCall;
      if (typeof call[0] === "string") {
        hookNames.push(call[0]);
      }
    }
    expect(hookNames).toEqual([
      "message_received",
      "before_tool_call",
      "after_tool_call",
      "reply_payload_sending",
      "gateway_stop",
    ]);
    expect(on.mock.calls[3]?.[2]).toEqual({ priority: 100 });
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("active for channels: feishu"),
    );
  });

  it("does not register hooks when disabled", () => {
    const { api, on, info } = createApi({ enabled: false });
    plugin.register(api);

    expect(on).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining("disabled"));
  });
});
