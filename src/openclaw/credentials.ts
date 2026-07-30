interface OpenClawConfigLike {
  channels?: Record<string, unknown>;
}

export interface FeishuCredentials {
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(...values: unknown[]): string | undefined {
  return values
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim().length > 0,
    )
    ?.trim();
}

export function resolveFeishuCredentials(
  config: OpenClawConfigLike,
  accountId?: string,
): FeishuCredentials | undefined {
  const channels = record(config.channels);
  const base = record(channels.feishu ?? channels["openclaw-lark"]);
  const account = accountId ? record(record(base.accounts)[accountId]) : {};
  const appId = stringValue(
    account.appId,
    account.app_id,
    base.appId,
    base.app_id,
    process.env.FEISHU_APP_ID,
    process.env.LARK_APP_ID,
  );
  const appSecret = stringValue(
    account.appSecret,
    account.app_secret,
    base.appSecret,
    base.app_secret,
    process.env.FEISHU_APP_SECRET,
    process.env.LARK_APP_SECRET,
  );
  if (!appId || !appSecret) {
    return undefined;
  }
  const rawDomain = stringValue(
    account.domain,
    base.domain,
    process.env.FEISHU_DOMAIN,
  )?.toLowerCase();
  return {
    appId,
    appSecret,
    domain: rawDomain === "lark" ? "lark" : "feishu",
  };
}
