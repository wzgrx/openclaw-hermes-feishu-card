# 配置

## OpenClaw

完整示例见 [`examples/openclaw.jsonc`](../examples/openclaw.jsonc)。

```jsonc
{
  "channels": {
    "feishu": {
      "enabled": true,
      "streaming": true,
      "replyMode": "streaming",
      "blockStreaming": false,
    },
  },
  "plugins": {
    "entries": {
      "openclaw-hermes-feishu-card": {
        "enabled": true,
        "config": {
          "title": "OpenClaw",
          "accountTitles": {
            "work": "工作龙虾",
          },
          "timezone": "Asia/Shanghai",
          "storageDir": "~/.local/share/openclaw-hermes-feishu-card",
          "legacyTaskDir": "/tmp/openclaw-tasks",
          "balanceCachePath": "~/.openclaw/data/balance-cache.json",
          "updateIntervalMs": 800,
        },
      },
    },
  },
}
```

`@larksuite/openclaw-lark` 2026.7.x 的入站路径直接调用旧版 reply
dispatcher，不会安装跨插件的 `reply_payload_sending` 修改器。因此该组合必须保留
上游通道的 CardKit controller：`streaming=true` 且
`replyMode="streaming"`。本插件对支持标准 routed delivery 的通道继续使用原生
Hook 接管；遇到富媒体或上游原生卡片时自动 fail-open，避免重复消息。

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
      title: Hermes
      timezone: Asia/Shanghai
      storage_dir: ~/.local/share/openclaw-hermes-feishu-card
      legacy_task_dir: /tmp/openclaw-tasks
      balance_cache_path: ~/.openclaw/data/balance-cache.json
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
  today_tokens: true
  month_tokens: true
  background_tasks: true
  balance: true
```

OpenClaw 使用对应驼峰字段。后台任务读取 `/tmp/openclaw-tasks/*.json`，
余额读取 `balance-cache.json`；读取器限制文件数和单文件大小，异常数据会被忽略。
可用 `pnpm balance:check` 从当前 OpenClaw 配置刷新受支持供应商的余额缓存，
脚本不会输出 API Key。

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
