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
  if (Buffer.byteLength(content, "utf8") <= byteLimit) return content;
  const suffix = "\n\n…内容已截断";
  const target = Math.max(0, byteLimit - Buffer.byteLength(suffix, "utf8"));
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

function fitCardByteBudget(card: CardJson): CardJson {
  const textNodes: CardElement[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child);
      return;
    }
    if (!value || typeof value !== "object") return;
    const element = value as CardElement;
    if (typeof element.content === "string") {
      textNodes.push(element);
    }
    for (const child of Object.values(element)) visit(child);
  };
  visit(card);
  const tableState = { count: 0 };
  for (const node of textNodes) {
    node.content = limitMarkdownTables(String(node.content), tableState);
  }

  let bytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  while (bytes > MAX_CARD_JSON_BYTES) {
    const largest = textNodes
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
    if (!largest || typeof largest.content !== "string") break;
    const currentBytes = Buffer.byteLength(largest.content, "utf8");
    largest.content = truncateUtf8(
      largest.content,
      Math.max(48, currentBytes - (bytes - MAX_CARD_JSON_BYTES) - 32),
    );
    bytes = Buffer.byteLength(JSON.stringify(card), "utf8");
  }
  return card;
}

function compactNumber(value: number): string {
  const count = Math.max(0, Math.round(value));
  if (count >= 1_000_000) {
    const scaled = count / 1_000_000;
    return scaled >= 100 ? `${Math.round(scaled)}m` : `${scaled.toFixed(1)}m`;
  }
  if (count >= 1_000) {
    const scaled = count / 1_000;
    return scaled >= 100 ? `${Math.round(scaled)}k` : `${scaled.toFixed(1)}k`;
  }
  return String(count);
}

function exactNumber(value: number): string {
  return Math.max(0, Math.round(value)).toLocaleString("en-US");
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, milliseconds) / 1_000;
  return seconds < 60
    ? `${seconds.toFixed(1)}s`
    : `${Math.floor(seconds / 60)}m ${Math.floor(seconds % 60)}s`;
}

function markdown(
  content: string,
  textSize?: string,
  extra: CardElement = {},
): CardElement {
  return {
    tag: "markdown",
    content,
    ...(textSize ? { text_size: textSize } : {}),
    ...extra,
  };
}

function localizedTitle(en: string, zh: string): CardElement {
  return {
    tag: "plain_text",
    content: en,
    i18n_content: { zh_cn: zh, en_us: en },
    text_color: "grey",
    text_size: "notation",
  };
}

function panel(params: {
  titleEn: string;
  titleZh: string;
  expanded: boolean;
  elements: CardElement[];
  reasoning?: boolean;
}): CardElement {
  return {
    tag: "collapsible_panel",
    expanded: params.expanded,
    header: {
      title: params.reasoning
        ? {
            tag: "markdown",
            content: params.titleEn,
            i18n_content: {
              zh_cn: params.titleZh,
              en_us: params.titleEn,
            },
          }
        : localizedTitle(params.titleEn, params.titleZh),
      vertical_align: "center",
      icon: {
        tag: "standard_icon",
        token: "down-small-ccm_outlined",
        ...(params.reasoning ? {} : { color: "grey" }),
        size: "16px 16px",
      },
      icon_position: params.reasoning ? "follow_text" : "right",
      icon_expanded_angle: -180,
    },
    border: { color: "grey", corner_radius: "5px" },
    vertical_spacing: params.reasoning ? "8px" : "4px",
    padding: "8px 8px 8px 8px",
    elements: params.elements,
  };
}

function toolStatus(step: ToolStep): { label: string; color: string } {
  if (step.status === "completed")
    return { label: "Succeeded", color: "green" };
  if (step.status === "failed") return { label: "Failed", color: "red" };
  return { label: "Running", color: "turquoise" };
}

function toolElements(step: ToolStep): CardElement[] {
  const state = toolStatus(step);
  const elements: CardElement[] = [
    {
      tag: "div",
      icon: { tag: "standard_icon", token: "tool_02", color: "grey" },
      text: {
        tag: "lark_md",
        content: `**${step.name}** · <font color='${state.color}'>${state.label}</font>`,
        text_size: "notation",
      },
    },
  ];
  if (step.inputPreview) {
    elements.push({
      tag: "div",
      margin: "0px 0px 0px 22px",
      text: {
        tag: "plain_text",
        content: step.inputPreview,
        text_color: "grey",
        text_size: "notation",
      },
    });
  }
  const output = step.error ?? step.outputPreview;
  if (output) {
    elements.push({
      tag: "div",
      margin: "0px 0px 0px 22px",
      text: {
        tag: "lark_md",
        content: `${step.error ? "**Error**" : "**Result**"}\n${output}`,
        text_size: "notation",
      },
    });
  }
  return elements;
}

function buildToolsPanel(session: SessionSnapshot, now: number): CardElement {
  const visible = session.tools.slice(-MAX_TOOL_STEPS);
  const running = session.status === "running";
  const elapsed = formatDuration(now - session.startedAt);
  let titleEn: string;
  let titleZh: string;
  if (running && visible.length === 0) {
    titleEn = "🛠️ Tool use pending";
    titleZh = "🛠️ 等待工具执行";
  } else if (running) {
    titleEn = `🛠️ Tool use · ${visible.length} step${visible.length === 1 ? "" : "s"} · (${elapsed})`;
    titleZh = `🛠️ 工具执行 · ${visible.length} 步 · (${elapsed})`;
  } else {
    const toolMs = visible.reduce(
      (total, step) => total + (step.durationMs ?? 0),
      0,
    );
    titleEn =
      toolMs > 0 ? `🛠️ Tool use for ${formatDuration(toolMs)}` : "🛠️ Tool use";
    titleZh =
      toolMs > 0 ? `🛠️ 执行耗时 ${formatDuration(toolMs)}` : "🛠️ 工具执行";
  }
  const elements = visible.flatMap(toolElements);
  if (!running && elements.length === 0) {
    elements.push({
      tag: "div",
      icon: { tag: "standard_icon", token: "tool_02", color: "grey" },
      text: {
        tag: "plain_text",
        content: "No tools were used",
        i18n_content: { zh_cn: "未调用工具", en_us: "No tools were used" },
        text_color: "grey",
        text_size: "notation",
      },
    });
  }
  return panel({
    titleEn,
    titleZh,
    expanded: running && visible.length > 0,
    elements,
  });
}

function buildReasoningPanel(reasoning: string): CardElement {
  return panel({
    titleEn: "💭 Thought",
    titleZh: "💭 思考",
    expanded: false,
    reasoning: true,
    elements: [markdown(reasoning.slice(-6_000), "notation")],
  });
}

function buildRuntimeFooter(params: {
  session: SessionSnapshot;
  config: CardFooterConfig;
  now: number;
}): CardElement | undefined {
  const { session, config, now } = params;
  if (!config.panels.footer || session.status === "running") return undefined;
  const usage = session.usage;
  const primaryZh: string[] = [];
  const primaryEn: string[] = [];
  if (config.footer.status) {
    const status: readonly [string, string] =
      session.status === "completed"
        ? ["Completed", "已完成"]
        : session.status === "failed"
          ? ["Error", "出错"]
          : ["Stopped", "已停止"];
    primaryEn.push(status[0]);
    primaryZh.push(status[1]);
  }
  if (config.footer.elapsed) {
    const elapsed = formatDuration(
      usage?.durationMs ?? (session.completedAt ?? now) - session.startedAt,
    );
    primaryEn.push(`Elapsed ${elapsed}`);
    primaryZh.push(`耗时 ${elapsed}`);
  }
  if (config.footer.model && usage?.model) {
    primaryEn.push(usage.model);
    primaryZh.push(usage.model);
  }

  const detailEn: string[] = [];
  const detailZh: string[] = [];
  if (config.footer.tokens && usage) {
    const value = `↑ ${compactNumber(usage.inputTokens ?? 0)} ↓ ${compactNumber(usage.outputTokens ?? 0)}`;
    detailEn.push(value);
    detailZh.push(value);
  }
  if (config.footer.cache && usage) {
    const read = Math.max(0, usage.cacheReadTokens ?? 0);
    const write = Math.max(0, usage.cacheWriteTokens ?? 0);
    const input = Math.max(0, usage.inputTokens ?? 0);
    const total = read + write + input;
    const percent = total > 0 ? Math.round((read / total) * 100) : 0;
    detailEn.push(
      `Cache ${compactNumber(read)}/${compactNumber(write)} (${percent}%)`,
    );
    detailZh.push(
      `缓存 ${compactNumber(read)}/${compactNumber(write)} (${percent}%)`,
    );
  }
  if (
    config.footer.context &&
    usage?.contextUsedTokens !== undefined &&
    usage.contextTokenBudget !== undefined
  ) {
    const used = Math.max(0, usage.contextUsedTokens);
    const maximum = Math.max(0, usage.contextTokenBudget);
    const percent = maximum > 0 ? Math.round((used / maximum) * 100) : 0;
    detailEn.push(
      `Context ${compactNumber(used)}/${compactNumber(maximum)} (${percent}%)`,
    );
    detailZh.push(
      `上下文 ${compactNumber(used)}/${compactNumber(maximum)} (${percent}%)`,
    );
  }

  const en = [primaryEn.join(" · "), detailEn.join(" · ")]
    .filter(Boolean)
    .join("\n");
  const zh = [primaryZh.join(" · "), detailZh.join(" · ")]
    .filter(Boolean)
    .join("\n");
  if (!en) return undefined;
  const failed = session.status === "failed";
  return markdown(failed ? `<font color='red'>${en}</font>` : en, "notation", {
    i18n_content: {
      zh_cn: failed ? `<font color='red'>${zh}</font>` : zh,
      en_us: failed ? `<font color='red'>${en}</font>` : en,
    },
  });
}

function formatBytes(bytes: number): string {
  const gib = bytes / 1024 ** 3;
  return `${gib.toFixed(gib >= 10 ? 1 : 2)} GiB`;
}

function money(value: number, currency: "CNY" | "USD" | undefined): string {
  return `${currency === "USD" ? "$" : "¥"}${value.toFixed(value < 1 ? 4 : 2)}`;
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
  const lines: string[] = [];
  if (
    config.footer.model &&
    usage?.requestedRef &&
    usage.resolvedRef &&
    usage.requestedRef.toLowerCase() !== usage.resolvedRef.toLowerCase()
  ) {
    lines.push(`**模型路由**  ${usage.requestedRef} → ${usage.resolvedRef}`);
  }
  if (config.footer.tokens && usage?.lastInputTokens !== undefined) {
    lines.push(
      `**末次模型调用**  输入 ${exactNumber(usage.lastInputTokens)} · 输出 ${exactNumber(usage.lastOutputTokens ?? 0)}`,
    );
  }
  if (config.footer.totals && totals.allTimeTokens > 0) {
    const tokenParts = [
      ...(config.footer.todayTokens
        ? [`今 ${compactNumber(totals.todayTokens)}`]
        : []),
      ...(config.footer.monthTokens
        ? [`月 ${compactNumber(totals.monthTokens)}`]
        : []),
      `总 ${compactNumber(totals.allTimeTokens)}`,
    ];
    lines.push(`**插件本地累计**  ${tokenParts.join(" · ")}`);
    if (totals.allTimeCost > 0) {
      lines.push(
        `**插件本地费用**  ${money(totals.allTimeCost, totals.currency)}`,
      );
    }
  }
  if (config.panels.resources && resource) {
    lines.push(
      `**主机资源**  CPU ${resource.cpuPercent?.toFixed(0) ?? "-"}% · 内存 ${formatBytes(resource.memoryUsedBytes)}/${formatBytes(resource.memoryTotalBytes)} (${resource.memoryPercent.toFixed(0)}%)`,
    );
  }
  if (config.footer.backgroundTasks && legacy) {
    const running = legacy.tasks.filter((task) => task.status === "running");
    if (running.length > 0) {
      lines.push(
        `**后台任务**  ${running
          .slice(0, 3)
          .map((task) => task.name)
          .join("、")}`,
      );
    }
  }
  if (config.footer.balance && legacy?.balances.length) {
    lines.push(
      `**余额缓存**  ${legacy.balances
        .slice(0, 3)
        .map((balance) => `${balance.platform} ¥${balance.total.toFixed(2)}`)
        .join(" · ")}`,
    );
  }
  if (lines.length === 0) return undefined;
  return panel({
    titleEn: "🔎 Diagnostics",
    titleZh: "🔎 诊断信息",
    expanded: false,
    elements: [markdown(lines.join("\n"), "notation")],
  });
}

function buildActivityStrip(
  session: SessionSnapshot,
  now: number,
): CardElement | undefined {
  if (session.status !== "running") return undefined;
  const current = session.tools.findLast((step) => step.status === "running");
  return markdown(
    `⏳ ${current ? `执行 ${current.name}` : "处理中"} · ${formatDuration(now - session.startedAt)}`,
    "notation",
  );
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
  const running = session.status === "running";

  if (config.panels.progress) {
    const progress = buildActivityStrip(session, now);
    if (progress) elements.push(progress);
  }
  if (config.panels.tools) elements.push(buildToolsPanel(session, now));

  const reasoning = session.reasoning.trim();
  const answer = session.answer.trim();
  if (config.panels.reasoning && reasoning && reasoning !== answer) {
    if (running && !answer) {
      elements.push(
        markdown(`💭 **思考中...**\n\n${reasoning.slice(-6_000)}`, "notation"),
      );
    } else {
      elements.push(buildReasoningPanel(reasoning));
    }
  }

  const fallback =
    session.status === "failed"
      ? "本次任务执行异常。"
      : session.status === "aborted"
        ? "任务已停止。"
        : session.status === "completed"
          ? "任务已完成，本次没有生成可显示的文本。"
          : "";
  const visibleAnswer = answer || fallback;
  if (visibleAnswer || running) {
    const content =
      visibleAnswer.length > MAX_ANSWER_CHARS
        ? `${visibleAnswer.slice(0, MAX_ANSWER_CHARS - 20)}\n\n…内容已截断`
        : visibleAnswer;
    elements.push(
      markdown(content, undefined, {
        ...(running
          ? {
              element_id: "streaming_content",
              text_align: "left",
              text_size: "normal_v2",
              margin: "0px 0px 0px 0px",
            }
          : {}),
      }),
    );
  }

  if (running) {
    elements.push(
      markdown(" ", undefined, {
        icon: {
          tag: "custom_icon",
          img_key: "img_v3_02vb_496bec09-4b43-4773-ad6b-0cdd103cd2bg",
          size: "16px 16px",
        },
        element_id: "loading_icon",
      }),
    );
  } else {
    if (
      config.panels.resources ||
      config.footer.totals ||
      config.footer.backgroundTasks ||
      config.footer.balance
    ) {
      const diagnostics = buildDiagnosticsPanel({
        session,
        totals: params.totals,
        config,
        ...(params.resource ? { resource: params.resource } : {}),
        ...(params.legacy ? { legacy: params.legacy } : {}),
      });
      if (diagnostics) elements.push(diagnostics);
    }
    const footer = buildRuntimeFooter({ session, config, now });
    if (footer) elements.push(footer);
  }

  const summary = (answer || reasoning || "Agent is working")
    .replace(/[*_`#>[\]()~]/g, "")
    .trim()
    .slice(0, 120);
  return fitCardByteBudget({
    schema: "2.0",
    config: {
      ...(running
        ? {
            streaming_mode: true,
            streaming_config: {
              print_frequency_ms: { default: 15 },
              print_step: { default: 1 },
              print_strategy: "fast",
            },
          }
        : { wide_screen_mode: true, update_multi: true }),
      locales: ["zh_cn", "en_us"],
      summary: {
        content: summary,
        i18n_content: { zh_cn: summary, en_us: summary },
      },
    },
    body: { elements },
  });
}

export function countCardElements(value: unknown): number {
  if (Array.isArray(value)) {
    return value.reduce<number>(
      (total, child) => total + countCardElements(child),
      0,
    );
  }
  if (!value || typeof value !== "object") return 0;
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
