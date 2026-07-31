#!/usr/bin/env node
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const configPath = path.resolve(
  valueAfter("--config", path.join(os.homedir(), ".openclaw", "openclaw.json")),
);
const outputPath = path.resolve(
  valueAfter(
    "--output",
    path.join(os.homedir(), ".openclaw", "data", "balance-cache.json"),
  ),
);

const config = JSON.parse(await readFile(configPath, "utf8"));
const providers = config?.models?.providers ?? {};
const stringKey = (value) =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

async function request(url, apiKey) {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return response.json();
}

async function deepseek(apiKey) {
  const data = await request("https://api.deepseek.com/user/balance", apiKey);
  const info = Array.isArray(data?.balance_infos)
    ? data.balance_infos[0]
    : undefined;
  return {
    platform: "DeepSeek",
    total: Number(info?.total_balance ?? 0),
    available: data?.is_available === true,
  };
}

async function siliconFlow(apiKey) {
  const data = await request("https://api.siliconflow.cn/v1/user/info", apiKey);
  const status = String(data?.data?.status ?? "").toLowerCase();
  return {
    platform: "硅基流动",
    total: Number(data?.data?.totalBalance ?? 0),
    available:
      data?.status === true && (status === "normal" || status === "active"),
  };
}

const checks = [
  [stringKey(providers.deepseek?.apiKey), deepseek],
  [stringKey(providers.siliconflow?.apiKey), siliconFlow],
];
const results = [];
for (const [apiKey, checker] of checks) {
  if (!apiKey) {
    continue;
  }
  try {
    const result = await checker(apiKey);
    if (Number.isFinite(result.total) && result.total >= 0) {
      results.push(result);
    }
  } catch (error) {
    results.push({
      platform: checker === deepseek ? "DeepSeek" : "硅基流动",
      total: 0,
      available: false,
      error: String(error),
    });
  }
}

const output = {
  ts: Date.now(),
  results,
};
await mkdir(path.dirname(outputPath), { recursive: true });
const tempPath = `${outputPath}.${process.pid}.tmp`;
await writeFile(tempPath, `${JSON.stringify(output, undefined, 2)}\n`, {
  mode: 0o600,
});
await rename(tempPath, outputPath);
process.stdout.write(
  `${JSON.stringify({ output: outputPath, providers: results.length })}\n`,
);
