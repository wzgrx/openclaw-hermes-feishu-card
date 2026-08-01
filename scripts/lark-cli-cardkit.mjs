#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

function parseArgs(argv) {
  const options = {
    live: false,
    entity: false,
    json: false,
    config: process.env.OPENCLAW_CONFIG_PATH,
    chatId: process.env.FEISHU_CHAT_ID,
    accountId: undefined,
    title: "OpenClaw CardKit",
    text: "lark-cli → CardKit 链路检查通过。",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    else if (arg === "--live") options.live = true;
    else if (arg === "--entity") options.entity = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--config") options.config = argv[++index];
    else if (arg === "--chat-id") options.chatId = argv[++index];
    else if (arg === "--account-id") options.accountId = argv[++index];
    else if (arg === "--title") options.title = argv[++index];
    else if (arg === "--text") options.text = argv[++index];
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: pnpm card:smoke:lark-cli [--entity|--live --chat-id CHAT_ID] [options]",
    "",
    "Without --entity or --live the command performs a CardKit raw-API dry-run.",
    "--entity creates, updates and closes an unsent CardKit entity.",
    "Credentials are read from lark-cli environment variables or OpenClaw config.",
    "",
    "Options:",
    "  --config PATH       OpenClaw config path",
    "  --account-id ID     Feishu account entry to use",
    "  --chat-id CHAT_ID   Target chat for --live",
    "  --title TEXT        Card title",
    "  --text TEXT         Final smoke-test content",
    "  --json              Emit one JSON envelope",
  ].join("\n");
}

function expandHome(value) {
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function pickAccount(feishu, accountId) {
  const accounts = feishu?.accounts;
  if (accounts && typeof accounts === "object") {
    const selectedId = accountId ?? feishu.defaultAccount ?? "default";
    const selected = accounts[selectedId] ?? accounts.default;
    if (selected && typeof selected === "object") {
      return { ...feishu, ...selected, accountId: selectedId };
    }
  }
  return feishu;
}

async function resolveCredentials(options) {
  if (
    process.env.LARKSUITE_CLI_APP_ID &&
    process.env.LARKSUITE_CLI_APP_SECRET
  ) {
    return {
      appId: process.env.LARKSUITE_CLI_APP_ID,
      appSecret: process.env.LARKSUITE_CLI_APP_SECRET,
      brand: process.env.LARKSUITE_CLI_BRAND === "lark" ? "lark" : "feishu",
    };
  }
  const configPath = expandHome(
    options.config ?? path.join(os.homedir(), ".openclaw", "openclaw.json"),
  );
  const config = JSON.parse(await readFile(configPath, "utf8"));
  const account = pickAccount(config.channels?.feishu, options.accountId);
  if (!account?.appId || !account?.appSecret) {
    throw new Error(
      `Feishu app credentials were not found in ${configPath}; set LARKSUITE_CLI_APP_ID and LARKSUITE_CLI_APP_SECRET`,
    );
  }
  return {
    appId: account.appId,
    appSecret: account.appSecret,
    brand: account.domain === "lark" ? "lark" : "feishu",
  };
}

function buildCard(title) {
  return {
    schema: "2.0",
    config: {
      streaming_mode: true,
      summary: { content: "CardKit smoke test" },
      streaming_config: {
        print_frequency_ms: { default: 80 },
        print_step: { default: 2 },
      },
    },
    body: {
      elements: [
        {
          tag: "collapsible_panel",
          expanded: false,
          header: {
            title: {
              tag: "plain_text",
              content: "🛠️ Tool use pending",
              i18n_content: {
                zh_cn: "🛠️ 等待工具执行",
                en_us: "🛠️ Tool use pending",
              },
              text_color: "grey",
              text_size: "notation",
            },
            vertical_align: "center",
            icon: {
              tag: "standard_icon",
              token: "down-small-ccm_outlined",
              color: "grey",
              size: "16px 16px",
            },
            icon_position: "right",
            icon_expanded_angle: -180,
          },
          border: { color: "grey", corner_radius: "5px" },
          vertical_spacing: "4px",
          padding: "8px 8px 8px 8px",
          elements: [],
        },
        {
          tag: "markdown",
          content: `正在验证 ${title}、消息发送和 CardKit 更新链路…`,
          element_id: "content",
          text_size: "normal_v2",
        },
        {
          tag: "markdown",
          element_id: "footer",
          content: "Processing",
          i18n_content: { zh_cn: "处理中", en_us: "Processing" },
          text_size: "notation",
        },
      ],
    },
  };
}

function serializeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  let hint = "Run again with --json to inspect the structured failure stage.";
  if (
    error?.code === "ENOENT" ||
    /not found|is not recognized/i.test(message)
  ) {
    hint = "Install or repair it with: npm install -g @larksuite/cli@latest";
  } else if (
    /token|credential|authentication|forbidden|permission/i.test(message)
  ) {
    hint =
      "Check the Feishu app credentials and CardKit/IM bot permissions, then publish the app version.";
  }
  return {
    type: error?.name ?? "Error",
    stage: error?.stage ?? "startup",
    message,
    ...(typeof error?.exitCode === "number"
      ? { exitCode: error.exitCode }
      : {}),
    hint,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.live && options.entity) {
    throw new Error("--live and --entity are mutually exclusive");
  }
  const root = path.resolve(import.meta.dirname, "..");
  const entry = path.resolve(root, "dist", "lark-cli", "index.mjs");
  const userBin = path.join(os.homedir(), ".local", "bin");
  process.env.PATH = [userBin, process.env.PATH]
    .filter(Boolean)
    .join(path.delimiter);
  try {
    await access(entry);
  } catch {
    throw new Error("dist/lark-cli/index.mjs is missing; run pnpm build first");
  }
  const { LarkCliCardClient } = await import(entry);
  const credentials = await resolveCredentials(options);
  const client = new LarkCliCardClient({ credentials });
  const card = buildCard(options.title);
  const finalContent = `✅ ${options.text}\n\n- 创建卡片：通过\n- 更新卡片：通过\n- 关闭流式模式：通过`;
  const result = options.live
    ? await client.smoke({
        card,
        conversationId: options.chatId ?? "",
        finalContent: `${finalContent}\n- 发送卡片：通过`,
      })
    : options.entity
      ? await client.smokeEntity({ card, finalContent })
      : await client.dryRun(card);
  const envelope = {
    ok: true,
    command: "lark-cli-cardkit-smoke",
    mode: options.live ? "live" : options.entity ? "entity" : "dry-run",
    data: result,
  };
  if (options.json) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stdout.write(
      options.live
        ? `✓ lark-cli CardKit live smoke passed: card=${result.cardId}, message=${result.messageId ?? "unknown"}\n`
        : options.entity
          ? `✓ lark-cli unsent CardKit entity smoke passed: card=${result.cardId}\n`
          : "✓ lark-cli CardKit dry-run passed; use --entity for a real unsent card or --live --chat-id CHAT_ID for an end-to-end card.\n",
    );
  }
}

main().catch((error) => {
  const envelope = { ok: false, error: serializeError(error) };
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(envelope)}\n`);
  } else {
    process.stderr.write(
      `✗ ${envelope.error.stage}: ${envelope.error.message}\n  ${envelope.error.hint}\n`,
    );
  }
  process.exitCode = 1;
});
