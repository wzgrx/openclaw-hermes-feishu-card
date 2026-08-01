#!/usr/bin/env node
import { execFile } from "node:child_process";
import { constants, existsSync, globSync } from "node:fs";
import {
  access,
  copyFile,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path, { resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PLUGIN_ID = "openclaw-hermes-feishu-card";
const NATIVE_FOOTER_KEYS = [
  "status",
  "elapsed",
  "tokens",
  "cache",
  "context",
  "model",
];

function parseArgs(argv) {
  const options = {
    runtime: false,
    fix: false,
    json: false,
    config: process.env.OPENCLAW_CONFIG_PATH,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    else if (arg === "--runtime") options.runtime = true;
    else if (arg === "--fix") {
      options.fix = true;
      options.runtime = true;
    } else if (arg === "--json") options.json = true;
    else if (arg === "--config") options.config = argv[++index];
    else if (arg === "-h" || arg === "--help") options.help = true;
    else throw new Error(`unknown option: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    "Usage: pnpm run doctor -- [--runtime] [--fix] [--json] [--config PATH]",
    "",
    "  --runtime  Inspect the active OpenClaw + Feishu + lark-cli chain",
    "  --fix      Back up and repair CardKit runtime settings",
    "  --json     Emit one machine-readable JSON envelope",
  ].join("\n");
}

function expandHome(value) {
  if (!value || value === "~") return os.homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

function selectedAccount(feishu) {
  if (!feishu || typeof feishu !== "object") return undefined;
  const accounts = feishu.accounts;
  if (accounts && typeof accounts === "object") {
    const accountId = feishu.defaultAccount ?? "default";
    const account = accounts[accountId] ?? accounts.default;
    if (account && typeof account === "object") {
      return { ...feishu, ...account };
    }
  }
  return feishu;
}

function applyRuntimeFix(config, root) {
  config.channels ??= {};
  config.channels.feishu ??= {};
  const feishu = config.channels.feishu;
  feishu.streaming = true;
  feishu.replyMode = "streaming";
  feishu.blockStreaming = false;

  config.plugins ??= {};
  config.plugins.entries ??= {};
  const entry = config.plugins.entries[PLUGIN_ID] ?? {};
  entry.enabled = true;
  entry.hooks ??= {};
  entry.hooks.allowConversationAccess = true;
  entry.config ??= {};
  entry.config.enabled = true;
  entry.config.embeddedLark = true;
  const captures = Array.isArray(entry.config.captureChannels)
    ? entry.config.captureChannels
    : [];
  entry.config.captureChannels = [
    ...new Set([...captures, "feishu", "openclaw-lark"]),
  ];
  entry.config.footer ??= {};
  feishu.footer ??= {};
  for (const key of NATIVE_FOOTER_KEYS) {
    const enabled = entry.config.footer[key] ?? true;
    entry.config.footer[key] = enabled;
    feishu.footer[key] = enabled;
  }
  config.plugins.entries[PLUGIN_ID] = entry;
  config.plugins.entries["openclaw-lark"] = {
    ...(config.plugins.entries["openclaw-lark"] ?? {}),
    enabled: false,
  };
  if (Array.isArray(config.plugins.allow)) {
    config.plugins.allow = [
      ...new Set(
        config.plugins.allow
          .filter((id) => id !== "openclaw-lark")
          .concat(PLUGIN_ID),
      ),
    ];
  }
  config.plugins.load ??= {};
  config.plugins.load.paths ??= [];
  if (!config.plugins.load.paths.includes(root)) {
    config.plugins.load.paths.push(root);
  }
  if (config.session?.store === "~/.openclaw/sessions/store.json") {
    delete config.session.store;
    if (Object.keys(config.session).length === 0) delete config.session;
  }
}

function resolveLarkCliBinary() {
  const command = process.platform === "win32" ? "lark-cli.cmd" : "lark-cli";
  const candidates = [
    process.env.LARKSUITE_CLI_BIN,
    path.join(os.homedir(), ".volta", "bin", command),
    ...globSync(
      path.join(os.homedir(), ".nvm", "versions", "node", "*", "bin", command),
    ).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    ),
    ...globSync(
      path.join(
        os.homedir(),
        ".local",
        "share",
        "southplus",
        "tools",
        "node",
        "*",
        "bin",
        command,
      ),
    ).sort((left, right) =>
      right.localeCompare(left, undefined, { numeric: true }),
    ),
  ];
  return (
    candidates.find((candidate) => candidate && existsSync(candidate)) ??
    command
  );
}

async function larkCliProbe(account) {
  const accountsBase =
    account.domain === "lark"
      ? "https://accounts.larksuite.com"
      : "https://accounts.feishu.cn";
  const tokenResponse = await fetch(`${accountsBase}/oauth/v3/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: account.appId,
      client_secret: account.appSecret,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const tokenEnvelope = await tokenResponse.json();
  if (
    !tokenResponse.ok ||
    tokenEnvelope.code !== 0 ||
    !tokenEnvelope.access_token
  ) {
    throw new Error(
      tokenEnvelope.error_description ??
        tokenEnvelope.msg ??
        tokenEnvelope.error ??
        `tenant token endpoint returned HTTP ${tokenResponse.status}`,
    );
  }
  const environment = {
    ...process.env,
    LARKSUITE_CLI_APP_ID: account.appId,
    LARKSUITE_CLI_APP_SECRET: account.appSecret,
    LARKSUITE_CLI_BRAND: account.domain === "lark" ? "lark" : "feishu",
    LARKSUITE_CLI_TENANT_ACCESS_TOKEN: tokenEnvelope.access_token,
    LARKSUITE_CLI_DEFAULT_AS: "bot",
    LARKSUITE_CLI_STRICT_MODE: "bot",
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: "1",
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: "1",
  };
  const larkCli = resolveLarkCliBinary();
  const versionResult = await execFileAsync(larkCli, ["--version"], {
    env: environment,
    timeout: 20_000,
    windowsHide: true,
  });
  const card = {
    schema: "2.0",
    config: {
      streaming_mode: false,
      summary: { content: "doctor" },
    },
    body: {
      elements: [{ tag: "markdown", content: "doctor", element_id: "content" }],
    },
  };
  const data = JSON.stringify({
    type: "card_json",
    data: JSON.stringify(card),
  });
  const probeResult = await execFileAsync(
    larkCli,
    [
      "api",
      "POST",
      "/open-apis/cardkit/v1/cards",
      "--as",
      "bot",
      "--format",
      "json",
      "--dry-run",
      "--data",
      data,
    ],
    {
      env: environment,
      timeout: 20_000,
      maxBuffer: 2 * 1024 * 1024,
      windowsHide: true,
    },
  );
  const envelope = JSON.parse(probeResult.stdout);
  if (envelope.ok !== true || envelope.dry_run !== true) {
    throw new Error("CardKit raw API dry-run returned an unexpected envelope");
  }
  return versionResult.stdout.trim();
}

const options = parseArgs(process.argv.slice(2));
if (options.help) {
  process.stdout.write(`${usage()}\n`);
  process.exit(0);
}

const root = resolve(import.meta.dirname, "..");
const packageJson = JSON.parse(
  await readFile(resolve(root, "package.json"), "utf8"),
);
const manifest = JSON.parse(
  await readFile(resolve(root, "openclaw.plugin.json"), "utf8"),
);
const hermesManifest = await readFile(resolve(root, "plugin.yaml"), "utf8");
const packagedHermesManifest = await readFile(
  resolve(root, "openclaw_hermes_feishu_card", "plugin.yaml"),
  "utf8",
);
const pythonPackage = await readFile(
  resolve(root, "openclaw_hermes_feishu_card", "__init__.py"),
  "utf8",
);
const checks = [];

function check(name, ok, detail, hint) {
  checks.push({
    name,
    ok,
    detail,
    ...(ok || !hint ? {} : { hint }),
  });
}

check(
  "OpenClaw version parity",
  packageJson.version === manifest.version,
  `${packageJson.version} / ${manifest.version}`,
);
const yamlVersion = hermesManifest.match(/^version:\s*(\S+)\s*$/m)?.[1];
const packagedYamlVersion = packagedHermesManifest.match(
  /^version:\s*(\S+)\s*$/m,
)?.[1];
const pythonVersion = pythonPackage.match(
  /^__version__\s*=\s*["']([^"']+)["']\s*$/m,
)?.[1];
check(
  "Hermes version parity",
  [yamlVersion, packagedYamlVersion, pythonVersion].every(
    (version) => version === packageJson.version,
  ),
  `${packageJson.version} / ${yamlVersion ?? "missing"} / ${packagedYamlVersion ?? "missing"} / ${pythonVersion ?? "missing"}`,
);
check(
  "Hermes manifest copy",
  hermesManifest === packagedHermesManifest,
  hermesManifest === packagedHermesManifest ? "identical" : "out of sync",
);
check("plugin id", packageJson.name === manifest.id, manifest.id);
check(
  "gateway startup activation",
  manifest.activation?.onStartup === true,
  String(manifest.activation?.onStartup ?? false),
  "Set openclaw.plugin.json activation.onStartup=true",
);

for (const file of [
  "dist/index.mjs",
  "dist/index.d.mts",
  "dist/lark-cli/index.mjs",
  "dist/lark-cli/index.d.mts",
  "openclaw.plugin.json",
  "plugin.yaml",
  "__init__.py",
  "openclaw_hermes_feishu_card/__init__.py",
]) {
  try {
    await access(resolve(root, file), constants.R_OK);
    check(file, true, "present");
  } catch {
    check(
      file,
      false,
      "missing",
      "Run pnpm build when this is a dist artifact",
    );
  }
}

let configPath;
let backupPath;
if (options.runtime) {
  configPath = expandHome(
    options.config ?? path.join(os.homedir(), ".openclaw", "openclaw.json"),
  );
  try {
    const config = JSON.parse(await readFile(configPath, "utf8"));
    if (options.fix) {
      backupPath = `${configPath}.bak.card-doctor.${new Date()
        .toISOString()
        .replaceAll(/[:.]/g, "-")}`;
      await copyFile(configPath, backupPath);
      applyRuntimeFix(config, root);
      const temporary = `${configPath}.tmp.${process.pid}`;
      await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, {
        mode: 0o600,
      });
      await rename(temporary, configPath);
    }

    const activeConfig = options.fix
      ? JSON.parse(await readFile(configPath, "utf8"))
      : config;
    const feishu = activeConfig.channels?.feishu;
    const account = selectedAccount(feishu);
    const pluginEntry = activeConfig.plugins?.entries?.[PLUGIN_ID];
    const externalLarkEntry = activeConfig.plugins?.entries?.["openclaw-lark"];
    const captures = pluginEntry?.config?.captureChannels;
    check("runtime config", true, configPath);
    check(
      "plugin enabled",
      pluginEntry?.enabled === true && pluginEntry?.config?.enabled !== false,
      String(pluginEntry?.enabled ?? false),
      "Run pnpm run doctor -- --fix --runtime",
    );
    check(
      "conversation metrics hooks",
      pluginEntry?.hooks?.allowConversationAccess === true,
      `allowConversationAccess=${String(pluginEntry?.hooks?.allowConversationAccess)}`,
      "Run pnpm run doctor -- --fix --runtime",
    );
    check(
      "integrated Feishu channel",
      pluginEntry?.config?.embeddedLark === true &&
        externalLarkEntry?.enabled === false,
      `embeddedLark=${String(pluginEntry?.config?.embeddedLark)}, external=${String(externalLarkEntry?.enabled)}`,
      "Run pnpm run doctor -- --fix --runtime",
    );
    check(
      "Feishu native CardKit mode",
      feishu?.streaming === true &&
        feishu?.replyMode === "streaming" &&
        feishu?.blockStreaming === false,
      `streaming=${String(feishu?.streaming)}, replyMode=${String(feishu?.replyMode)}, blockStreaming=${String(feishu?.blockStreaming)}`,
      "Run pnpm run doctor -- --fix --runtime",
    );
    check(
      "capture channels",
      Array.isArray(captures) &&
        captures.includes("feishu") &&
        captures.includes("openclaw-lark"),
      Array.isArray(captures) ? captures.join(", ") : "missing",
      "Run pnpm run doctor -- --fix --runtime",
    );
    const footerState = Object.fromEntries(
      NATIVE_FOOTER_KEYS.map((key) => [key, feishu?.footer?.[key]]),
    );
    check(
      "native footer compatibility",
      NATIVE_FOOTER_KEYS.every(
        (key) => typeof feishu?.footer?.[key] === "boolean",
      ),
      NATIVE_FOOTER_KEYS.map(
        (key) => `${key}=${String(footerState[key])}`,
      ).join(", "),
      "Run pnpm run doctor -- --fix --runtime",
    );
    check(
      "Feishu credentials",
      typeof account?.appId === "string" &&
        account.appId.length > 0 &&
        typeof account?.appSecret === "string" &&
        account.appSecret.length > 0,
      account?.appId && account?.appSecret ? "present (redacted)" : "missing",
      "Configure channels.feishu app credentials",
    );
    if (account?.appId && account?.appSecret) {
      try {
        const version = await larkCliProbe(account);
        check(
          "lark-cli CardKit raw API",
          true,
          `${version}; tenant token and dry-run passed`,
        );
      } catch (error) {
        check(
          "lark-cli CardKit raw API",
          false,
          error instanceof Error ? error.message : String(error),
          "Install or repair with npm install -g @larksuite/cli@latest",
        );
      }
    }
  } catch (error) {
    check(
      "runtime config",
      false,
      error instanceof Error ? error.message : String(error),
      "Pass --config PATH or create ~/.openclaw/openclaw.json",
    );
  }
}

const ok = checks.every((item) => item.ok);
if (options.json) {
  process.stdout.write(
    `${JSON.stringify({
      ok,
      command: "openclaw-hermes-feishu-card doctor",
      ...(configPath ? { configPath } : {}),
      ...(backupPath ? { backupPath } : {}),
      checks,
    })}\n`,
  );
} else {
  for (const item of checks) {
    process.stdout.write(
      `${item.ok ? "✓" : "✗"} ${item.name}: ${item.detail}\n`,
    );
    if (item.hint) process.stdout.write(`  hint: ${item.hint}\n`);
  }
  if (backupPath) process.stdout.write(`✓ backup: ${backupPath}\n`);
}
if (!ok) process.exitCode = 1;
