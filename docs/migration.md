# 从旧版迁移

## 仓库和插件名称

统一仓库、npm/Python 包和 OpenClaw 插件 ID 为
`openclaw-hermes-feishu-card`。安装脚本会迁移并清理旧插件 ID
`openclaw-feishu-card-footer`，并在新数据目录不存在时迁移旧的
`~/.local/share/openclaw-feishu-card-footer`。

以下兼容入口继续保留一个迁移周期：

- Python 导入 `hermes_feishu_card_footer`
- CLI `hermes-feishu-card-footer`
- 环境变量 `FEISHU_CARD_FOOTER_HOME`
- Hermes 旧版 `card.title`、`card.max_wait_ms`、`card.footer_fields`

## 从 hermes-lark-streaming 迁移

旧版 `hermes-lark-streaming` 会修改 Hermes 的 `gateway/run.py` 与
`cron/scheduler.py`。本项目改用平台注册和生命周期 Hook，不需要这些补丁。
`scripts/install-wsl.sh --hermes` 会调用旧包自带的 `uninstall` 命令、停用旧
插件，并在安装前检查补丁标记已经清理。

手动迁移：

```bash
HERMES_BIN="$(readlink -f "$(command -v hermes)")"
HERMES_PYTHON="$(dirname "$HERMES_BIN")/python"
"$HERMES_PYTHON" -m hermes_lark_streaming uninstall
hermes plugins disable hermes-lark-streaming
```

## 架构变化

旧版常见方案会复制或修改 `openclaw-lark` 文件，或者启动独立 Python sidecar。新版改为：

- OpenClaw 公开 Hook 插件
- Hermes 原生 Feishu 平台适配器子类
- 两端共享 CardKit 展示规范和用量账本

升级 OpenClaw、`@larksuite/openclaw-lark` 或 Hermes 时，不再重复覆盖上游源码。

## 迁移步骤

1. 备份 `~/.openclaw/openclaw.json`、`~/.hermes/config.yaml` 和原 systemd user unit。
2. 停止旧的 `openclaw-hermes-card` / footer sidecar unit。
3. 恢复被旧脚本修改过的 `@larksuite/openclaw-lark` 安装。
4. 构建并安装本仓库的 OpenClaw 插件。
5. 安装 `feishu-platform` Hermes 用户插件。
6. 合并 `examples/` 中的配置。
7. 分别运行 `openclaw plugins doctor`、`hermes plugins list`。
8. 重启两个 gateway，并发送一条包含工具调用的测试消息。

## 两个旧仓库的迁移结果

`wzgrx/hermes-feishu-streaming-card` 的多机器人路由、标题优先级、思考标签、
流式与 cron 卡片、附件摘要、表格限制、严格序列和 fail-open 已合入新状态机。

`wzgrx/openclaw-hermes-card` 的资源/GPU、任务进度、今日/月度累计、
供应商余额与费用展示已移植。旧项目采用的上游源码覆盖、Python sidecar 和
进度 HTTP 服务由原生 OpenClaw Hook、Hermes 平台适配器和受限本地缓存读取取代。

## 回滚

OpenClaw：

```bash
openclaw plugins disable openclaw-hermes-feishu-card
openclaw gateway restart
```

Hermes：

```bash
hermes plugins disable feishu-platform
hermes gateway restart
```

禁用 Hermes 用户插件后，Hermes 会重新使用内置的 Feishu 平台实现。
