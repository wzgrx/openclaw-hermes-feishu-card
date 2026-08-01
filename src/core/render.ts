import { Buffer } from "node:buffer";

import type {
  CardFooterConfig,
  CardJson,
  LegacyRuntimeSnapshot,
  ResourceSnapshot,
  SessionSnapshot,
  ToolStep,
  UsageTotals,
} from "./types.js";

const MAX_ANSWER_CHARS = 18_000;
const MAX_TOOL_STEPS = 20;
export const MAX_CARD_JSON_BYTES = 28 * 1024;
export const MAX_CARD_TABLES = 5;

type CardElement = Record<string, unknown>;

const TABLE_SEPARATOR = /^\s*\|?(?:\s*:?-{3,}:?\s*\|)+(?:\s*:?-{3,}:?\s*)$/gm;

function limitMarkdownTables(
  content: string,
  state: { count: number },
): string {
  return content.replace(TABLE_SEPARATOR, (line) => {
    state.count += 1;
    return state.count <= MAX_CARD_TABLES ? line : `\\${line}`;
  });
}

function truncateUtf8(content: string, byteLimit: number): string {
  if (Buffer.byteLength(content, "utf8") <= byteLimit) {
    return content;
  }
  const suffix = "\n\n…内容已截断";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  const target = Math.max(0, byteLimit - suffixBytes);
  let low = 0;
  let high = content.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(content.slice(0, middle), "utf8") <= target) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${content.slice(0, low).replace(/[\uD800-\uDBFF]$/, "")}${suffix}`;
}

function compactNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(1).replace(/\.0$/, "")}b`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}m`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${Math.round(value)}`;
}

function exactNumber(value: number): string {
  return Math.round(value).toLocaleString("en-US");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ${Math.round(seconds % 60)}s`;
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(gib >= 10 ? 1 : 2)} GiB`;
}

function markdown(content: string, textSize: string = "normal"): CardElement {
  return {
    tag: "markdown",
    content,
    text_size: textSize,
  };
}

function divider(): CardElement {
  return { tag: "hr", margin: "4px 0px 4px 0px" };
}

function fitCardByteBudget(card: CardJson): CardJson {
  const markdownNodes: CardElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value as unknown[]) {
        visit(child);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as CardElement;
    if (record.tag === "markdown" && typeof record.content === "string") {
      markdownNodes.push(record);
    }
    for (const child of Object.values(record)) {
      visit(child);
    }
  };
  visit(card);
  const tableState = { count: 0 };
  for (const node of markdownNodes) {
    if (typeof node.content === "string") {
      node.content = limitMarkdownTables(node.content, tableState);
    }
  }

  let cardBytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  while (cardBytes > MAX_CARD_JSON_BYTES) {
    const largest = markdownNodes
      .filter(
        (node) =>
          typeof node.content === "string" &&
          Buffer.byteLength(node.content, "utf8") > 48,
      )
      .sort(
        (left, right) =>
          Buffer.byteLength(String(right.content), "utf8") -
          Buffer.byteLength(String(left.content), "utf8"),
      )[0];
    if (!largest || typeof largest.content !== "string") {
      break;
    }
    const currentBytes = Buffer.byteLength(largest.content, "utf8");
    const excess = cardBytes - MAX_CARD_JSON_BYTES;
    largest.content = truncateUtf8(
      largest.content,
      Math.max(48, currentBytes - excess - 32),
    );
    cardBytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  }
  return card;
}

function panel(params: {
  titleZh: string;
  titleEn: string;
  emoji: string;
  expanded: boolean;
  elements: CardElement[];
}): CardElement {
  return {
    tag: "collapsible_panel",
    expanded: params.expanded,
    margin: "4px 0px 0px 0px",
    header: {
      title: {
        tag: "markdown",
        content: `**${params.emoji} ${params.titleEn}**`,
        i18n_content: {
          zh_cn: `**${params.emoji} ${params.titleZh}**`,
          en_us: `**${params.emoji} ${params.titleEn}**`,
        },
      },
      background_color: "grey",
      vertical_align: "center",
      padding: "8px 12px 8px 12px",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "8px" },
    vertical_spacing: "8px",
    padding: "10px 12px 12px 12px",
    elements: params.elements,
  };
}

function toolIcon(status: ToolStep["status"]): string {
  switch (status) {
    case "running":
      return "⏳";
    case "failed":
      return "❌";
    case "completed":
      return "✅";
  }
}

function buildToolsPanel(tools: ToolStep[]): CardElement | undefined {
  if (tools.length === 0) {
    return undefined;
  }
  const visible = tools.slice(-MAX_TOOL_STEPS);
  const elements = visible.flatMap((step, index): CardElement[] => {
    const duration =
      step.durationMs === undefined
        ? ""
        : ` · ${formatDuration(step.durationMs)}`;
    const details = [
      step.inputPreview
        ? `<font color='grey'>输入</font>\n\`\`\`json\n${step.inputPreview}\n\`\`\``
        : "",
      step.error
        ? `<font color='red'>${step.error}</font>`
        : step.outputPreview
          ? `<font color='grey'>结果</font>\n${step.outputPreview}`
          : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    return [
      ...(index > 0 ? [divider()] : []),
      markdown(
        `${toolIcon(step.status)} **${step.name}**${duration}`,
        "notation",
      ),
      ...(details ? [markdown(details, "notation")] : []),
    ];
  });
  const completed = tools.filter((step) => step.status === "completed").length;
  const failed = tools.filter((step) => step.status === "failed").length;
  const running = tools.filter((step) => step.status === "running").length;
  const summary = [
    `${completed} 已完成`,
    ...(running ? [`${running} 执行中`] : []),
    ...(failed ? [`${failed} 失败`] : []),
  ].join(" · ");
  return panel({
    titleZh: `执行记录 · ${summary}`,
    titleEn: `Execution log · ${tools.length} steps`,
    emoji: "🛠️",
    expanded: running > 0 || failed > 0,
    elements,
  });
}

function buildActivityStrip(
  session: SessionSnapshot,
  now: number,
): CardElement | undefined {
  if (session.status !== "running") {
    return undefined;
  }
  const total = session.tools.length;
  const settled = session.tools.filter(
    (step) => step.status !== "running",
  ).length;
  const running = session.tools
    .filter((step) => step.status === "running")
    .map((step) => step.name);
  const stage =
    running.length > 0
      ? `执行 ${running.at(-1)}`
      : session.answer
        ? "生成回复"
        : "分析任务";
  return {
    tag: "column_set",
    flex_mode: "none",
    background_style: "grey",
    horizontal_spacing: "12px",
    margin: "0px 0px 4px 0px",
    columns: [
      {
        tag: "column",
        width: "weighted",
        weight: 2,
        vertical_align: "center",
        elements: [markdown(`**⏳ ${stage}**\n正在持续更新结果`, "notation")],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [
          markdown(
            `<font color='grey'>步骤</font>\n**${total ? `${settled}/${total}` : "准备中"}**`,
            "notation",
          ),
        ],
      },
      {
        tag: "column",
        width: "weighted",
        weight: 1,
        vertical_align: "center",
        elements: [
          markdown(
            `<font color='grey'>耗时</font>\n**${formatDuration(now - session.startedAt)}**`,
            "notation",
          ),
        ],
      },
    ],
  };
}

function statusText(status: SessionSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "运行中";
    case "completed":
      return "已完成";
    case "failed":
      return "出错";
    case "aborted":
      return "已停止";
  }
}

function money(value: number, currency: "CNY" | "USD" | undefined): string {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${value.toFixed(value < 1 ? 4 : 2)}`;
}

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
  anthropic: "Anthropic",
  azure: "Azure OpenAI",
  dashscope: "阿里云百炼",
  deepseek: "DeepSeek",
  google: "Google",
  groq: "Groq",
  moonshot: "Moonshot",
  openai: "OpenAI",
  openrouter: "OpenRouter",
  qwen: "阿里云百炼",
  siliconflow: "硅基流动",
  together: "Together AI",
  volcengine: "火山引擎",
  zhipu: "智谱 AI",
};

function providerLabel(provider: string | undefined): string | undefined {
  const id = provider?.trim();
  if (!id) {
    return undefined;
  }
  const brand = PROVIDER_LABELS[id.toLowerCase()];
  if (!brand) {
    return id;
  }
  return brand.toLowerCase() === id.toLowerCase() ? brand : `${brand} (${id})`;
}

function buildRuntimeFooter(params: {
  session: SessionSnapshot;
  config: CardFooterConfig;
  now: number;
}): CardElement | undefined {
  const { session, config, now } = params;
  if (!config.panels.footer) {
    return undefined;
  }
  const usage = session.usage;
  const primary: string[] = [];
  if (config.footer.status) {
    primary.push(statusText(session.status));
  }
  if (config.footer.elapsed) {
    primary.push(
      `耗时 ${formatDuration(
        session.status !== "running" && usage?.durationMs !== undefined
          ? usage.durationMs
          : (session.completedAt ?? now) - session.startedAt,
      )}`,
    );
  }
  if (config.footer.firstToken && session.firstTokenAt) {
    primary.push(
      `首 Token ${formatDuration(session.firstTokenAt - session.startedAt)}`,
    );
  }

  const model: string[] = [];
  if (config.footer.model) {
    const provider = providerLabel(usage?.provider);
    if (provider || usage?.model) {
      model.push(
        `模型 ${[provider, usage?.model].filter(Boolean).join(" · ")}`,
      );
    }
    if (usage?.reasoningEffort) {
      model.push(`推理 ${usage.reasoningEffort}`);
    }
    if (usage?.fastMode === true) {
      model.push("快速模式");
    }
  }

  const detail: string[] = [];
  if (
    config.footer.tokens &&
    usage &&
    (usage.inputTokens !== undefined || usage.outputTokens !== undefined)
  ) {
    detail.push(
      `本轮 ↑ ${exactNumber(usage.inputTokens ?? 0)} ↓ ${exactNumber(usage.outputTokens ?? 0)}`,
    );
  }
  if (
    config.footer.cache &&
    usage &&
    ((usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0)
  ) {
    detail.push(
      `缓存 读 ${exactNumber(usage.cacheReadTokens ?? 0)} / 写 ${exactNumber(usage.cacheWriteTokens ?? 0)}`,
    );
  }
  if (
    config.footer.context &&
    usage?.contextTokenBudget &&
    usage.contextUsedTokens !== undefined
  ) {
    const used = usage.contextUsedTokens;
    const percent = Math.min(999, (used / usage.contextTokenBudget) * 100);
    detail.push(
      `上下文 ${exactNumber(used)} / ${exactNumber(usage.contextTokenBudget)} (${percent.toFixed(1)}%)${usage.contextSource === "aggregate" ? " · 估算" : ""}`,
    );
  }
  if (
    config.footer.cost &&
    usage?.turnCost !== undefined &&
    usage.turnCost > 0
  ) {
    detail.push(`费用 ${money(usage.turnCost, usage.currency)}`);
  }

  const lines = [
    primary.join(" · "),
    model.join(" · "),
    detail.join(" · "),
  ].filter(Boolean);
  return lines.length > 0 ? markdown(lines.join("\n"), "notation") : undefined;
}

function buildDiagnosticsPanel(params: {
  session: SessionSnapshot;
  totals: UsageTotals;
  config: CardFooterConfig;
  resource?: ResourceSnapshot;
  legacy?: LegacyRuntimeSnapshot;
}): CardElement | undefined {
  const { session, totals, config, resource, legacy } = params;
  const usage = session.usage;
  const showFooter = config.panels.footer;
  const elements: CardElement[] = [];

  const routeLines: string[] = [];
  if (
    showFooter &&
    config.footer.model &&
    usage?.requestedRef &&
    usage.resolvedRef &&
    usage.requestedRef.toLowerCase() !== usage.resolvedRef.toLowerCase()
  ) {
    routeLines.push(
      `**模型路由**  请求 ${usage.requestedRef} → 实际 ${usage.resolvedRef}${usage.fallbackUsed ? " · 已回退" : ""}`,
    );
  }
  const modeParts = [
    usage?.authMode ? `认证 ${usage.authMode}` : undefined,
    usage?.overrideSource ? `覆盖来源 ${usage.overrideSource}` : undefined,
  ].filter(Boolean);
  if (showFooter && config.footer.model && modeParts.length > 0) {
    routeLines.push(`**路由配置**  ${modeParts.join(" · ")}`);
  }
  if (routeLines.length > 0) {
    elements.push(markdown(routeLines.join("\n"), "notation"));
  }

  const hasLastCall =
    usage?.lastInputTokens !== undefined ||
    usage?.lastOutputTokens !== undefined ||
    usage?.lastCacheReadTokens !== undefined ||
    usage?.lastCacheWriteTokens !== undefined;
  const lastCallDiffers =
    hasLastCall &&
    (usage?.lastInputTokens !== usage?.inputTokens ||
      usage?.lastOutputTokens !== usage?.outputTokens ||
      usage?.lastCacheReadTokens !== usage?.cacheReadTokens ||
      usage?.lastCacheWriteTokens !== usage?.cacheWriteTokens);
  if (showFooter && config.footer.tokens && lastCallDiffers && usage) {
    const lastParts = [
      `输入 ${exactNumber(usage.lastInputTokens ?? 0)}`,
      `输出 ${exactNumber(usage.lastOutputTokens ?? 0)}`,
      (usage.lastCacheReadTokens ?? 0) > 0
        ? `缓存读 ${exactNumber(usage.lastCacheReadTokens ?? 0)}`
        : undefined,
      (usage.lastCacheWriteTokens ?? 0) > 0
        ? `缓存写 ${exactNumber(usage.lastCacheWriteTokens ?? 0)}`
        : undefined,
    ].filter(Boolean);
    if (elements.length > 0) {
      elements.push(divider());
    }
    elements.push(
      markdown(
        `**末次模型调用**  ${lastParts.join(" · ")}\n<font color='grey'>“本轮”是工具循环内全部调用累计；“上下文”取最后一次调用的 Prompt 占用。</font>`,
        "notation",
      ),
    );
  }

  if (showFooter && config.footer.totals && totals.allTimeTokens > 0) {
    const tokenTotals = [
      ...(config.footer.todayTokens
        ? [`今 ${compactNumber(totals.todayTokens)}`]
        : []),
      ...(config.footer.monthTokens
        ? [`月 ${compactNumber(totals.monthTokens)}`]
        : []),
      `总 ${compactNumber(totals.allTimeTokens)}`,
    ];
    const totalLines = [
      `**插件本地累计**  ${tokenTotals.join(" · ")}`,
      "<font color='grey'>仅统计由本插件成功捕获并记录的回复，不代表供应商账户总量。</font>",
    ];
    if (totals.allTimeCost > 0 && totals.currency) {
      const costTotals = [
        ...(config.footer.todayTokens
          ? [`今 ${money(totals.todayCost, totals.currency)}`]
          : []),
        ...(config.footer.monthTokens
          ? [`月 ${money(totals.monthCost, totals.currency)}`]
          : []),
        `总 ${money(totals.allTimeCost, totals.currency)}`,
      ];
      totalLines.push(`**插件本地费用**  ${costTotals.join(" · ")}`);
    }
    if (elements.length > 0) {
      elements.push(divider());
    }
    elements.push(markdown(totalLines.join("\n"), "notation"));
  }

  if (config.panels.resources && resource) {
    if (elements.length > 0) {
      elements.push(divider());
    }
    elements.push(
      markdown(
        `**主机资源**  CPU ${resource.cpuPercent?.toFixed(0) ?? "-"}% · Load ${resource.loadAverage1m?.toFixed(2) ?? "-"} · 内存 ${formatBytes(resource.memoryUsedBytes)} / ${formatBytes(resource.memoryTotalBytes)} (${resource.memoryPercent.toFixed(0)}%) · Uptime ${formatDuration(resource.uptimeSeconds * 1_000)}`,
        "notation",
      ),
    );
    if (resource.gpu) {
      const gpu = resource.gpu;
      elements.push(
        markdown(
          `GPU ${gpu.name ?? ""} · ${gpu.utilizationPercent?.toFixed(0) ?? "-"}% · ${gpu.memoryUsedMiB ?? "-"}/${gpu.memoryTotalMiB ?? "-"} MiB · ${gpu.temperatureC ?? "-"}°C`,
          "notation",
        ),
      );
    }
  }

  const taskLines: string[] = [];
  if (showFooter && config.footer.backgroundTasks && legacy) {
    const running = legacy.tasks.filter((task) => task.status === "running");
    const stalled = legacy.tasks.filter((task) => task.status === "stalled");
    if (running.length > 0) {
      taskLines.push(
        `后台任务 ${running.length} 个进行中：${running
          .slice(0, 3)
          .map((task) =>
            task.progress === undefined
              ? task.name
              : `${task.name} ${Math.round(task.progress)}%`,
          )
          .join("、")}`,
      );
    }
    if (stalled.length > 0) {
      taskLines.push(
        `⚠️ ${stalled.length} 个任务停滞：${stalled
          .slice(0, 3)
          .map((task) => task.name)
          .join("、")}`,
      );
    }
  }
  if (showFooter && config.footer.balance && legacy?.balances.length) {
    taskLines.push(
      `余额缓存 ${legacy.balances
        .slice(0, 3)
        .map(
          (balance) =>
            `${balance.available ? "" : "⚠️"}${balance.platform} ¥${balance.total.toFixed(2)}`,
        )
        .join(" · ")}`,
    );
  }
  if (taskLines.length > 0) {
    if (elements.length > 0) {
      elements.push(divider());
    }
    elements.push(markdown(taskLines.join("\n"), "notation"));
  }

  if (elements.length === 0) {
    return undefined;
  }
  return panel({
    titleZh: "诊断信息",
    titleEn: "Diagnostics",
    emoji: "🔎",
    expanded: false,
    elements,
  });
}

function headerTemplate(status: SessionSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "blue";
    case "completed":
      return "green";
    case "failed":
      return "red";
    case "aborted":
      return "grey";
  }
}

function statusTag(status: SessionSnapshot["status"]): {
  text: string;
  color: string;
} {
  switch (status) {
    case "running":
      return { text: "进行中", color: "blue" };
    case "completed":
      return { text: "已完成", color: "green" };
    case "failed":
      return { text: "执行异常", color: "red" };
    case "aborted":
      return { text: "已停止", color: "neutral" };
  }
}

function headerSubtitle(session: SessionSnapshot): string | undefined {
  const runningTool = session.tools.findLast(
    (step) => step.status === "running",
  );
  if (session.status === "running") {
    return runningTool
      ? `正在执行 ${runningTool.name}`
      : session.answer
        ? "正在生成回复"
        : "正在分析任务";
  }
  return undefined;
}

export function renderCard(params: {
  session: SessionSnapshot;
  totals: UsageTotals;
  config: CardFooterConfig;
  resource?: ResourceSnapshot;
  legacy?: LegacyRuntimeSnapshot;
  now?: number;
}): CardJson {
  const now = params.now ?? Date.now();
  const { session, config } = params;
  const elements: CardElement[] = [];

  const activity = config.panels.progress
    ? buildActivityStrip(session, now)
    : undefined;
  if (activity) {
    elements.push(activity);
  }

  if (session.notices.length > 0 && !session.answer) {
    elements.push(
      markdown(
        `<font color='grey'>${session.notices.at(-1) ?? ""}</font>`,
        "notation",
      ),
    );
  }
  const answer =
    session.answer ||
    (session.status === "running"
      ? session.tools.some((step) => step.status === "running")
        ? "正在执行所需步骤，结果将在这里持续更新…"
        : "正在理解任务并准备回复…"
      : session.status === "failed"
        ? "本次任务执行异常，请展开执行记录查看详情。"
        : session.status === "aborted"
          ? "任务已停止。"
          : "任务已完成，本次没有生成可显示的文本。");
  elements.push(
    markdown(
      answer.length > MAX_ANSWER_CHARS
        ? `${answer.slice(0, MAX_ANSWER_CHARS - 20)}\n\n…内容已截断`
        : answer,
    ),
  );

  const toolsPanel = config.panels.tools
    ? buildToolsPanel(session.tools)
    : undefined;
  if (toolsPanel) {
    elements.push(toolsPanel);
  }
  if (
    config.panels.reasoning &&
    session.status !== "running" &&
    session.reasoning &&
    session.reasoning.trim() !== session.answer.trim()
  ) {
    elements.push(
      panel({
        titleZh: "分析摘要",
        titleEn: "Analysis summary",
        emoji: "🧭",
        expanded: false,
        elements: [markdown(session.reasoning.slice(-6_000), "notation")],
      }),
    );
  }

  const footer = buildRuntimeFooter({ session, config, now });
  if (footer) {
    elements.push(footer);
  }

  if (
    config.panels.resources ||
    config.footer.totals ||
    config.footer.backgroundTasks ||
    config.footer.balance ||
    (config.footer.model &&
      Boolean(
        session.usage?.overrideSource ||
        session.usage?.authMode ||
        (session.usage?.requestedRef &&
          session.usage?.resolvedRef &&
          session.usage.requestedRef.toLowerCase() !==
            session.usage.resolvedRef.toLowerCase()),
      )) ||
    (config.footer.tokens &&
      Boolean(
        session.usage?.lastInputTokens !== undefined ||
        session.usage?.lastOutputTokens !== undefined ||
        session.usage?.lastCacheReadTokens !== undefined ||
        session.usage?.lastCacheWriteTokens !== undefined,
      ))
  ) {
    const details = buildDiagnosticsPanel({
      session,
      totals: params.totals,
      config,
      ...(params.resource ? { resource: params.resource } : {}),
      ...(params.legacy ? { legacy: params.legacy } : {}),
    });
    if (details) {
      elements.push(details);
    }
  }

  const summary = answer
    .replace(/[*_`#>[\]()~]/g, "")
    .trim()
    .slice(0, 120);
  const title =
    (session.route?.accountId
      ? config.accountTitles[session.route.accountId]
      : undefined) ??
    config.title ??
    (session.runtime === "openclaw" ? "OpenClaw" : "Hermes");
  const tag = statusTag(session.status);
  const subtitle = headerSubtitle(session);
  const headerTags: CardElement[] = [
    {
      tag: "text_tag",
      text: { tag: "plain_text", content: tag.text },
      color: tag.color,
    },
  ];
  if (session.tools.length > 0) {
    headerTags.push({
      tag: "text_tag",
      text: {
        tag: "plain_text",
        content: `${session.tools.length} 步`,
      },
      color: "neutral",
    });
  }
  return fitCardByteBudget({
    schema: "2.0",
    config: {
      width_mode: "fill",
      update_multi: true,
      streaming_mode: session.status === "running",
      locales: ["zh_cn", "en_us"],
      summary: {
        content: summary || "Agent is working",
        i18n_content: {
          zh_cn: summary || "Agent 正在处理",
          en_us: summary || "Agent is working",
        },
      },
    },
    header: {
      template: headerTemplate(session.status),
      padding: "12px 16px 12px 16px",
      title: {
        tag: "plain_text",
        content: title,
        i18n_content: {
          zh_cn: title,
          en_us: title,
        },
      },
      ...(subtitle
        ? {
            subtitle: {
              tag: "plain_text",
              content: subtitle,
            },
          }
        : {}),
      text_tag_list: headerTags,
    },
    body: {
      direction: "vertical",
      vertical_spacing: "12px",
      padding: "14px 16px 16px 16px",
      elements,
    },
  });
}

export function countCardElements(value: unknown): number {
  if (Array.isArray(value)) {
    const children: unknown[] = value;
    return children.reduce<number>(
      (total, child) => total + countCardElements(child),
      0,
    );
  }
  if (!value || typeof value !== "object") {
    return 0;
  }
  const record = value as Record<string, unknown>;
  const own = typeof record.tag === "string" ? 1 : 0;
  return (
    own +
    Object.values(record).reduce<number>(
      (total, child) => total + countCardElements(child),
      0,
    )
  );
}
