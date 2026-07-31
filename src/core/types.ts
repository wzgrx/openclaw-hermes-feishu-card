export type RuntimeName = "openclaw" | "hermes";
export type CardStatus = "running" | "completed" | "failed" | "aborted";
export type ToolStatus = "running" | "completed" | "failed";
export type ReplyKind = "tool" | "block" | "final";

export interface UsageSnapshot {
  provider?: string;
  model?: string;
  resolvedRef?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  contextUsedTokens?: number;
  contextTokenBudget?: number;
  durationMs?: number;
  turnCost?: number;
  currency?: "CNY" | "USD";
}

export interface UsageTotals {
  todayTokens: number;
  monthTokens: number;
  allTimeTokens: number;
  todayCost: number;
  monthCost: number;
  allTimeCost: number;
  currency?: "CNY" | "USD";
}

export interface ToolStep {
  id: string;
  name: string;
  status: ToolStatus;
  startedAt: number;
  finishedAt?: number;
  durationMs?: number;
  inputPreview?: string;
  outputPreview?: string;
  error?: string;
}

export interface ResourceSnapshot {
  sampledAt: number;
  cpuPercent?: number;
  loadAverage1m?: number;
  memoryUsedBytes: number;
  memoryTotalBytes: number;
  memoryPercent: number;
  uptimeSeconds: number;
  gpu?: {
    name?: string;
    utilizationPercent?: number;
    memoryUsedMiB?: number;
    memoryTotalMiB?: number;
    temperatureC?: number;
  };
}

export interface LegacyTaskSummary {
  id: string;
  name: string;
  status: "running" | "stalled";
  progress?: number;
}

export interface BalanceSummary {
  platform: string;
  total: number;
  available: boolean;
}

export interface LegacyRuntimeSnapshot {
  tasks: LegacyTaskSummary[];
  balances: BalanceSummary[];
}

export interface SessionRoute {
  channelId: string;
  accountId?: string;
  conversationId?: string;
  replyToId?: string;
  threadId?: string;
}

export interface SessionSnapshot {
  id: string;
  runtime: RuntimeName;
  route?: SessionRoute;
  status: CardStatus;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  firstTokenAt?: number;
  answer: string;
  reasoning: string;
  notices: string[];
  tools: ToolStep[];
  usage?: UsageSnapshot;
  cardId?: string;
  messageId?: string;
  sequence: number;
}

export interface PricingRule {
  pattern: string;
  currency: "CNY" | "USD";
  inputPerMillion: number;
  outputPerMillion: number;
  cacheReadPerMillion: number;
  cacheWritePerMillion: number;
}

export interface PanelConfig {
  reasoning: boolean;
  tools: boolean;
  progress: boolean;
  resources: boolean;
  footer: boolean;
}

export interface FooterConfig {
  status: boolean;
  elapsed: boolean;
  firstToken: boolean;
  model: boolean;
  tokens: boolean;
  cache: boolean;
  context: boolean;
  cost: boolean;
  totals: boolean;
  todayTokens: boolean;
  monthTokens: boolean;
  backgroundTasks: boolean;
  balance: boolean;
}

export interface CardFooterConfig {
  enabled: boolean;
  captureChannels: string[];
  title: string;
  accountTitles: Record<string, string>;
  timezone: string;
  storageDir: string;
  legacyTaskDir: string;
  balanceCachePath: string;
  updateIntervalMs: number;
  panels: PanelConfig;
  footer: FooterConfig;
  pricing: PricingRule[];
}

export type CardJson = Record<string, unknown>;
