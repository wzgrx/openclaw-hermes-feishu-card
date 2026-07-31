# OpenClaw / Hermes 飞书 CardKit 插件

[English](README.en.md) · [架构](docs/architecture.md) · [配置](docs/configuration.md) · [兼容性](docs/compatibility.md) · [维护](docs/maintenance.md) · [迁移](docs/migration.md)

一个仓库、两套原生集成：

- **OpenClaw / 龙虾**：TypeScript 插件，通过公开 Hook 接管飞书文本回复，使用 CardKit 2.0 创建和更新同一张卡片。
- **Hermes Agent**：Python 平台插件，继承 Hermes 原生 `FeishuAdapter`，保留 WebSocket、权限、附件、线程和命令能力，只替换回答的展示层。

它把回答、工具步骤、任务进度、思考摘要、主机资源、模型、Token、缓存、上下文和费用统计集中在一张流式卡片中。

## 设计特点

- 不复制、不覆盖 `@larksuite/openclaw-lark` 或 Hermes 源码。
- CardKit 2.0 全量更新，严格递增 `sequence`，结束时关闭流式状态。
- 投递失败时保留上游原生文本链路。
- 工具进度与回答共用卡片；媒体、审批、文件、语音继续走原生通道。
- OpenClaw 与 Hermes 可写入同一份追加式 `usage.ndjson`。
- App Secret 只从现有运行时配置或环境变量读取，日志中不输出凭据。
- 中文/英文卡片标题与摘要，默认时区为 `Asia/Shanghai`。

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
openclaw plugins enable openclaw-feishu-card-footer
openclaw plugins doctor
```

将 [`examples/openclaw.jsonc`](examples/openclaw.jsonc) 合并到 `~/.openclaw/openclaw.json`。建议把飞书原通道的 `streaming` 设为 `false`，由本插件统一渲染卡片。

### 3. 安装到 Hermes

仓库发布后：

```bash
hermes plugins install wzgrx/openclaw-feishu-card-footer --enable
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
"$HERMES_PYTHON" -m hermes_feishu_card_footer.cli doctor
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
plugins.entries.openclaw-feishu-card-footer.config
```

Hermes 插件配置位于：

```text
platforms.feishu.card_footer
```

两个运行时使用相同概念：

- `storageDir` / `storage_dir`
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
.venv/bin/mypy hermes_feishu_card_footer
.venv/bin/pytest
```

## 仓库结构

```text
src/core/                       共享 TypeScript 状态、定价、账本与渲染
src/openclaw/                   OpenClaw Hook 与 Feishu Node SDK 桥接
hermes_feishu_card_footer/      Hermes 平台适配器与 CardKit Python SDK 桥接
tests/                          TypeScript 单元测试
tests_py/                       Python 单元测试
examples/                       两端配置示例
scripts/                        WSL 安装、诊断与校验脚本
docs/                           架构、迁移、兼容与测试说明
```

## 参考实现

重构吸收了以下项目的成熟设计，但重新实现了状态层和双运行时适配：

- [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)
- [Cheerwhy/hermes-lark-streaming](https://github.com/Cheerwhy/hermes-lark-streaming)
- [baileyh8/hermes-feishu-streaming-card](https://github.com/baileyh8/hermes-feishu-streaming-card)
- [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent)
- [openclaw/openclaw](https://github.com/openclaw/openclaw)

## License

MIT
