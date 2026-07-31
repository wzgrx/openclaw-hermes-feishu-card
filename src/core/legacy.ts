import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type {
  BalanceSummary,
  LegacyRuntimeSnapshot,
  LegacyTaskSummary,
} from "./types.js";

const MAX_FILES = 64;
const MAX_FILE_BYTES = 64 * 1024;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function finite(value: unknown): number | undefined {
  if (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "string" && value.trim() === "")
  ) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function readJson(file: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(file);
    if (raw.byteLength > MAX_FILE_BYTES) {
      return {};
    }
    return record(JSON.parse(raw.toString("utf8")));
  } catch {
    return {};
  }
}

async function readTasks(taskDir: string): Promise<LegacyTaskSummary[]> {
  let files: string[];
  try {
    files = (await readdir(taskDir))
      .filter((file) => file.endsWith(".json"))
      .sort()
      .slice(0, MAX_FILES);
  } catch {
    return [];
  }
  const tasks: LegacyTaskSummary[] = [];
  for (const file of files) {
    const value = await readJson(path.join(taskDir, file));
    const status = text(value.status).toLowerCase();
    if (status !== "running" && status !== "stalled") {
      continue;
    }
    const id =
      text(value.taskId) || text(value.id) || file.replace(/\.json$/, "");
    const name = text(value.name) || text(value.title) || id;
    const progress = finite(value.progress);
    tasks.push({
      id,
      name: name.slice(0, 120),
      status,
      ...(progress === undefined
        ? {}
        : { progress: Math.min(100, Math.max(0, progress)) }),
    });
  }
  return tasks;
}

async function readBalances(cachePath: string): Promise<BalanceSummary[]> {
  const value = await readJson(cachePath);
  const results = Array.isArray(value.results) ? value.results : [];
  return results
    .map((item): BalanceSummary | undefined => {
      const current = record(item);
      const platform = text(current.platform);
      const total = finite(current.total);
      if (!platform || total === undefined || total < 0) {
        return undefined;
      }
      return {
        platform: platform.slice(0, 80),
        total,
        available: current.available !== false,
      };
    })
    .filter((item): item is BalanceSummary => item !== undefined)
    .slice(0, 8);
}

export class LegacyRuntimeSampler {
  private cached?: { at: number; value: LegacyRuntimeSnapshot };

  constructor(
    private readonly taskDir: string,
    private readonly balanceCachePath: string,
    private readonly cacheMs = 10_000,
  ) {}

  async sample(now = Date.now()): Promise<LegacyRuntimeSnapshot> {
    if (this.cached && now - this.cached.at < this.cacheMs) {
      return this.cached.value;
    }
    const [tasks, balances] = await Promise.all([
      readTasks(this.taskDir),
      readBalances(this.balanceCachePath),
    ]);
    const value = { tasks, balances };
    this.cached = { at: now, value };
    return value;
  }
}
