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
      "openclaw-lark": { "enabled": false },
      "openclaw-hermes-feishu-card": {
        "enabled": true,
        "hooks": { "allowConversationAccess": true },
        "config": {
          "embeddedLark": true,
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

`@larksuite/openclaw-lark` 的飞书入站路径使用通道自有 direct dispatcher，不经过
跨插件 `reply_payload_sending`。因此默认 `embeddedLark: true`：本插件加载并注册
锁定版本的官方通道，再在其 controller 终态注入真实运行指标。独立
`openclaw-lark` 条目必须禁用，避免重复注册 `feishu`；富媒体、审批、交互控件仍由
官方通道代码处理。`reply_payload_sending` 仅覆盖重定向等路由型普通文本路径。
OpenClaw 对非内置插件的 `llm_output` / `agent_end` 设有显式会话访问开关，因此
`hooks.allowConversationAccess` 必须为 `true`；该开关只用于本轮运行指标归并。

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
  progress: false
  resources: false
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
  totals: false
  today_tokens: false
  month_tokens: false
  background_tasks: false
  balance: false
```

旧版两行 Footer 显示状态、耗时、实际模型，以及输入/输出 Token、缓存和上下文。
`first_token`、`cost` 等旧配置键继续解析并参与内部运行指标/账本兼容，不扩展默认 Footer。
主机资源、本地累计、后台任务和余额缓存属于诊断数据，默认隐藏，启用后收进折叠的
“诊断信息”面板。插件本地累计只代表插件成功捕获的回复，不代表供应商账户总量。

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
