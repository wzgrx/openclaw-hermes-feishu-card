import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { LegacyRuntimeSampler } from "../src/core/legacy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("LegacyRuntimeSampler", () => {
  it("reads bounded task and provider balance snapshots", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "openclaw-card-"));
    temporaryDirectories.push(root);
    const taskDir = path.join(root, "tasks");
    const balancePath = path.join(root, "balance-cache.json");
    await mkdir(taskDir);
    await writeFile(
      path.join(taskDir, "sync.json"),
      JSON.stringify({
        taskId: "sync",
        name: "同步知识库",
        status: "running",
        progress: 42,
      }),
    );
    await writeFile(
      balancePath,
      JSON.stringify({
        results: [
          { platform: "DeepSeek", total: 12.34, available: true },
          { platform: "Unknown", total: -1, available: false },
        ],
      }),
    );

    const snapshot = await new LegacyRuntimeSampler(
      taskDir,
      balancePath,
      0,
    ).sample();

    expect(snapshot.tasks).toEqual([
      {
        id: "sync",
        name: "同步知识库",
        status: "running",
        progress: 42,
      },
    ]);
    expect(snapshot.balances).toEqual([
      { platform: "DeepSeek", total: 12.34, available: true },
    ]);
  });
});
