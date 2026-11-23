import os from "node:os";
import { host } from "../platform/index.ts";

let prev = os.cpus().map((c) => c.times);

export function cpuPercent(): number {
  const cur = os.cpus().map((c) => c.times);
  let idle = 0;
  let total = 0;
  cur.forEach((t, i) => {
    const p = prev[i] ?? t;
    const d = (k: keyof typeof t) => t[k] - p[k];
    const tot = d("user") + d("nice") + d("sys") + d("idle") + d("irq");
    idle += d("idle");
    total += tot;
  });
  prev = cur;
  return total > 0 ? Math.round(100 * (1 - idle / total)) : 0;
}

/** Used memory %: Activity Monitor's "memory used" on macOS, MemTotal − MemAvailable on Linux. */
export const memPercent = (): Promise<number> => host.memPercent().catch(() => 0);
