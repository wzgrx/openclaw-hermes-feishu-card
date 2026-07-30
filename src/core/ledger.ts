import fs from "node:fs";
import path from "node:path";

import type { RuntimeName, UsageSnapshot, UsageTotals } from "./types.js";

interface UsageLedgerRecord {
  schemaVersion: 1;
  id: string;
  runtime: RuntimeName;
  timestamp: number;
  usage: UsageSnapshot;
}

interface NormalizedUsageLedgerRecord {
  id: string;
  runtime: RuntimeName;
  timestamp: number;
  tokens: number;
  cost: number;
  currency?: "CNY" | "USD";
}

function dateKey(timestamp: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(timestamp);
  const get = (type: string): string =>
    parts.find((part) => part.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function objectRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function finiteNumber(...values: unknown[]): number | undefined {
  return values.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
}

function normalizeRecord(
  value: unknown,
): NormalizedUsageLedgerRecord | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }
  const record = objectRecord(value);
  const runtime = record.runtime;
  const id = typeof record.id === "string" ? record.id : record.sessionId;
  const timestamp = finiteNumber(record.timestamp);
  if (
    typeof id !== "string" ||
    (runtime !== "openclaw" && runtime !== "hermes") ||
    timestamp === undefined
  ) {
    return undefined;
  }
  const usage = objectRecord(record.usage);
  const inputTokens = finiteNumber(usage.inputTokens, usage.input_tokens) ?? 0;
  const outputTokens =
    finiteNumber(usage.outputTokens, usage.output_tokens) ?? 0;
  const cacheReadTokens =
    finiteNumber(usage.cacheReadTokens, usage.cache_read_tokens) ?? 0;
  const cacheWriteTokens =
    finiteNumber(usage.cacheWriteTokens, usage.cache_write_tokens) ?? 0;
  const tokens =
    finiteNumber(record.tokens, usage.totalTokens, usage.total_tokens) ??
    inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
  const cost = finiteNumber(record.cost, usage.turnCost, usage.turn_cost) ?? 0;
  const rawCurrency = record.currency ?? usage.currency;
  const currency =
    rawCurrency === "CNY" || rawCurrency === "USD" ? rawCurrency : undefined;
  return {
    id,
    runtime,
    timestamp,
    tokens: Math.max(0, tokens),
    cost: Math.max(0, cost),
    ...(currency ? { currency } : {}),
  };
}

export class UsageLedger {
  readonly filePath: string;
  private readonly timezone: string;
  private readonly records = new Map<string, NormalizedUsageLedgerRecord>();

  constructor(params: { storageDir: string; timezone: string }) {
    this.filePath = path.join(params.storageDir, "usage.ndjson");
    this.timezone = params.timezone;
    fs.mkdirSync(params.storageDir, { recursive: true, mode: 0o700 });
    this.load();
  }

  append(params: {
    id: string;
    runtime: RuntimeName;
    usage: UsageSnapshot;
    timestamp?: number;
  }): boolean {
    this.load();
    if (this.records.has(params.id)) {
      return false;
    }
    const record: UsageLedgerRecord = {
      schemaVersion: 1,
      id: params.id,
      runtime: params.runtime,
      timestamp: params.timestamp ?? Date.now(),
      usage: params.usage,
    };
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "a",
    });
    const normalized = normalizeRecord(record);
    if (normalized) {
      this.records.set(record.id, normalized);
    }
    return true;
  }

  totals(now = Date.now()): UsageTotals {
    this.load();
    const today = dateKey(now, this.timezone);
    const month = today.slice(0, 7);
    const totals: UsageTotals = {
      todayTokens: 0,
      monthTokens: 0,
      allTimeTokens: 0,
      todayCost: 0,
      monthCost: 0,
      allTimeCost: 0,
    };
    const currencies = new Set<"CNY" | "USD">();
    for (const record of this.records.values()) {
      const key = dateKey(record.timestamp, this.timezone);
      totals.allTimeTokens += record.tokens;
      totals.allTimeCost += record.cost;
      if (key.startsWith(month)) {
        totals.monthTokens += record.tokens;
        totals.monthCost += record.cost;
      }
      if (key === today) {
        totals.todayTokens += record.tokens;
        totals.todayCost += record.cost;
      }
      if (record.currency) {
        currencies.add(record.currency);
      }
    }
    const currency = currencies.size === 1 ? [...currencies][0] : undefined;
    if (currency) {
      totals.currency = currency;
    }
    return totals;
  }

  private load(): void {
    if (!fs.existsSync(this.filePath)) {
      return;
    }
    const lines = fs.readFileSync(this.filePath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) {
        continue;
      }
      try {
        const record = normalizeRecord(JSON.parse(line));
        if (record) {
          this.records.set(record.id, record);
        }
      } catch {
        // A truncated tail can occur after an abrupt process exit. Earlier
        // complete records remain authoritative.
      }
    }
  }
}
