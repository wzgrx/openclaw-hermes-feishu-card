# 配置

## OpenClaw

完整示例见 [`examples/openclaw.jsonc`](../examples/openclaw.jsonc)。

```jsonc
{
  "channels": {
    "feishu": {
      "enabled": true,
      "streaming": false,
    },
  },
  "plugins": {
    "entries": {
      "openclaw-feishu-card-footer": {
        "enabled": true,
        "config": {
          "timezone": "Asia/Shanghai",
          "storageDir": "~/.local/share/feishu-card-footer",
          "updateIntervalMs": 800,
        },
      },
    },
  },
}
```

插件从以下位置依次解析飞书凭据：

1. 对应账户的 `channels.feishu.accounts.<accountId>`
2. `channels.feishu`
3. `FEISHU_APP_ID` / `FEISHU_APP_SECRET`

支持 `feishu` 与 `lark` 域。

## Hermes

完整示例见 [`examples/hermes-config.yaml`](../examples/hermes-config.yaml)。

```yaml
platforms:
  feishu:
    enabled: true
    app_id: ${FEISHU_APP_ID}
    app_secret: ${FEISHU_APP_SECRET}
    domain: feishu
    card_footer:
      enabled: true
      timezone: Asia/Shanghai
      storage_dir: ~/.local/share/feishu-card-footer
      update_interval_ms: 800
```

凭据也可放在 `~/.hermes/.env`：

```dotenv
FEISHU_APP_ID=cli_xxx
FEISHU_APP_SECRET=xxx
FEISHU_DOMAIN=feishu
```

## 面板

```yaml
panels:
  reasoning: true
  tools: true
  progress: true
  resources: true
  footer: true
```

## Footer

```yaml
footer:
  status: true
  elapsed: true
  first_token: true
  model: true
  tokens: true
  cache: true
  context: true
  cost: true
  totals: true
```

## 定价

项目不会内置易过期的模型价格。按 `provider/model` 配置 glob 规则：

```yaml
pricing:
  - pattern: openrouter/qwen-*
    currency: USD
    input_per_million: 0.20
    output_per_million: 0.80
    cache_read_per_million: 0.02
    cache_write_per_million: 0.20
```

OpenClaw 使用驼峰字段：`inputPerMillion`、`outputPerMillion`、`cacheReadPerMillion`、`cacheWritePerMillion`。

## 飞书权限

至少启用机器人消息发送与 CardKit 卡片创建/更新所需权限。权限变更后需要重新发布飞书应用版本。实际权限列表以飞书开放平台对当前 SDK/API 的提示为准。
