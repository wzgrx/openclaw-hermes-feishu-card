import {
  buildJsonPluginConfigSchema,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/core";

import manifest from "../openclaw.plugin.json" with { type: "json" };

import { resolveConfig } from "./core/config.js";
import { OpenClawCardBridge } from "./openclaw/bridge.js";
import { NativeLarkIntegration } from "./openclaw/native-lark.js";

const plugin: OpenClawPluginDefinition = {
  id: "openclaw-hermes-feishu-card",
  name: "OpenClaw Hermes Feishu Card",
  description:
    "Feishu CardKit streaming cards with tool progress, resource usage and token totals",
  configSchema: buildJsonPluginConfigSchema(manifest.configSchema),
  register(api: OpenClawPluginApi): void {
    const config = resolveConfig(api.pluginConfig);
    if (!config.enabled) {
      api.logger.info(
        "[openclaw-hermes-feishu-card] disabled by configuration",
      );
      return;
    }
    const nativeLark = new NativeLarkIntegration(api, config);
    nativeLark.register();
    const bridge = new OpenClawCardBridge({ api, config });
    bridge.register();
    api.logger.info(
      `[openclaw-hermes-feishu-card] active for channels: ${config.captureChannels.join(", ")}`,
    );
  },
};

export default plugin;
export * from "./core/index.js";
