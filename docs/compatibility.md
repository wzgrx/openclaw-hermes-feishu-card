# 兼容性

## 支持矩阵

| 运行时          | 版本      | 集成面                                                |
| --------------- | --------- | ----------------------------------------------------- |
| OpenClaw        | 2026.7.x  | 已验证 2026.7.1-2；`reply_payload_sending`、工具 Hook |
| openclaw-lark   | 2026.7.x  | 已验证 2026.7.16 同时加载；通道 ID 为 `feishu`        |
| Hermes Agent    | 0.19.x    | 已验证 PyPI 0.19.0 与源码标签 0.19.1                  |
| 飞书 Node SDK   | 1.72.x    | CardKit v1、IM v1                                     |
| 飞书 Python SDK | 1.6.8–1.x | CardKit v1、IM v1                                     |

## 通道职责

| 功能                   | 本插件 | 上游通道   |
| ---------------------- | ------ | ---------- |
| 回答流式卡片           | 是     | 传输基础   |
| 工具进度               | 是     | 事件来源   |
| Token/费用 Footer      | 是     | 使用量来源 |
| 入站 WebSocket/Webhook | 否     | 是         |
| 文件、图片、视频、语音 | 否     | 是         |
| 审批、命令、配对       | 否     | 是         |

## 升级策略

- Dependabot 跟踪 npm、pip 与 GitHub Actions。
- CI 覆盖 Node 22.22.3、24.15.0、25.9.0 和 Python 3.11–3.13。
- 对 OpenClaw Hook、Hermes 平台注册和 CardKit 生命周期进行真实运行时加载测试。
- 每周对 npm 最新稳定版、OpenClaw beta 插件 API 和 Hermes `main` 执行兼容哨兵测试。
- Hermes 0.20 或 OpenClaw 新主版本发布时先在兼容分支验证。

完整升级步骤见 [维护与升级](maintenance.md)。
