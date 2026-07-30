import { execFile } from "node:child_process";
import os from "node:os";
import { promisify } from "node:util";

import type { ResourceSnapshot } from "./types.js";

const execFileAsync = promisify(execFile);

export class ResourceSampler {
  private cached?: ResourceSnapshot;
  private readonly cacheMs: number;

  constructor(cacheMs = 5_000) {
    this.cacheMs = cacheMs;
  }

  async sample(now = Date.now()): Promise<ResourceSnapshot> {
    if (this.cached && now - this.cached.sampledAt < this.cacheMs) {
      return this.cached;
    }
    const total = os.totalmem();
    const used = Math.max(0, total - os.freemem());
    const cores = Math.max(1, os.cpus().length);
    const load1 = os.loadavg()[0] ?? 0;
    const snapshot: ResourceSnapshot = {
      sampledAt: now,
      cpuPercent: Math.min(100, Math.max(0, (load1 / cores) * 100)),
      loadAverage1m: load1,
      memoryUsedBytes: used,
      memoryTotalBytes: total,
      memoryPercent: total > 0 ? (used / total) * 100 : 0,
      uptimeSeconds: os.uptime(),
      ...(await this.sampleGpu()),
    };
    this.cached = snapshot;
    return snapshot;
  }

  private async sampleGpu(): Promise<Pick<ResourceSnapshot, "gpu">> {
    try {
      const { stdout } = await execFileAsync(
        "nvidia-smi",
        [
          "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
          "--format=csv,noheader,nounits",
        ],
        {
          timeout: 1_500,
          windowsHide: true,
          maxBuffer: 64 * 1024,
        },
      );
      const line = stdout.split(/\r?\n/).find(Boolean);
      if (!line) {
        return {};
      }
      const [name, utilization, memoryUsed, memoryTotal, temperature] = line
        .split(",")
        .map((value) => value.trim());
      return {
        gpu: {
          ...(name ? { name } : {}),
          ...(Number.isFinite(Number(utilization))
            ? { utilizationPercent: Number(utilization) }
            : {}),
          ...(Number.isFinite(Number(memoryUsed))
            ? { memoryUsedMiB: Number(memoryUsed) }
            : {}),
          ...(Number.isFinite(Number(memoryTotal))
            ? { memoryTotalMiB: Number(memoryTotal) }
            : {}),
          ...(Number.isFinite(Number(temperature))
            ? { temperatureC: Number(temperature) }
            : {}),
        },
      };
    } catch {
      return {};
    }
  }
}
