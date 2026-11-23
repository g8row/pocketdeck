// The tablet's own vitals: battery, free RAM, uptime, CPU clock, Wi-Fi IP.
// Android (and Android kiosk mode, adbd is native) is read over adb; mainline
// Alpine over the ssh connection deckd keeps for its tunnel (transport.ts).

import { tabletShell, tabletVia } from "../transport.ts";

export interface TabletState {
  battery?: number;
  charging?: boolean;
  memFreeMb?: number;
  memTotalMb?: number;
  uptime?: string;
  cpuMhz?: number;
  wifi?: string;
  /** "linux" = mainline Alpine ("mainline" before the redesign; parseTablet maps it). */
  mode?: "android" | "kiosk" | "linux";
  /** Battery temperature, °C. */
  tempC?: number;
  /** Battery voltage, V. */
  volts?: number;
  /** Battery current, mA: positive = charging, negative = discharging. */
  currentMa?: number;
}

// `dumpsys battery` is a binder call into system_server, so main.ts polls this
// every 30 s, not 5 (the shell user can't read power_supply sysfs here: SELinux).
const SCRIPT = [
  "dumpsys battery 2>/dev/null | grep -E 'level|status|USB powered|AC powered|temperature|^ *voltage'",
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
  "for b in /sys/class/power_supply/*; do [ \"$(cat $b/type 2>/dev/null)\" = Battery ] || continue; sed 's/^/cap: /' $b/capacity; sed 's/^/chg: /' $b/status; sed 's/^/temp: /' $b/temp; sed 's/^/uv: /' $b/voltage_now; sed 's/^/ua: /' $b/current_now; break; done 2>/dev/null",
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
  const charging = /status: 2|USB powered: true|AC powered: true|chg: (Charging|Full)/.test(out);
  // sysfs (Linux): temp in 0.1 °C, voltage_now µV, current_now µA. dumpsys (Android): temperature
  // in 0.1 °C, voltage in mV, no current.
  const temp = num(/^temp: (-?\d+)/m) ?? num(/^\s*temperature: (-?\d+)/m);
  const uv = num(/^uv: (\d+)/m);
  const mv = num(/^\s*voltage: (\d+)/m);
  const volts = uv !== undefined ? uv / 1e6 : mv !== undefined ? mv / 1e3 : undefined;
  let ua = num(/^ua: (-?\d+)/m);
  // drivers disagree on the sign; normalise to positive = charging using the reported status
  if (ua !== undefined) {
    if (/^chg: Discharging/m.test(out) && ua > 0) ua = -ua;
    else if (/^chg: Charging/m.test(out) && ua < 0) ua = -ua;
  }
  return {
    battery: num(/level: (\d+)/) ?? num(/cap: (\d+)/),
    charging,
    memFreeMb: (() => { const v = num(/MemAvailable:\s+(\d+)/); return v ? Math.round(v / 1024) : undefined; })(),
    memTotalMb: (() => { const v = num(/MemTotal:\s+(\d+)/); return v ? Math.round(v / 1024) : undefined; })(),
    uptime: h !== undefined ? `${h}h ${m}m` : undefined,
    cpuMhz: (() => { const v = num(/freq: (\d+)/); return v ? Math.round(v / 1000) : undefined; })(),
    wifi: /inet ([0-9.]+)/.exec(out)?.[1],
    mode: /^os: (linux|mainline)/m.test(out) ? "linux" : /zygote: running/.test(out) ? "android" : "kiosk",
    ...(temp !== undefined ? { tempC: Math.round(temp) / 10 } : {}),
    ...(volts !== undefined && volts > 0 ? { volts: Math.round(volts * 100) / 100 } : {}),
    ...(ua !== undefined ? { currentMa: Math.round(ua / 1000) } : {}),
  };
}

export async function readTablet(): Promise<TabletState | null> {
  const r = await tabletShell(tabletVia() === "ssh" ? LINUX_SCRIPT : SCRIPT);
  return r ? parseTablet(r.out) : null;
}
