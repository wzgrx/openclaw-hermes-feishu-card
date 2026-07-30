# 从旧版迁移

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

## 回滚

OpenClaw：

```bash
openclaw plugins disable openclaw-feishu-card-footer
openclaw gateway restart
```

Hermes：

```bash
hermes plugins disable feishu-platform
hermes gateway restart
```

禁用 Hermes 用户插件后，Hermes 会重新使用内置的 Feishu 平台实现。
