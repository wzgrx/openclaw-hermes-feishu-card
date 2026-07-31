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

function markdown(
  content: string,
  textSize: string = "normal_v2",
): CardElement {
  return {
    tag: "markdown",
    content,
    text_size: textSize,
  };
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
    header: {
      title: {
        tag: "plain_text",
        content: `${params.emoji} ${params.titleEn}`,
        i18n_content: {
          zh_cn: `${params.emoji} ${params.titleZh}`,
          en_us: `${params.emoji} ${params.titleEn}`,
        },
        text_color: "grey",
        text_size: "notation",
      },
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        color: "grey",
        size: "16px 16px",
      },
      icon_position: "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: "4px",
    padding: "8px 8px 8px 8px",
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
  const elements = visible.flatMap((step): CardElement[] => {
    const duration =
      step.durationMs === undefined
        ? ""
        : ` · ${formatDuration(step.durationMs)}`;
    const details = [
      step.inputPreview
        ? `**Input**\n\`\`\`json\n${step.inputPreview}\n\`\`\``
        : "",
      step.error ?? step.outputPreview,
    ]
      .filter(Boolean)
      .join("\n\n");
    return [
      markdown(
        `${toolIcon(step.status)} **${step.name}**${duration}`,
        "notation",
      ),
      ...(details ? [markdown(details, "notation")] : []),
    ];
  });
  return panel({
    titleZh: `工具步骤 · ${tools.length}`,
    titleEn: `Tool steps · ${tools.length}`,
    emoji: "🛠️",
    expanded: false,
    elements,
  });
}

function buildProgressPanel(session: SessionSnapshot): CardElement {
  const total = session.tools.length;
  const settled = session.tools.filter(
    (step) => step.status !== "running",
  ).length;
  const percent =
    session.status === "completed"
      ? 100
      : total > 0
        ? Math.round((settled / total) * 100)
        : 5;
  const bars = Math.round(percent / 5);
  const bar = `${"█".repeat(bars)}${"░".repeat(20 - bars)}`;
  const running = session.tools
    .filter((step) => step.status === "running")
    .map((step) => step.name);
  const detail = running.length > 0 ? `\n\n⏳ ${running.join(" · ")}` : "";
  return panel({
    titleZh: `任务进度 · ${percent}%`,
    titleEn: `Task progress · ${percent}%`,
    emoji: "📊",
    expanded: session.status === "running",
    elements: [markdown(`\`${bar}\` **${percent}%**${detail}`, "notation")],
  });
}

function buildResourcePanel(resource: ResourceSnapshot): CardElement {
  const lines = [
    `CPU ${resource.cpuPercent?.toFixed(0) ?? "-"}% · Load ${resource.loadAverage1m?.toFixed(2) ?? "-"}`,
    `Memory ${formatBytes(resource.memoryUsedBytes)}/${formatBytes(resource.memoryTotalBytes)} (${resource.memoryPercent.toFixed(0)}%)`,
    `Uptime ${formatDuration(resource.uptimeSeconds * 1_000)}`,
  ];
  if (resource.gpu) {
    const gpu = resource.gpu;
    lines.push(
      `GPU ${gpu.name ?? ""} · ${gpu.utilizationPercent?.toFixed(0) ?? "-"}% · ${gpu.memoryUsedMiB ?? "-"}/${gpu.memoryTotalMiB ?? "-"} MiB · ${gpu.temperatureC ?? "-"}°C`,
    );
  }
  return panel({
    titleZh: "系统资源",
    titleEn: "System resources",
    emoji: "🖥️",
    expanded: false,
    elements: [markdown(lines.join("\n"), "notation")],
  });
}

function statusText(status: SessionSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "⏳ 运行中";
    case "completed":
      return "✅ 已完成";
    case "failed":
      return "❌ 出错";
    case "aborted":
      return "⏹️ 已停止";
  }
}

function money(value: number, currency: "CNY" | "USD" | undefined): string {
  const symbol = currency === "USD" ? "$" : "¥";
  return `${symbol}${value.toFixed(value < 0.01 ? 4 : 2)}`;
}

function buildFooter(params: {
  session: SessionSnapshot;
  totals: UsageTotals;
  config: CardFooterConfig;
  legacy?: LegacyRuntimeSnapshot;
  now: number;
}): CardElement | undefined {
  const { session, totals, config, legacy, now } = params;
  const usage = session.usage;
  const items: string[] = [];
  if (config.footer.status) {
    items.push(statusText(session.status));
  }
  if (config.footer.elapsed) {
    items.push(
      `耗时 ${formatDuration((session.completedAt ?? now) - session.startedAt)}`,
    );
  }
  if (config.footer.firstToken && session.firstTokenAt) {
    items.push(
      `首 Token ${formatDuration(session.firstTokenAt - session.startedAt)}`,
    );
  }
  if (
    config.footer.model &&
    (usage?.resolvedRef ?? usage?.model ?? usage?.provider)
  ) {
    items.push(
      usage?.resolvedRef ??
        [usage?.provider, usage?.model].filter(Boolean).join("/"),
    );
  }
  if (config.footer.tokens && usage) {
    items.push(
      `↑ ${compactNumber(usage.inputTokens ?? 0)} ↓ ${compactNumber(usage.outputTokens ?? 0)}`,
    );
  }
  if (
    config.footer.cache &&
    usage &&
    ((usage.cacheReadTokens ?? 0) > 0 || (usage.cacheWriteTokens ?? 0) > 0)
  ) {
    items.push(
      `缓存 ${compactNumber(usage.cacheReadTokens ?? 0)}/${compactNumber(usage.cacheWriteTokens ?? 0)}`,
    );
  }
  if (config.footer.context && usage?.contextTokenBudget) {
    const used = usage.contextUsedTokens ?? usage.inputTokens ?? 0;
    const percent = Math.min(
      999,
      Math.round((used / usage.contextTokenBudget) * 100),
    );
    items.push(
      `上下文 ${compactNumber(used)}/${compactNumber(usage.contextTokenBudget)} (${percent}%)`,
    );
  }
  if (config.footer.cost && usage?.turnCost !== undefined) {
    items.push(`本次 ${money(usage.turnCost, usage.currency)}`);
  }
  if (config.footer.totals) {
    const tokenTotals = [
      ...(config.footer.todayTokens
        ? [`今 ${compactNumber(totals.todayTokens)}`]
        : []),
      ...(config.footer.monthTokens
        ? [`月 ${compactNumber(totals.monthTokens)}`]
        : []),
      `总 ${compactNumber(totals.allTimeTokens)}`,
    ];
    items.push(`Token ${tokenTotals.join("/")}`);
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
      items.push(`费用 ${costTotals.join("/")}`);
    }
  }
  if (config.footer.backgroundTasks && legacy) {
    const running = legacy.tasks.filter((task) => task.status === "running");
    const stalled = legacy.tasks.filter((task) => task.status === "stalled");
    if (running.length > 0) {
      items.push(
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
      items.push(
        `⚠️ ${stalled.length} 个任务停滞：${stalled
          .slice(0, 3)
          .map((task) => task.name)
          .join("、")}`,
      );
    }
  }
  if (config.footer.balance && legacy?.balances.length) {
    items.push(
      `余额 ${legacy.balances
        .slice(0, 3)
        .map(
          (balance) =>
            `${balance.available ? "" : "⚠️"}${balance.platform} ¥${balance.total.toFixed(2)}`,
        )
        .join(" · ")}`,
    );
  }
  if (items.length === 0) {
    return undefined;
  }
  return panel({
    titleZh: "运行统计",
    titleEn: "Runtime metrics",
    emoji: "🪙",
    expanded: false,
    elements: [markdown(items.join(" · "), "notation")],
  });
}

function headerTemplate(status: SessionSnapshot["status"]): string {
  switch (status) {
    case "running":
      return "blue";
    case "completed":
      return "green";
    case "failed":
    case "aborted":
      return "red";
  }
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

  if (config.panels.resources && params.resource) {
    elements.push(buildResourcePanel(params.resource));
  }
  const toolsPanel = config.panels.tools
    ? buildToolsPanel(session.tools)
    : undefined;
  if (toolsPanel) {
    elements.push(toolsPanel);
  }
  if (config.panels.progress) {
    elements.push(buildProgressPanel(session));
  }
  if (config.panels.reasoning && session.reasoning) {
    elements.push(
      panel({
        titleZh: "思考过程",
        titleEn: "Reasoning",
        emoji: "💭",
        expanded: false,
        elements: [markdown(session.reasoning.slice(-6_000), "notation")],
      }),
    );
  }
  if (session.notices.length > 0 && !session.answer) {
    elements.push(markdown(session.notices.at(-1) ?? "", "notation"));
  }
  const answer =
    session.answer ||
    (session.status === "running"
      ? "正在处理…"
      : session.status === "failed"
        ? "任务执行出错。"
        : "任务已结束。");
  elements.push(
    markdown(
      answer.length > MAX_ANSWER_CHARS
        ? `${answer.slice(0, MAX_ANSWER_CHARS - 20)}\n\n…内容已截断`
        : answer,
    ),
  );

  if (config.panels.footer) {
    const footer = buildFooter({
      session,
      totals: params.totals,
      config,
      now,
      ...(params.legacy ? { legacy: params.legacy } : {}),
    });
    if (footer) {
      elements.push(footer);
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
  return fitCardByteBudget({
    schema: "2.0",
    config: {
      wide_screen_mode: true,
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
      title: {
        tag: "plain_text",
        content: title,
        i18n_content: {
          zh_cn: title,
          en_us: title,
        },
      },
      subtitle: {
        tag: "plain_text",
        content: statusText(session.status),
      },
    },
    body: { elements },
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
