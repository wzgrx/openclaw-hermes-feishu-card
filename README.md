# OpenClaw / Hermes 飞书 CardKit 插件

[English](README.en.md) · [架构](docs/architecture.md) · [配置](docs/configuration.md) · [兼容性](docs/compatibility.md) · [维护](docs/maintenance.md) · [迁移](docs/migration.md)

一个仓库、两套原生集成和一条官方 CLI 验证链路：

- **OpenClaw / 龙虾**：TypeScript 插件，通过公开 Hook 接管飞书文本回复，使用 CardKit 2.0 创建和更新同一张卡片。
- **Hermes Agent**：Python 平台插件，继承 Hermes 原生 `FeishuAdapter`，保留 WebSocket、权限、附件、线程和命令能力，只替换回答的展示层。
- **lark-cli**：调用官方 `larksuite/cli` 的 raw API 层，提供凭据不进入命令行参数的 CardKit dry-run 和端到端烟雾测试。

它把回答、工具步骤、任务进度、思考摘要、主机资源、模型、Token、缓存、上下文和费用统计集中在一张流式卡片中。

## 设计特点

- 不复制、不覆盖 `@larksuite/openclaw-lark` 或 Hermes 源码。
- CardKit 2.0 全量更新，严格递增 `sequence`，结束时关闭流式状态。
- 投递失败时保留上游原生文本链路。
- 工具进度与回答共用卡片；媒体、审批、文件、语音继续走原生通道。
- 供应商与模型分栏显示；回退时同时展示请求模型和实际模型，不把路由名
  误当模型名。
- 上下文使用末次模型调用的真实 Prompt 占用，不使用多工具循环的累计输入量；
  仅有累计值时明确标记为估算。
- OpenClaw 与 Hermes 可写入同一份追加式 `usage.ndjson`。
- 支持多账户卡片标题、附件摘要、GPU、旧版后台任务和供应商余额缓存。
- App Secret 只从现有运行时配置或环境变量读取，日志中不输出凭据。
- 中文/英文卡片标题与摘要，默认时区为 `Asia/Shanghai`。
- `doctor --runtime --fix` 可检测并修复 direct dispatcher、原生 Footer、插件启用和 lark-cli CardKit 路由。

## 兼容基线

| 组件                       | 基线                                    |
| -------------------------- | --------------------------------------- |
| OpenClaw                   | `2026.7.1-2`（兼容 `>=2026.7.1 <2027`） |
| `@larksuite/openclaw-lark` | `2026.7.16`                             |
| Hermes Agent               | `>= 0.19.0, < 0.20`                     |
| Node.js                    | 22 / 24 / 25 的 OpenClaw 支持版本       |
| pnpm                       | `11.18.0`                               |
| TypeScript                 | `6.0.3`（当前工具链最新兼容版）         |
| Python                     | 3.11–3.13                               |
| Feishu Node SDK            | `@larksuiteoapi/node-sdk ^1.72.0`       |
| Feishu Python SDK          | `lark-oapi >=1.6.8,<2`                  |
| lark-cli                   | `@larksuite/cli >=1.0.80`               |

## 快速开始

### 1. 构建

```bash
corepack enable 2>/dev/null || npm install --global pnpm@11.18.0
pnpm install --frozen-lockfile
pnpm check
```

Python：

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e '.[hermes,dev]'
ruff check .
pytest
```

### 2. 安装到 OpenClaw

```bash
pnpm build
openclaw plugins install --link .
openclaw plugins enable openclaw-hermes-feishu-card
openclaw plugins doctor
```

将 [`examples/openclaw.jsonc`](examples/openclaw.jsonc) 合并到 `~/.openclaw/openclaw.json`。使用 `@larksuite/openclaw-lark` 2026.7.x 时，将飞书通道设置为 `streaming: true`、`replyMode: "streaming"`；该版本的旧版 direct dispatcher 由通道原生 CardKit controller 负责最终卡片投递。

运行时诊断和自动修复：

```bash
pnpm run doctor -- --runtime
pnpm run doctor -- --runtime --fix
```

### 2.1 官方 lark-cli CardKit 验证

安装器的 `--openclaw` / `--all` 会补装官方 CLI，也可单独执行：

```bash
bash scripts/install-wsl.sh --lark-cli
pnpm build
pnpm card:smoke:lark-cli                         # 只生成并检查 raw API 请求
pnpm card:smoke:lark-cli -- --live --chat-id oc_xxx # 创建、发送、更新、关闭卡片
```

脚本优先读取 `LARKSUITE_CLI_APP_ID` / `LARKSUITE_CLI_APP_SECRET`，否则复用
`~/.openclaw/openclaw.json` 的飞书应用配置；Secret 只放入子进程环境变量。

### 3. 安装到 Hermes

仓库发布后：

```bash
hermes plugins install wzgrx/openclaw-hermes-feishu-card --enable
HERMES_BIN="$(readlink -f "$(command -v hermes)")"
HERMES_PYTHON="$(dirname "$HERMES_BIN")/python"
"$HERMES_PYTHON" -m pip install -e ~/.hermes/plugins/feishu-platform
hermes plugins list
```

本地 WSL 开发：

```bash
bash scripts/install-wsl.sh --hermes
```

将 [`examples/hermes-config.yaml`](examples/hermes-config.yaml) 合并到 `~/.hermes/config.yaml`，然后：

```bash
hermes gateway restart
"$HERMES_PYTHON" -m openclaw_hermes_feishu_card.cli doctor
```

### 4. 同时安装两端

在 WSL 的仓库目录执行：

```bash
bash scripts/install-wsl.sh --all --restart
```

也可从 Windows PowerShell 执行：

```powershell
.\scripts\install-wsl.ps1 -Target all -Distribution Ubuntu-26.04 -Restart
```

安装脚本优先选择 WSL 内 `nvm` 的 OpenClaw 与当前 `hermes` 可执行文件旁的
Python，避开 Windows PATH 互操作中的同名命令。

## 配置概览

OpenClaw 插件配置位于：

```text
plugins.entries.openclaw-hermes-feishu-card.config
```

Hermes 插件配置位于：

```text
platforms.feishu.card_footer
```

两个运行时使用相同概念：

- `storageDir` / `storage_dir`
- `title`、`accountTitles` / `account_titles`
- `legacyTaskDir` / `legacy_task_dir`
- `balanceCachePath` / `balance_cache_path`
- `timezone`
- `updateIntervalMs` / `update_interval_ms`
- `panels`
- `footer`
- `pricing`

完整字段见 [配置说明](docs/configuration.md)。

## 开发命令

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm compat:openclaw

.venv/bin/ruff check .
.venv/bin/mypy openclaw_hermes_feishu_card
.venv/bin/pytest
```

## 仓库结构

```text
src/core/                       共享 TypeScript 状态、定价、账本与渲染
src/openclaw/                   OpenClaw Hook 与 Feishu Node SDK 桥接
src/lark-cli/                   官方 lark-cli raw API CardKit 传输与诊断
openclaw_hermes_feishu_card/    Hermes 平台适配器与 CardKit Python SDK 桥接
hermes_feishu_card_footer/      旧 Python 导入名和 CLI 的兼容转发层
tests/                          TypeScript 单元测试
tests_py/                       Python 单元测试
examples/                       两端配置示例
scripts/                        WSL 安装、诊断与校验脚本
docs/                           架构、迁移、兼容与测试说明
```

## 参考实现

重构吸收了以下项目的成熟设计，但重新实现了状态层和双运行时适配：

- [wzgrx/hermes-feishu-streaming-card](https://github.com/wzgrx/hermes-feishu-streaming-card)
- [wzgrx/openclaw-hermes-card](https://github.com/wzgrx/openclaw-hermes-card)
- [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)
- [Cheerwhy/hermes-lark-streaming](https://github.com/Cheerwhy/hermes-lark-streaming)
- [baileyh8/hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- [openclaw/openclaw](https://github.com/openclaw/openclaw)
- [larksuite/cli](https://github.com/larksuite/cli)：三层命令、raw API、dry-run、JSON envelope 和环境凭据注入
- [larksuite/node-sdk](https://github.com/larksuite/node-sdk)：官方 CardKit/IM 类型与应用鉴权
- [ET06731/opencode-im-bridge](https://github.com/ET06731/opencode-im-bridge)：串行 CardKit 生命周期、Token 失效重试和本地链接清理思路
- [zeno528/openclaw-lark-streaming-patch](https://github.com/zeno528/openclaw-lark-streaming-patch)：更新队列、节流、重试与熔断设计参考

## License

MIT
