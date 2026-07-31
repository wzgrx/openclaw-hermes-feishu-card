import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type { CardJson } from "../core/types.js";

const execFileAsync = promisify(execFile);

export type LarkCliBrand = "feishu" | "lark";

export interface LarkCliCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LarkCliExecutor {
  run(
    binary: string,
    args: string[],
    options: { env: NodeJS.ProcessEnv; timeoutMs: number },
  ): Promise<LarkCliCommandResult>;
}

export interface LarkCliCredentials {
  appId: string;
  appSecret: string;
  brand?: LarkCliBrand;
  tenantAccessToken?: string;
}

export interface LarkCliSmokeResult {
  dryRun: boolean;
  cardId?: string;
  messageId?: string;
  request?: unknown;
}

export class LarkCliError extends Error {
  readonly stage: string;
  readonly exitCode: number | undefined;
  readonly detail: unknown;

  constructor(params: {
    stage: string;
    message: string;
    exitCode?: number;
    detail?: unknown;
    cause?: unknown;
  }) {
    super(params.message, params.cause ? { cause: params.cause } : undefined);
    this.name = "LarkCliError";
    this.stage = params.stage;
    this.exitCode = params.exitCode;
    this.detail = params.detail;
  }
}

export const defaultLarkCliExecutor: LarkCliExecutor = {
  async run(binary, args, options) {
    try {
      const result = await execFileAsync(binary, args, {
        env: options.env,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      });
      return {
        exitCode: 0,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    } catch (error: unknown) {
      const commandError = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
      };
      return {
        exitCode: typeof commandError.code === "number" ? commandError.code : 1,
        stdout: commandError.stdout ?? "",
        stderr: commandError.stderr ?? String(error),
      };
    }
  },
};

function parseEnvelope(raw: string, stage: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("response is not a JSON object");
    }
    return parsed as Record<string, unknown>;
  } catch (error: unknown) {
    throw new LarkCliError({
      stage,
      message: "lark-cli returned an invalid JSON envelope",
      detail: raw.slice(0, 500),
      cause: error,
    });
  }
}

function findString(
  value: unknown,
  key: string,
  depth = 0,
): string | undefined {
  if (depth > 8 || !value || typeof value !== "object") {
    return undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findString(item, key, depth + 1);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (typeof record[key] === "string" && record[key]) {
    return record[key];
  }
  for (const child of Object.values(record)) {
    const found = findString(child, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

function apiFailure(envelope: Record<string, unknown>): string | undefined {
  if (envelope.ok === false) {
    return findString(envelope, "message") ?? "lark-cli reported failure";
  }
  const data = envelope.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const code = (data as Record<string, unknown>).code;
    if (typeof code === "number" && code !== 0) {
      return (
        findString(data, "msg") ??
        findString(data, "message") ??
        `Lark API returned code ${code}`
      );
    }
  }
  return undefined;
}

export class LarkCliCardClient {
  private readonly binary: string;
  private readonly credentials: LarkCliCredentials & { brand: LarkCliBrand };
  private readonly executor: LarkCliExecutor;
  private readonly timeoutMs: number;
  private readonly tokenProvider: () => Promise<string>;
  private tenantAccessToken: string | undefined;

  constructor(params: {
    credentials: LarkCliCredentials;
    binary?: string;
    executor?: LarkCliExecutor;
    timeoutMs?: number;
    tokenProvider?: () => Promise<string>;
  }) {
    this.binary = params.binary ?? "lark-cli";
    this.credentials = {
      ...params.credentials,
      brand: params.credentials.brand ?? "feishu",
    };
    this.executor = params.executor ?? defaultLarkCliExecutor;
    this.timeoutMs = params.timeoutMs ?? 30_000;
    this.tenantAccessToken = params.credentials.tenantAccessToken;
    this.tokenProvider =
      params.tokenProvider ?? (() => this.fetchTenantAccessToken());
  }

  async dryRun(card: CardJson): Promise<LarkCliSmokeResult> {
    const envelope = await this.rawApi({
      stage: "card.create.dry-run",
      method: "POST",
      path: "/open-apis/cardkit/v1/cards",
      data: {
        type: "card_json",
        data: JSON.stringify(card),
      },
      dryRun: true,
    });
    return { dryRun: true, request: envelope.data ?? envelope };
  }

  async smoke(params: {
    card: CardJson;
    conversationId: string;
    finalContent: string;
  }): Promise<LarkCliSmokeResult> {
    if (!params.conversationId.trim()) {
      throw new LarkCliError({
        stage: "input",
        message: "conversationId is required for a live CardKit smoke test",
      });
    }

    const created = await this.rawApi({
      stage: "card.create",
      method: "POST",
      path: "/open-apis/cardkit/v1/cards",
      data: {
        type: "card_json",
        data: JSON.stringify(params.card),
      },
    });
    const cardId = findString(created, "card_id");
    if (!cardId) {
      throw new LarkCliError({
        stage: "card.create",
        message: "CardKit create response did not contain card_id",
        detail: created,
      });
    }

    const sent = await this.rawApi({
      stage: "message.send",
      method: "POST",
      path: "/open-apis/im/v1/messages",
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: params.conversationId,
        msg_type: "interactive",
        content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
      },
    });
    const messageId = findString(sent, "message_id");

    await this.rawApi({
      stage: "card.update",
      method: "PUT",
      path: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/elements/content/content`,
      data: {
        content: params.finalContent,
        sequence: 2,
        uuid: `smoke_update_${Date.now()}`,
      },
    });

    await this.rawApi({
      stage: "card.close",
      method: "PATCH",
      path: `/open-apis/cardkit/v1/cards/${encodeURIComponent(cardId)}/settings`,
      data: {
        settings: JSON.stringify({
          config: {
            streaming_mode: false,
            summary: { content: "CardKit smoke test passed" },
          },
        }),
        sequence: 3,
        uuid: `smoke_close_${Date.now()}`,
      },
    });

    return {
      dryRun: false,
      cardId,
      ...(messageId ? { messageId } : {}),
    };
  }

  private async rawApi(params: {
    stage: string;
    method: "POST" | "PUT" | "PATCH";
    path: string;
    params?: Record<string, unknown>;
    data: Record<string, unknown>;
    dryRun?: boolean;
  }): Promise<Record<string, unknown>> {
    const args = [
      "api",
      params.method,
      params.path,
      "--as",
      "bot",
      "--format",
      "json",
      "--data",
      JSON.stringify(params.data),
    ];
    if (params.params) {
      args.push("--params", JSON.stringify(params.params));
    }
    if (params.dryRun) {
      args.push("--dry-run");
    }
    const tenantAccessToken = params.dryRun
      ? this.tenantAccessToken
      : await this.resolveTenantAccessToken(params.stage);
    const result = await this.executor.run(this.binary, args, {
      timeoutMs: this.timeoutMs,
      env: {
        ...process.env,
        LARKSUITE_CLI_APP_ID: this.credentials.appId,
        LARKSUITE_CLI_APP_SECRET: this.credentials.appSecret,
        LARKSUITE_CLI_BRAND: this.credentials.brand,
        ...(tenantAccessToken
          ? { LARKSUITE_CLI_TENANT_ACCESS_TOKEN: tenantAccessToken }
          : {}),
        LARKSUITE_CLI_DEFAULT_AS: "bot",
        LARKSUITE_CLI_STRICT_MODE: "bot",
        LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
        LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
      },
    });
    if (result.exitCode !== 0) {
      throw new LarkCliError({
        stage: params.stage,
        message: result.stderr.trim() || "lark-cli command failed",
        exitCode: result.exitCode,
      });
    }
    const envelope = parseEnvelope(result.stdout, params.stage);
    const failure = apiFailure(envelope);
    if (failure) {
      throw new LarkCliError({
        stage: params.stage,
        message: failure,
        detail: envelope,
      });
    }
    return envelope;
  }

  private async resolveTenantAccessToken(stage: string): Promise<string> {
    if (this.tenantAccessToken) return this.tenantAccessToken;
    try {
      const token = await this.tokenProvider();
      if (!token) throw new Error("token provider returned an empty token");
      this.tenantAccessToken = token;
      return token;
    } catch (error: unknown) {
      throw new LarkCliError({
        stage: `${stage}.authentication`,
        message:
          error instanceof Error
            ? error.message
            : "tenant access token request failed",
        cause: error,
      });
    }
  }

  private async fetchTenantAccessToken(): Promise<string> {
    const accountsBase =
      this.credentials.brand === "lark"
        ? "https://accounts.larksuite.com"
        : "https://accounts.feishu.cn";
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: this.credentials.appId,
      client_secret: this.credentials.appSecret,
    });
    const response = await fetch(`${accountsBase}/oauth/v3/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const result = (await response.json()) as {
      code?: number;
      access_token?: string;
      error?: string;
      error_description?: string;
      msg?: string;
    };
    if (!response.ok || result.code !== 0 || !result.access_token) {
      throw new Error(
        result.error_description ??
          result.msg ??
          result.error ??
          `tenant token endpoint returned HTTP ${response.status}`,
      );
    }
    return result.access_token;
  }
}
