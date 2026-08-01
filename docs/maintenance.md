# 维护与升级

## 兼容策略

仓库使用“稳定范围 + 真实加载测试 + 上游主干哨兵”三层策略：

1. 发布依赖只接受已验证的兼容系列。
2. 常规 CI 在所有支持的 Node.js 与 Python 版本上执行构建、静态检查、单元测试和运行时加载测试。
3. 每周兼容工作流临时升级 npm 稳定依赖、探测 OpenClaw beta 插件 API，并用 Hermes `main` 源码执行平台插件契约测试；失败会直接体现在 GitHub Actions。

当前发布范围：

| 组件            | 发布范围           | 已验证                                                  |
| --------------- | ------------------ | ------------------------------------------------------- |
| OpenClaw        | `>=2026.7.1 <2027` | npm `2026.7.1-2`                                        |
| openclaw-lark   | `2026.7.16`        | npm `2026.7.16`                                         |
| Hermes Agent    | `>=0.19.0,<0.20`   | PyPI `0.19.0`、源码标签 `v2026.7.30`（Hermes `0.19.1`） |
| 飞书 Node SDK   | `^1.72.0`          | `1.72.0`                                                |
| 飞书 Python SDK | `>=1.6.8,<2`       | `1.6.8`、`1.7.1`                                        |

Hermes `0.19.1` 已发布源码标签，但 PyPI 的最新包仍为 `0.19.0`。Python SDK 下限与 Hermes `0.19.x` 的原生 Feishu extra 对齐，避免安装插件时强制替换宿主已经验证的 SDK。

OpenClaw beta 探针验证本插件的类型、构建、运行时 Hook，以及内置飞书通道的
实际注册。项目自身使用 `openclaw/plugin-sdk/core`；锁定的官方通道依赖仍保留其
兼容导入，由 OpenClaw 当前运行时解析。

内置加载器会把上游 npm 包的 CommonJS `src` 复制到依赖目录中的版本化私有缓存，
只在副本中修正缺失包边界和残留 `import.meta` 的发布格式问题。升级官方通道时
必须先重新执行完整兼容测试，再更新精确版本与转换断言。

## 被监控的接口契约

### OpenClaw

- 插件可被运行时加载并完成模块导入。
- 内置 `@larksuite/openclaw-lark` 并由本插件注册 `feishu` 通道；独立插件条目禁用。
- 本项目注册 `llm_output`、`agent_end`、`message_received`、工具、路由型回复与停止 Hook；官方通道同时注册自己的工具追踪 Hook。
- `llm_output` 为 direct dispatcher 提供真实逐调用用量，`reply_payload_sending` 继续覆盖路由型回复。
- 飞书通道 ID 保持为 `feishu`。

运行：

```bash
pnpm check
pnpm compat:openclaw
pnpm compat:openclaw:beta
```

### Hermes

- 目录插件入口可注册名为 `feishu` 的平台。
- 平台工厂继续返回增强版原生 `FeishuAdapter`。
- 五个 API/工具生命周期 Hook 的名称与顺序保持一致。
- `send`、`edit_message(finalize=True)`、工具分段与最终分段的生命周期保持一致。
- 最终分段关闭 CardKit 流式状态并写入使用量账本。

运行：

```bash
python -m pip install -e '.[hermes,dev]'
python -m pytest tests_py/test_hermes_runtime.py -q
```

## 上游升级清单

1. 查看 OpenClaw、Hermes Agent、`openclaw-lark` 与飞书 SDK 的发布说明。
2. 更新依赖范围与锁文件；主版本保持上界，直到运行时契约测试通过。
3. 执行 `pnpm check`、`pnpm compat:openclaw`、Ruff、Mypy、Pytest 和两种包构建。
4. 对目标 Hermes 标签设置 `PYTHONPATH`，执行 `tests_py/test_hermes_runtime.py`。
5. 在隔离配置中执行 `openclaw plugins inspect ... --runtime --json`。
6. 使用测试飞书应用验证创建、全量更新、严格递增 `sequence`、结束流式状态和文本降级链路。
7. 更新兼容矩阵、变更日志与发行说明，再创建版本标签。

## 版本边界

- Hermes `0.20` 到来时，先核对平台注册、`GatewayStreamConsumer`、`FeishuAdapter` 方法签名和生命周期 Hook。
- OpenClaw `2027.x` 到来时，先核对插件清单、Hook 载荷、回复覆盖语义和通道插件 API。
- 飞书 SDK 主版本升级时，重点核对 CardKit 创建、更新、流式设置与消息卡片引用接口。
- 保留依赖上界的目的，是让不兼容升级在安装阶段可见，而不是在线上静默改变行为。
