import { afterEach, describe, expect, it } from "vitest";

import { resolveConfig } from "../src/core/config.js";
import { resolveFeishuCredentials } from "../src/openclaw/credentials.js";

const previousEnvironment = { ...process.env };

afterEach(() => {
  process.env = { ...previousEnvironment };
});

describe("configuration", () => {
  it("fills nested defaults", () => {
    const config = resolveConfig({});
    expect(config.panels).toEqual({
      reasoning: true,
      tools: true,
      progress: true,
      resources: false,
      footer: true,
    });
    expect(config.footer.tokens).toBe(true);
    expect(config.footer.totals).toBe(false);
    expect(config.footer.backgroundTasks).toBe(false);
    expect(config.footer.balance).toBe(false);
    expect(config.title).toBe("OpenClaw");
    expect(config.captureChannels).toContain("feishu");
  });

  it("rejects an invalid IANA timezone", () => {
    expect(() => resolveConfig({ timezone: "Mars/Olympus" })).toThrow(
      /timezone/,
    );
  });
});

describe("credential resolution", () => {
  it("merges account config over channel defaults", () => {
    delete process.env.FEISHU_APP_ID;
    delete process.env.FEISHU_APP_SECRET;
    delete process.env.LARK_APP_ID;
    delete process.env.LARK_APP_SECRET;
    expect(
      resolveFeishuCredentials(
        {
          channels: {
            feishu: {
              appId: "base-id",
              appSecret: "base-secret",
              accounts: {
                work: {
                  appId: "work-id",
                  appSecret: "work-secret",
                  domain: "lark",
                },
              },
            },
          },
        },
        "work",
      ),
    ).toEqual({
      appId: "work-id",
      appSecret: "work-secret",
      domain: "lark",
    });
  });

  it("uses environment credentials only when channel credentials are absent", () => {
    process.env.FEISHU_APP_ID = "env-id";
    process.env.FEISHU_APP_SECRET = "env-secret";
    expect(
      resolveFeishuCredentials({
        channels: {
          feishu: {
            appId: "config-id",
            appSecret: "config-secret",
          },
        },
      }),
    ).toMatchObject({ appId: "config-id", appSecret: "config-secret" });
    expect(
      resolveFeishuCredentials({ channels: { feishu: {} } }),
    ).toMatchObject({
      appId: "env-id",
      appSecret: "env-secret",
    });
  });
});
