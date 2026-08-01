# 兼容性

## 支持矩阵

| 运行时          | 版本      | 集成面                                                  |
| --------------- | --------- | ------------------------------------------------------- |
| OpenClaw        | 2026.7.x  | 入站 dispatcher 使用 `reply_payload_sending`、工具 Hook |
| openclaw-lark   | 2026.7.x  | 2026.7.16；通道 controller 保留媒体与原生交互卡片       |
| Hermes Agent    | 0.19.x    | 已验证 PyPI 0.19.0 与源码标签 0.19.1                    |
| 飞书 Node SDK   | 1.72.x    | CardKit v1、IM v1                                       |
| 飞书 Python SDK | 1.6.8–1.x | CardKit v1、IM v1                                       |
| lark-cli        | 1.0.80+   | raw API、JSON envelope、dry-run、bot 环境凭据           |

## 通道职责

| 功能                   | 本插件 | 上游通道   |
| ---------------------- | ------ | ---------- |
| 回答流式卡片           | 是     | 传输基础   |
| 工具进度               | 是     | 事件来源   |
| Token/费用 Footer      | 是     | 使用量来源 |
| 入站 WebSocket/Webhook | 否     | 是         |
| 文件、图片、视频、语音 | 否     | 是         |
| 审批、命令、配对       | 否     | 是         |

上游通道仍负责媒体传输；本插件会在 Hermes 卡片内附加安全截断后的附件摘要。

OpenClaw 2026.7.x 会把 `reply_payload_sending` 安装到入站 dispatcher 的
`beforeDeliver` 链。本插件只接管普通文本与纯文本 presentation；媒体、审批、按钮、
位置、语音以及已经构造的飞书原生卡片保持通道投递。独立 CLI `--deliver` 没有入站
会话上下文，不作为自动接管链路的端到端测试入口。

官方 lark-cli 适配器不替代在线回复通道。它通过 raw API 验证“应用凭据 →
CardKit 创建 → IM 发送 → 内容更新 → 关闭流式状态”全链路，默认仅执行
dry-run，适合安装器和 Agent 诊断。

## 旧项目功能移植

| 旧项目能力                                   | 新实现                                            |
| -------------------------------------------- | ------------------------------------------------- |
| 多 profile / 多机器人隔离与路由              | 复用运行时账户路由；OpenClaw 支持 `accountTitles` |
| 流式回答、思考标签、工具步骤、cron 最终卡片  | 原生 Hook / 平台适配器状态机                      |
| 线程回复、消息生命周期、附件与媒体 fail-open | 保留上游通道能力并补充附件摘要                    |
| 5 张 Markdown 表格、卡片字节上限、严格序列号 | TypeScript/Python 双端统一预算和串行更新          |
| CPU、内存、运行时间与 GPU                    | 双端资源采样；缺少 GPU 工具时自动省略             |
| 今日/月度/累计 Token 与费用                  | 共享追加式 `usage.ndjson`                         |
| 后台任务进度                                 | 兼容读取 `/tmp/openclaw-tasks/*.json`             |
| DeepSeek/SiliconFlow 余额                    | 兼容余额缓存和 `pnpm balance:check`               |
| Python 旧包名、旧 CLI、旧字段                | 转发包与配置翻译层                                |
| 修改上游源码、sidecar、进度 HTTP 服务        | 由原生生命周期 Hook 和本地缓存读取取代            |

## 升级策略

- Dependabot 跟踪 npm、pip 与 GitHub Actions。
- CI 覆盖 Node 22.22.3、24.15.0、25.9.0 和 Python 3.11–3.13。
- 对 OpenClaw Hook、Hermes 平台注册和 CardKit 生命周期进行真实运行时加载测试。
- 每周对 npm 最新稳定版、OpenClaw beta 插件 API 和 Hermes `main` 执行兼容哨兵测试。
- Hermes 0.20 或 OpenClaw 新主版本发布时先在兼容分支验证。

完整升级步骤见 [维护与升级](maintenance.md)。
