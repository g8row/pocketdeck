import os from "node:os";
import { host } from "../platform/index.ts";
import { History } from "./hist.ts";

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

// ---- the BOARD's sys state: totals, clock, and the 1m / 10m / 1h history ------------------

const GIB = 1024 ** 3;
const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** Average current clock in GHz, or undefined when the OS reports nothing useful
 *  (Apple silicon gives a nominal few-MHz value). */
export function cpuGhz(speedsMhz: number[]): number | undefined {
  const s = speedsMhz.filter((v) => v >= 200);
  return s.length ? round(s.reduce((a, b) => a + b, 0) / s.length / 1000, 2) : undefined;
}

const hist = { cpu: new History(), mem: new History() };

/** One 2 s tick: sample, fold into the history, return the full `sys` state. */
export async function sysState() {
  const cpu = cpuPercent();
  const m = await host.memInfo().catch(() => null);
  const mem = m ? Math.max(0, Math.min(100, Math.round((100 * m.used) / m.total))) : await memPercent();
  hist.cpu.push(cpu);
  hist.mem.push(mem);
  const cpus = os.cpus();
  const ghz = cpuGhz(cpus.map((c) => c.speed));
  return {
    cpu,
    mem,
    cores: cpus.length,
    ...(ghz !== undefined ? { ghz } : {}),
    ...(m ? { memUsedGb: round(m.used / GIB, 1), memTotalGb: round(m.total / GIB, 1) } : {}),
    hist: { cpu: hist.cpu.state(), mem: hist.mem.state() },
  };
}
