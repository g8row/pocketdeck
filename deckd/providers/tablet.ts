// The tablet's own vitals: battery, free RAM, uptime, CPU clock, Wi-Fi IP.
// Android (and Android kiosk mode, adbd is native) is read over adb; mainline
// Alpine over the ssh connection deskd keeps for its tunnel (transport.ts).

import { tabletShell, tabletVia } from "../transport.ts";

export interface TabletState {
  battery?: number;
  charging?: boolean;
  memFreeMb?: number;
  memTotalMb?: number;
  uptime?: string;
  cpuMhz?: number;
  wifi?: string;
  mode?: "android" | "kiosk" | "mainline";
}

// `dumpsys battery` is a binder call into system_server, so main.ts polls this
// every 30 s, not 5 (the shell user can't read power_supply sysfs here: SELinux).
const SCRIPT = [
  "dumpsys battery 2>/dev/null | grep -E 'level|status|USB powered|AC powered'",
  "cat /sys/class/power_supply/battery/capacity 2>/dev/null | sed 's/^/cap: /'",
  "grep -E 'MemTotal|MemAvailable' /proc/meminfo",
  "cat /proc/uptime",
  "cat /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq | sed 's/^/freq: /'",
  "ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*'",
  "getprop init.svc.zygote | sed 's/^/zygote: /'",
].join("; ");

// Mainline Linux (busybox sh): battery from power_supply when a driver exposes
// one; "os:" marks the mode.
const LINUX_SCRIPT = [
  "for b in /sys/class/power_supply/*; do [ \"$(cat $b/type 2>/dev/null)\" = Battery ] || continue; sed 's/^/cap: /' $b/capacity; sed 's/^/chg: /' $b/status; break; done 2>/dev/null",
  "grep -E 'MemTotal|MemAvailable' /proc/meminfo",
  "cat /proc/uptime",
  "sed 's/^/freq: /' /sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq 2>/dev/null",
  "ip -4 addr show wlan0 2>/dev/null | grep -o 'inet [0-9.]*'",
  "echo os: linux",
].join("; ");

export function parseTablet(out: string): TabletState {
  const num = (re: RegExp) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const up = num(/^(\d+)\.\d+ /m);
  const h = up !== undefined ? Math.floor(up / 3600) : undefined;
  const m = up !== undefined ? Math.floor((up % 3600) / 60) : undefined;
  return {
    battery: num(/level: (\d+)/) ?? num(/cap: (\d+)/),
    charging: /status: 2|USB powered: true|AC powered: true|chg: (Charging|Full)/.test(out),
    memFreeMb: (() => { const v = num(/MemAvailable:\s+(\d+)/); return v ? Math.round(v / 1024) : undefined; })(),
    memTotalMb: (() => { const v = num(/MemTotal:\s+(\d+)/); return v ? Math.round(v / 1024) : undefined; })(),
    uptime: h !== undefined ? `${h}h ${m}m` : undefined,
    cpuMhz: (() => { const v = num(/freq: (\d+)/); return v ? Math.round(v / 1000) : undefined; })(),
    wifi: /inet ([0-9.]+)/.exec(out)?.[1],
    mode: /^os: linux/m.test(out) ? "mainline" : /zygote: running/.test(out) ? "android" : "kiosk",
  };
}

export async function readTablet(): Promise<TabletState | null> {
  const r = await tabletShell(tabletVia() === "ssh" ? LINUX_SCRIPT : SCRIPT);
  return r ? parseTablet(r.out) : null;
}
