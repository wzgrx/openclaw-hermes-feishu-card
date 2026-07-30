import type { OpenClawPluginApi } from "openclaw/plugin-sdk";
import { buildJsonPluginConfigSchema } from "openclaw/plugin-sdk/core";

import manifest from "../openclaw.plugin.json" with { type: "json" };

import { resolveConfig } from "./core/config.js";
import { OpenClawCardBridge } from "./openclaw/bridge.js";

const plugin = {
  id: "openclaw-feishu-card-footer",
  name: "OpenClaw Feishu Card Footer",
  description:
    "Feishu CardKit streaming cards with tool progress, resource usage and token totals",
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api: OpenClawPluginApi): void {
    const config = resolveConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info(
        "[openclaw-feishu-card-footer] disabled by configuration",
      );
      return;
    }
    const bridge = new OpenClawCardBridge({ api, config });
    bridge.register();
    api.logger.info(
      `[openclaw-feishu-card-footer] active for channels: ${config.captureChannels.join(", ")}`,
    );
  },
};

export default plugin;
export * from "./core/index.js";
