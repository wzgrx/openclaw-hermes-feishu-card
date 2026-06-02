⚠️ This repository has been archived. All functionality has been merged into [openclaw-hermes-card](https://github.com/wzgrx/openclaw-hermes-card).
# OpenClaw Feishu Card Footer — 飞书卡片页脚增强

[![OpenClaw](https://img.shields.io/badge/OpenClaw-v2026.5.20-blue)](https://openclaw.nousresearch.com)
[![@larksuite/openclaw-lark](https://img.shields.io/badge/%40larksuite%2Fopenclaw--lark-v2026.5.20-green)](https://www.npmjs.com/package/@larksuite/openclaw-lark)
[![Node.js](https://img.shields.io/badge/Node.js-LTS-339933)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**OpenClaw** × **飞书 (Feishu/Lark)** 飞书卡片多面板增强组件。
**适配 OpenClaw 核心 v2026.5.20 + @larksuite/openclaw-lark@2026.5.20。**
提供 4 个可折叠信息面板，覆盖系统资源监控、工具执行进度、Token 统计、费用分解等完整 AI 对话指标。

---

## 📌 版本说明

| 简称 | 全称 | 说明 |
|------|------|------|
| **OpenClaw v5.20** | **OpenClaw 核心** `v2026.5.20` | 当前适配版本 |
| **插件 v2026.5.20** | **`@larksuite/openclaw-lark@2026.5.20`** | 适配 OpenClaw v2026.5.20 |

## 🖥️ 基础环境要求

| 组件 | 要求 |
|------|------|
| **操作系统** | Linux / WSL2 Ubuntu |
| **OpenClaw** | `v2026.5.20` |
| **Node.js** | v24.15+ |
| **飞书插件** | `@larksuite/openclaw-lark@2026.5.20` |

### 插件安装

```bash
npm install -g @larksuite/openclaw-lark@latest
cp -a /path/to/node_modules/@larksuite/openclaw-lark ~/.openclaw/extensions/openclaw-lark
```

## 🎯 功能特性

卡片包含 4 个可折叠信息面板，展开/折叠自由控制：

```
┌─ 🖥️ 系统资源  [可折叠·折叠] ──────────────────┐
│ GPU 利用率 · VRAM · 温度 · CPU · 内存占用      │
│ 进程 · 系统已运行时间                          │
├─ 🛠️ 工具步骤  [可折叠·折叠] ──────────────────┤
│ 工具调用详情（参数、结果、输出）               │
├─ 📊 任务进度  [可折叠·展开] ──────────────────┤
│ ████████████████ 100%                         │
│ 🛠️ 工具执行 · 3 次                            │
│  ■ Search web (1.5s) ✔                        │
│  ■ Edit (2.3s) ✔                              │
├─ [回复内容] ──────────────────────────────────┤
├─ 🪙 deepseek-v4-flash · ¥388.25 [可折叠·折叠] ┤
│ 🪙Token 今/月/总: ...                          │
│ ✅ 已完成 · ⏳️ ...                             │
│ 💸 ¥...                                        │
│ 📑 ...                                         │
│ 💰 ...                                         │
└────────────────────────────────────────────────┘
```

### 面板说明

| 面板 | 内容 | 默认状态 |
|:----|:----|:--------|
| 🖥️ 系统资源 | GPU利用率/显存/温度、CPU、内存、运行时间 | 折叠 |
| 🛠️ 工具步骤 | 工具调用参数、结果、输出（原生功能） | 折叠 |
| 📊 任务进度 | 总进度条 + 百分比 + 每步耗时/状态 | 展开 |
| 🪙 统计信息 | Token统计、费用分解、上下文、模型余额 | 折叠 |

## 🔧 适配方式

本项目采用 **直接源码覆盖** 方式适配。

### 文件清单

**修改的文件：**

| 文件 | 修改内容 |
|------|----------|
| `src/card/builder.js` | 4 面板卡片渲染（系统资源 + 任务进度 + 6-line 页脚 + 全部可折叠） |
| `src/card/streaming-card-controller.js` | `computeToolUseDisplay()` 始终返回步骤数据 |
| `src/card/reply-dispatcher.js` | `onIdle` 确保 complete card 始终构建 |
| `src/card/reply-mode.js` | 群聊启用流式卡片 |
| `src/card/tool-use-trace-store.js` | 新增 `getToolUseTraceStore()` 运行时遍历 |
| `src/channel/event-bus.js` | Token 事件发布总线 |
| `src/channel/token-aggregator.js` | Token 聚合服务 |
| `src/channel/token-aggregator-daemon.js` | Token 聚合守护进程 |
| `src/channel/monitor.js` | TokenAggregator 启动 |
| `src/core/footer-config.js` | 默认值全 `true` |

### 部署步骤

```bash
# 1. 安装最新插件
npm install -g @larksuite/openclaw-lark@latest
cp -a /path/to/node_modules/@larksuite/openclaw-lark ~/.openclaw/extensions/openclaw-lark

# 2. 覆盖源码
# 方式一：手动复制
# cp src/card/*.js ~/.openclaw/extensions/openclaw-lark/src/card/
# cp src/channel/*.js ~/.openclaw/extensions/openclaw-lark/src/channel/  (可选，token统计)
# cp src/core/*.js ~/.openclaw/extensions/openclaw-lark/src/core/  (可选，footer配置)
# 方式二：使用部署脚本 (推荐)
# bash deploy.sh

# 3. 配置 verbose（必须！否则进度面板不显示）
openclaw config set agents.defaults.verboseDefault on

# 4. 重启网关
systemctl --user restart openclaw-gateway
```

# 4. 重启 gateway
systemctl --user restart openclaw-gateway
```

### 快速部署脚本

```bash
# 从 GitHub 拉取并部署
git clone https://github.com/wzgrx/openclaw-feishu-card-footer.git
cd openclaw-feishu-card-footer
cp -r src/* ~/.openclaw/extensions/openclaw-lark/src/
rm -rf ~/.openclaw/extensions/openclaw-lark/node_modules/.cache/jiti/
systemctl --user restart openclaw-gateway
```

## 📊 数据流架构

```
Agent回复 → streaming-card-controller.onIdle()
  ├─ getFooterSessionMetrics() → 读取 session store
  ├─ _publishTokenEvent(footerMetrics)
  │    └─ event-bus.publish → TokenAggregator → token-stats.json
  └─ buildCardContent('complete', { footerMetrics, firstTokenLatencyMs })
       ├─ 读取 ~/.openclaw/token-stats.json（🪙 全局Token统计）
       ├─ 读取 ~/.hermes/data/balance-cache.json（💰 累计费用）
       └─ 渲染 6-line footer → updateCardKitCard()
```

### 配置文件参考

`~/.openclaw/openclaw.json` 中飞书通道配置：

```json
{
  "channels": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "xxx",
      "enabled": true,
      "streaming": true,
      "footer": {
        "status": true,
        "elapsed": true,
        "tokens": true,
        "cache": true,
        "context": true,
        "model": true,
        "cost": true,
        "todayTokens": true,
        "monthTokens": true
      },
      "replyMode": "auto"
    }
  }
}
```

## 🧹 维护

### 更新后清缓存

```bash
rm -rf ~/.openclaw/extensions/openclaw-lark/node_modules/.cache/jiti/
systemctl --user restart openclaw-gateway
```

### 查看日志

```bash
journalctl --user -u openclaw-gateway -f | grep "card\|footer"
```

## 🔄 版本迁移历史

| 时间 | 旧版 | 新版 | 主要变更 |
|------|------|------|----------|
| 2026-05-20 | `2026.5.13` | `2026.5.20-beta.0` | 完整重写适配：新增 `formatFooterRuntimeSegments`、`_publishTokenEvent`、TokenAggregator、群聊流式修复、首token延迟追踪 |
| 2026-05-13 | `2026.4.10` | `2026.5.13` | 安装方式改为 `npx install`，插件路径改为 `extensions/` 目录 |
| 2026-05-07 | `2026.4.10` | `2026.5.7` | 5.7 完整重写，引入 event-bus + token-aggregator 事件链 |
| 2026-05-03 | `v5.6` | `2026.4.10` | 6-line 格式定型，分开 `本次上下文` vs `↑↓ token` |
| 2026-04-xx | `v5.3` | `v5.6` | 新增首token延迟、余额显示、模型注册表 |
| 2026-04-xx | — | `v5.3` | 首个版本：飞书卡片 Footer 增强 |

## 📄 License

MIT
