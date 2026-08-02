# GitHub 对标审计与路线图

更新时间：2026-08-02

## 结论

本项目的正常 OpenClaw 入站链路直接加载锁定版本的
[`@larksuite/openclaw-lark`](https://github.com/larksuite/openclaw-lark)，因此 WebSocket / Webhook、
私聊和群聊路由、线程回复、媒体、输入状态、流式卡片以及多账户等通道能力应继续从官方依赖继承，
而不是在本项目中复制第二套实现。本项目聚焦官方通道尚未覆盖或需要兼容的部分：Hermes 双运行时、
旧版视觉契约、真实模型与 API 指标、运行时兼容补丁、跨路径一致性和可重复诊断。

## 本轮检索范围

| 项目 / 资料                                                                                     | 可借鉴点                                                          | 处理决定                                 |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------- |
| [OpenClaw 飞书通道文档](https://github.com/openclaw/openclaw/blob/main/docs/channels/feishu.md) | 官方配置、事件模式、流式与分块流式、输入状态、发送者名称解析      | 由内嵌官方通道继承                       |
| [larksuite/openclaw-lark](https://github.com/larksuite/openclaw-lark)                           | CardKit Builder、FlushController、图片解析、Markdown 优化、群队列 | 锁定依赖并保持 Builder 原样              |
| [xzq-xu/openclaw-plugin-feishu](https://github.com/xzq-xu/openclaw-plugin-feishu)               | 消息合并、自动回复、历史分页、reaction、按发送者策略              | 只吸收与官方通道不重叠的配置思路         |
| [shareAI-lab/lark-channel](https://github.com/shareAI-lab/lark-channel)                         | latest-wins 调度、按群队列、持久会话、URL 操作按钮                | 将可选按钮和队列观测列入后续计划         |
| [NousResearch/hermes-agent#7675](https://github.com/NousResearch/hermes-agent/issues/7675)      | Hermes 飞书流式卡片需求与兼容场景                                 | 继续维护 Python 原生平台适配器           |
| [jz0ojiang/feishu-webhook-sdk](https://github.com/jz0ojiang/feishu-webhook-sdk)                 | Webhook 卡片与消息发送封装                                        | 仅作传输边界参考，不替代应用鉴权 CardKit |

## 已落实的高优先级完善

### 1. 工具轨迹会话别名

官方通道的 dispatcher 可能以 `agent:<id>:main` 创建轨迹，而 OpenClaw Hook 以更完整的飞书
session key 上报工具事件，导致工具面板一直显示“未调用工具”。本项目在私有兼容运行时中按 agent
作用域和 run ID 将 Hook 事件绑定到当前活动 dispatcher，不改动用户全局安装，也不改 Builder。
对应上游问题：
[#540](https://github.com/larksuite/openclaw-lark/issues/540)、
[#552](https://github.com/larksuite/openclaw-lark/issues/552)。

### 2. 异常路径释放回复占位

私有官方运行时副本会在 dispatcher 的 `finally` 中统一完成并释放回复状态，避免一次调用异常后后续
消息被遗留的 active dispatcher 阻塞。对应上游问题：
[#583](https://github.com/larksuite/openclaw-lark/issues/583)。

### 3. CardKit 表格预算一致化

路由型 TypeScript 与 Hermes Python 卡片统一执行 CardKit 的 3 张 Markdown 表格预算；代码块中的
表格示例不消耗额度，超额表格整体降级为代码块，避免只转义分隔线造成难读排版。对应上游讨论：
[#435](https://github.com/larksuite/openclaw-lark/issues/435)。

### 4. 真实模型身份持久化

Hermes 账本现在同时保存 `provider`、`model`、`resolvedRef`、`api` 与 `transport`，保证重启、累计
统计和后续诊断不会丢失“实际胜出模型 + API adapter”的来源信息。运行中的工具步骤在任务结束时也会
统一收口为完成或失败，避免最终卡片残留 Running 状态。

## 后续优先级

### P1：可靠性与长内容

1. **长回答自动续卡**：按段落切分并发送连续卡片，保留首卡工具/思考面板和末卡 Footer。参考
   [#447](https://github.com/larksuite/openclaw-lark/issues/447)。
2. **子代理完成通知统一卡片化**：让 announce/subagent 完成消息复用同一视觉契约。参考
   [#564](https://github.com/larksuite/openclaw-lark/issues/564)。
3. **结构化传输观测**：记录 CardKit 错误码、刷新次数、限流跳帧和最终投递延迟；默认只进入日志与
   doctor JSON，不增加卡片噪声。
4. **latest-wins 压力测试**：针对同一会话快速增量、异常恢复和最终帧建立并发测试矩阵，避免重复终卡
   或旧帧覆盖新帧。

### P2：交互与可观测性

1. **可选链接操作按钮**：从回答中的可信 URL 生成最多 2 个按钮，默认关闭，不改变经典样式。
2. **可导出的本地指标**：提供不含凭据的 NDJSON/Prometheus 快照，用于查看模型、API、Token、
   缓存命中、TTFB、CardKit 成功率和限流次数。
3. **视觉快照流水线**：在 CI 中渲染 thinking / tool-running / completed / failed 四态预览，并将
   JSON 契约与图片产物一起保留。
4. **公式与复杂 Markdown 兼容**：在不改变普通回答的前提下，增加 LaTeX、嵌套列表、宽表与超长
   代码块回归用例。

## 取舍原则

- 默认视觉继续等同迁移前经典卡片；新面板和按钮必须显式开启。
- 通道层已有能力优先升级/继承官方实现，本项目只维护差异层。
- 任何显示字段必须来自实际运行事件；缺值时省略，不根据模型名猜供应商或 API。
- 每项移植都需要 TypeScript、Python 或真实 CardKit entity smoke 中至少一条可复现验证链。
