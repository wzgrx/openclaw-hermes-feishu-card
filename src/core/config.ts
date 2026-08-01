import os from "node:os";
import path from "node:path";

import { z } from "zod";

import type { CardFooterConfig } from "./types.js";

const pricingRuleSchema = z.object({
  pattern: z.string().min(1),
  currency: z.enum(["CNY", "USD"]).default("CNY"),
  inputPerMillion: z.number().nonnegative(),
  outputPerMillion: z.number().nonnegative(),
  cacheReadPerMillion: z.number().nonnegative().default(0),
  cacheWritePerMillion: z.number().nonnegative().default(0),
});

const panelsSchema = z
  .object({
    reasoning: z.boolean().default(true),
    tools: z.boolean().default(true),
    progress: z.boolean().default(false),
    resources: z.boolean().default(false),
    footer: z.boolean().default(true),
  })
  .default({
    reasoning: true,
    tools: true,
    progress: false,
    resources: false,
    footer: true,
  });

const footerSchema = z
  .object({
    status: z.boolean().default(true),
    elapsed: z.boolean().default(true),
    firstToken: z.boolean().default(true),
    model: z.boolean().default(true),
    tokens: z.boolean().default(true),
    cache: z.boolean().default(true),
    context: z.boolean().default(true),
    cost: z.boolean().default(true),
    totals: z.boolean().default(false),
    todayTokens: z.boolean().default(false),
    monthTokens: z.boolean().default(false),
    backgroundTasks: z.boolean().default(false),
    balance: z.boolean().default(false),
  })
  .default({
    status: true,
    elapsed: true,
    firstToken: true,
    model: true,
    tokens: true,
    cache: true,
    context: true,
    cost: true,
    totals: false,
    todayTokens: false,
    monthTokens: false,
    backgroundTasks: false,
    balance: false,
  });

export const cardFooterConfigSchema = z.object({
  enabled: z.boolean().default(true),
  embeddedLark: z.boolean().default(true),
  captureChannels: z.array(z.string().min(1)).default(["feishu"]),
  title: z.string().min(1).default("OpenClaw"),
  accountTitles: z.record(z.string(), z.string().min(1)).default({}),
  timezone: z
    .string()
    .min(1)
    .refine(
      (value) => {
        try {
          new Intl.DateTimeFormat("en", { timeZone: value }).format();
          return true;
        } catch {
          return false;
        }
      },
      { message: "timezone must be a valid IANA time zone" },
    )
    .default("Asia/Shanghai"),
  storageDir: z.string().min(1).optional(),
  legacyTaskDir: z.string().min(1).optional(),
  balanceCachePath: z.string().min(1).optional(),
  updateIntervalMs: z.number().int().min(250).max(10_000).default(800),
  panels: panelsSchema,
  footer: footerSchema,
  pricing: z.array(pricingRuleSchema).default([]),
});

function expandHome(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/") || value.startsWith("~\\")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function resolveConfig(raw: unknown): CardFooterConfig {
  const parsed = cardFooterConfigSchema.parse(raw ?? {});
  return {
    ...parsed,
    storageDir: expandHome(
      parsed.storageDir ??
        process.env.OPENCLAW_HERMES_FEISHU_CARD_HOME ??
        process.env.FEISHU_CARD_FOOTER_HOME ??
        path.join(
          os.homedir(),
          ".local",
          "share",
          "openclaw-hermes-feishu-card",
        ),
    ),
    legacyTaskDir: expandHome(parsed.legacyTaskDir ?? "/tmp/openclaw-tasks"),
    balanceCachePath: expandHome(
      parsed.balanceCachePath ??
        path.join(os.homedir(), ".openclaw", "data", "balance-cache.json"),
    ),
  };
}
