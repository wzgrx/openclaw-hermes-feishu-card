#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";

const pluginId = "openclaw-hermes-feishu-card";
const larkPluginId = "openclaw-lark";
const pluginOnly = process.argv.includes("--plugin-only");
const expectedHooks = [
  "after_tool_call",
  "before_tool_call",
  "gateway_stop",
  "message_received",
  "reply_payload_sending",
];
const root = resolve(import.meta.dirname, "..");
const larkRoot = realpathSync(
  resolve(root, "node_modules", "@larksuite", "openclaw-lark"),
);
const stateDir = mkdtempSync(resolve(root, ".hfc-openclaw-compat-"));
const larkFixture = resolve(stateDir, "openclaw-lark");
const configPath = resolve(stateDir, "openclaw.json");
const openclawEntry = resolve(root, "node_modules", "openclaw", "openclaw.mjs");

try {
  // OpenClaw rejects hard-linked manifests. pnpm's store uses hard links, so
  // use an ordinary copy while retaining the repo as a dependency ancestor.
  if (!pluginOnly) {
    cpSync(larkRoot, larkFixture, { recursive: true, dereference: true });
  }

  writeFileSync(
    configPath,
    JSON.stringify(
      {
        plugins: {
          load: { paths: pluginOnly ? [root] : [larkFixture, root] },
          entries: {
            ...(!pluginOnly ? { [larkPluginId]: { enabled: true } } : {}),
            [pluginId]: { enabled: true },
          },
        },
      },
      null,
      2,
    ),
  );

  const inspect = (id) =>
    JSON.parse(
      execFileSync(
        process.execPath,
        [openclawEntry, "plugins", "inspect", id, "--runtime", "--json"],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            NODE_PATH: resolve(root, "node_modules", ".pnpm", "node_modules"),
            OPENCLAW_CONFIG_PATH: configPath,
            OPENCLAW_STATE_DIR: stateDir,
            OPENCLAW_WORKSPACE_DIR: resolve(stateDir, "workspace"),
          },
          stdio: ["ignore", "pipe", "inherit"],
        },
      ),
    );

  const details = inspect(pluginId);
  const hooks = [...(details.typedHooks ?? [])].map((hook) => hook.name).sort();

  if (details.plugin?.status !== "loaded") {
    throw new Error(
      `expected loaded status, received ${details.plugin?.status}`,
    );
  }
  if (details.plugin?.imported !== true) {
    throw new Error("runtime import did not complete");
  }
  if (details.plugin?.hookCount !== expectedHooks.length) {
    throw new Error(
      `expected ${expectedHooks.length} hooks, received ${details.plugin?.hookCount}`,
    );
  }
  if (JSON.stringify(hooks) !== JSON.stringify(expectedHooks)) {
    throw new Error(`unexpected hook contract: ${JSON.stringify(hooks)}`);
  }
  const replyHook = details.typedHooks.find(
    (hook) => hook.name === "reply_payload_sending",
  );
  if (replyHook?.priority !== 100) {
    throw new Error(
      `expected reply_payload_sending priority 100, received ${replyHook?.priority}`,
    );
  }

  if (pluginOnly) {
    process.stdout.write(
      `OpenClaw runtime compatibility: ${hooks.length} hooks verified (plugin-only)\n`,
    );
  } else {
    const larkDetails = inspect(larkPluginId);
    if (larkDetails.plugin?.status !== "loaded") {
      throw new Error(
        `expected ${larkPluginId} loaded status, received ${larkDetails.plugin?.status}: ${JSON.stringify(larkDetails.plugin?.diagnostics ?? larkDetails.diagnostics)}`,
      );
    }
    if (larkDetails.plugin?.imported !== true) {
      throw new Error(`${larkPluginId} runtime import did not complete`);
    }
    if (!larkDetails.plugin?.channelIds?.includes("feishu")) {
      throw new Error(`${larkPluginId} did not register the feishu channel`);
    }

    process.stdout.write(
      `OpenClaw runtime compatibility: ${hooks.length} hooks and ${larkPluginId} ${larkDetails.plugin.version} coexistence verified\n`,
    );
  }
} finally {
  rmSync(stateDir, { recursive: true, force: true });
}
