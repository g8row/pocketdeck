// Linux: PipeWire/PulseAudio for volumes, MPRIS for music, freedesktop D-Bus
// for notifications and idle inhibit, logind for locking. Desktop-specific
// bits (screen off, screenshot, terminal, raising a window) try KDE, GNOME,
// wlroots and X11 tools in turn and use the first one that exists.

import { $ } from "bun";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import * as mpris from "../providers/mpris.ts";
import { Bus } from "./dbus.ts";
import type { Host, HostState, MemInfo, ScreenState } from "./types.ts";

const has = (cmd: string) => !!Bun.which(cmd);
const desktop = (process.env.XDG_CURRENT_DESKTOP ?? "").toUpperCase();
const isKDE = desktop.includes("KDE");
const isGNOME = desktop.includes("GNOME");
const wayland = !!process.env.WAYLAND_DISPLAY || process.env.XDG_SESSION_TYPE === "wayland";

/** Start a GUI program and forget it (no wait, no output). */
function launch(argv: string[], cwd?: string): boolean {
  if (!has(argv[0]!)) return false;
  try {
    const p = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env });
    p.unref();
    return true;
  } catch {
    return false;
  }
}

/** Run argv lists in order until one exits 0. */
async function first(...cmds: string[][]): Promise<boolean> {
  for (const c of cmds) {
    if (!has(c[0]!)) continue;
    const r = await $`${c}`.quiet().nothrow();
    if (r.exitCode === 0) return true;
  }
  return false;
}

// ---- audio ---------------------------------------------------------------------

/** "Volume: 0.40 [MUTED]" → [40, true] */
export function parseWpctl(out: string): [number, boolean] | null {
  const m = /Volume:\s*([\d.]+)/.exec(out);
  return m ? [Math.round(Number(m[1]) * 100), /MUTED/.test(out)] : null;
}

/** pactl get-*-volume / get-*-mute → [percent, muted] */
export function parsePactl(vol: string, mute: string): [number, boolean] | null {
  const m = /(\d+)%/.exec(vol);
  return m ? [Number(m[1]), /Mute:\s*yes/.test(mute)] : null;
}

type Dev = "sink" | "source";
const WP: Record<Dev, string> = { sink: "@DEFAULT_AUDIO_SINK@", source: "@DEFAULT_AUDIO_SOURCE@" };
const PA: Record<Dev, string> = { sink: "@DEFAULT_SINK@", source: "@DEFAULT_SOURCE@" };

/** The microphone to use, from `pactl get-default-source` and `pactl list short sources`: the default source, unless
 *  it is a sink's monitor (no microphone chosen), then the first real input; null = no microphone. */
export function pickSource(def: string, list: string): string | null {
  const real = (n: string) => !!n && !n.endsWith(".monitor");
  const d = def.trim();
  if (real(d)) return d;
  const names = list.split("\n").map((l) => l.split("\t")[1]?.trim() ?? "");
  return names.find(real) ?? null;
}

/** Where a device's commands go. With no microphone chosen, PipeWire resolves @DEFAULT_AUDIO_SOURCE@ to the
 *  default SINK (the monitor's owner), so the default-source alias would mute the speakers: sources are resolved
 *  to a real input by name (pactl), or verified to be an Audio/Source (wpctl only), or there is none. */
type Target = { wp?: string; pa?: string } | null;
async function target(d: Dev): Promise<Target> {
  if (d === "sink") return { wp: has("wpctl") ? WP.sink : undefined, pa: has("pactl") ? PA.sink : undefined };
  if (has("pactl")) {
    const [def, list] = await Promise.all([$`pactl get-default-source`.quiet().nothrow(), $`pactl list short sources`.quiet().nothrow()]);
    const name = pickSource(def.stdout.toString(), list.stdout.toString());
    return name ? { pa: name } : null;
  }
  if (has("wpctl")) {
    const r = await $`wpctl inspect ${WP.source}`.quiet().nothrow();
    return /media\.class = "Audio\/Source"/.test(r.stdout.toString()) ? { wp: WP.source } : null;
  }
  return {}; // amixer only
}

async function getVol(d: Dev): Promise<[number, boolean] | null> {
  const t = await target(d);
  if (!t) return null;
  if (t.wp) {
    const r = await $`wpctl get-volume ${t.wp}`.quiet().nothrow();
    const v = r.exitCode === 0 ? parseWpctl(r.stdout.toString()) : null;
    if (v) return v;
  }
  if (t.pa) {
    const [v, m] = await Promise.all([$`pactl get-${d}-volume ${t.pa}`.quiet().nothrow(), $`pactl get-${d}-mute ${t.pa}`.quiet().nothrow()]);
    return parsePactl(v.stdout.toString(), m.stdout.toString());
  }
  return null;
}

async function stepVol(d: Dev, delta: number): Promise<void> {
  const step = `${Math.abs(delta)}%${delta > 0 ? "+" : "-"}`;
  const t = await target(d);
  if (!t) return;
  if (t.wp && (await $`wpctl set-volume -l 1.0 ${t.wp} ${step}`.quiet().nothrow()).exitCode === 0) return;
  if (t.pa) {
    const cur = (await getVol(d))?.[0] ?? 0;
    const next = Math.max(0, Math.min(100, cur + delta));
    await $`pactl set-${d}-volume ${t.pa} ${next}%`.quiet().nothrow();
    return;
  }
  await first(["amixer", "-q", "sset", d === "sink" ? "Master" : "Capture", step]);
}

async function toggleMute(d: Dev): Promise<void> {
  const t = await target(d);
  if (!t) return;
  if (t.wp && (await $`wpctl set-mute ${t.wp} toggle`.quiet().nothrow()).exitCode === 0) return;
  if (t.pa && (await $`pactl set-${d}-mute ${t.pa} toggle`.quiet().nothrow()).exitCode === 0) return;
  await first(["amixer", "-q", "sset", d === "sink" ? "Master" : "Capture", "toggle"]);
}

// ---- caffeine: idle + sleep inhibit held by deckd --------------------------------

// The ScreenSaver inhibit (screen dim/lock; KDE, GNOME, Xfce…) lives as long as
// our bus connection; the logind one (sleep, and idle on desktops that read it)
// as long as the systemd-inhibit child. Both go away with deckd.
let caffeineBus: Bus | null = null;
let caffeineProc: ReturnType<typeof Bun.spawn> | null = null;
const caffeineOn = () => !!caffeineBus?.connected || (!!caffeineProc && caffeineProc.exitCode === null);

// One toggle at a time: turning on awaits the bus, and a second tap in that window would see "off" too, open a
// second connection and lose the first (an inhibit nobody can release short of restarting deckd).
let caffeineBusy: Promise<void> | null = null;
function caffeineToggle(): Promise<void> {
  if (!caffeineBusy) caffeineBusy = caffeineFlip().finally(() => (caffeineBusy = null));
  return caffeineBusy;
}

/** KDE's power widget lists the ScreenSaver inhibit only after it has been held ~5 s (PowerDevil's delay). */
async function caffeineFlip(): Promise<void> {
  if (caffeineOn()) {
    caffeineBus?.close();
    caffeineBus = null;
    caffeineProc?.kill();
    caffeineProc = null;
    return;
  }
  try {
    const bus = await Bus.session();
    await bus
      .call("org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "Inhibit", [{ s: "deckd" }, { s: "PocketDeck: caffeine" }])
      .catch(() =>
        // GNOME without the freedesktop name: inhibit idle (8) + suspend (4)
        bus.call("org.gnome.SessionManager", "/org/gnome/SessionManager", "org.gnome.SessionManager", "Inhibit", [{ s: "deckd" }, { u: 0 }, { s: "PocketDeck: caffeine" }, { u: 12 }]),
      );
    caffeineBus = bus;
  } catch {}
  if (has("systemd-inhibit")) {
    caffeineProc = Bun.spawn(["systemd-inhibit", "--what=idle:sleep", "--who=deckd", "--why=PocketDeck: caffeine", "--mode=block", "sleep", "infinity"], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
  }
}

// ---- Do Not Disturb: a notification inhibit held by deckd (Plasma, GNOME 46+, others with the 1.3 spec) --------

const NOTIF = ["org.freedesktop.Notifications", "/org/freedesktop/Notifications", "org.freedesktop.Notifications"] as const;
let dndBus: Bus | null = null;
let dndBusy: Promise<void> | null = null;

async function busProp(dest: string, path: string, iface: string, prop: string): Promise<boolean | null> {
  if (!has("busctl")) return null;
  const r = await $`busctl --user get-property ${dest} ${path} ${iface} ${prop}`.quiet().nothrow();
  const m = /^b (true|false)/.exec(r.stdout.toString().trim());
  return m ? m[1] === "true" : null;
}

/** On = deckd holds an inhibit or someone else (the widget) has notifications held back. */
async function dndState(): Promise<boolean | null> {
  if (dndBus?.connected) return true;
  return busProp(...NOTIF, "Inhibited");
}

/** Plasma's own switch (the notifications widget) stores DND as an end time in plasmanotifyrc. */
async function plasmaDndUntil(): Promise<string> {
  if (!isKDE || !has("kreadconfig6")) return "";
  return (await $`kreadconfig6 --file plasmanotifyrc --group DoNotDisturb --key Until`.quiet().nothrow()).stdout.toString().trim();
}

function dndToggle(): Promise<void> {
  dndBusy ??= (async () => {
    if (await dndState()) {
      // off, whoever turned it on: our inhibit, and Plasma's widget switch (cleared the way the widget does)
      dndBus?.close(); // the server drops the inhibit with our connection
      dndBus = null;
      if (await plasmaDndUntil()) await $`kwriteconfig6 --notify --file plasmanotifyrc --group DoNotDisturb --key Until --delete`.quiet().nothrow();
      return;
    }
    const bus = await Bus.session();
    try {
      await bus.call(...NOTIF, "Inhibit", [{ s: "deckd" }, { s: "PocketDeck: do not disturb" }, { asv: {} }]);
      dndBus = bus;
    } catch (e) {
      bus.close();
      throw e;
    }
  })().finally(() => (dndBusy = null));
  return dndBusy;
}

// ---- change watchers: volume / mute (pactl subscribe), DND and Night Light (PropertiesChanged) --------------

const watchers: ReturnType<typeof Bun.spawn>[] = [];
process.on("exit", () => watchers.forEach((p) => p.kill()));

/** Run `argv` for as long as deckd lives (restarted 5 s after it exits); every output line passing `hit`
 *  calls `changed`, coalesced over 150 ms (one volume-key press is a burst of events). */
function follow(argv: string[], hit: (line: string) => boolean, changed: () => void) {
  if (!has(argv[0]!)) return;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const start = () => {
    const p = Bun.spawn(argv, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    watchers.push(p);
    (async () => {
      let rest = "";
      for await (const chunk of p.stdout as ReadableStream<Uint8Array>) {
        const lines = (rest + new TextDecoder().decode(chunk)).split("\n");
        rest = lines.pop() ?? "";
        if (lines.some(hit) && !timer)
          timer = setTimeout(() => {
            timer = null;
            changed();
          }, 150);
      }
    })().catch(() => {});
    p.exited.then(() => {
      watchers.splice(watchers.indexOf(p), 1);
      setTimeout(start, 5000);
    });
  };
  start();
}

function watch(changed: () => void): void {
  follow(["pactl", "subscribe"], (l) => /'(change|new|remove)' on (sink|source|server)/.test(l), changed);
  const props = (path: string) => `type='signal',interface='org.freedesktop.DBus.Properties',member='PropertiesChanged',path='${path}'`;
  follow(["dbus-monitor", "--session", props("/org/freedesktop/Notifications"), props("/org/kde/KWin/NightLight")], (l) => l.startsWith("signal"), changed);
}

// ---- Night Light (KWin): KWin's own inhibit only pauses a configured Night Light, so this flips the setting ----

const NIGHT = ["org.kde.KWin.NightLight", "/org/kde/KWin/NightLight", "org.kde.KWin.NightLight"] as const;
const nightState = () => (isKDE ? busProp(...NIGHT, "enabled") : Promise.resolve(null));

async function nightToggle(): Promise<void> {
  if (!isKDE || !has("kwriteconfig6")) throw new Error("Night Light needs KDE Plasma 6");
  const on = !(await nightState());
  // never configured: "always on" (the default, Automatic, would do nothing until sunset)
  const mode = (await $`kreadconfig6 --file kwinrc --group NightColor --key Mode`.quiet().nothrow()).stdout.toString().trim();
  if (on && !mode) await $`kwriteconfig6 --file kwinrc --group NightColor --key Mode Constant`.quiet();
  // --notify is what KWin listens to (its D-Bus reconfigure doesn't re-read Night Light), and KConfig only notifies
  // on a real change: write the opposite first in case the file and KWin disagree
  await $`kwriteconfig6 --file kwinrc --group NightColor --key Active ${String(!on)}`.quiet();
  await $`kwriteconfig6 --notify --file kwinrc --group NightColor --key Active ${String(on)}`.quiet();
}

const canCaffeine = () => has("systemd-inhibit") || !!process.env.DBUS_SESSION_BUS_ADDRESS || existsSync(`/run/user/${process.getuid?.()}/bus`);

// ---- lock / screen off / screenshot ------------------------------------------------

/** The user's graphical logind session (deckd may run outside it, e.g. as a user service). */
async function graphicalSession(): Promise<string | null> {
  if (process.env.XDG_SESSION_ID) return process.env.XDG_SESSION_ID;
  const r = await $`loginctl show-user ${process.env.USER ?? String(process.getuid?.())} -p Display --value`.quiet().nothrow();
  const id = r.stdout.toString().trim();
  return id || null;
}

async function lock(): Promise<void> {
  const s = await graphicalSession();
  if (s && has("loginctl") && (await $`loginctl lock-session ${s}`.quiet().nothrow()).exitCode === 0) return;
  await first(
    ["gdbus", "call", "--session", "--dest", "org.freedesktop.ScreenSaver", "--object-path", "/org/freedesktop/ScreenSaver", "--method", "org.freedesktop.ScreenSaver.Lock"],
    ["xdg-screensaver", "lock"],
  );
}

async function displayOff(): Promise<void> {
  // let the finger leave the tablet first: some compositors wake on the next input event
  await Bun.sleep(300);
  if (isKDE && (await first(["kscreen-doctor", "--dpms", "off"]))) return;
  if (isKDE && (await first(["qdbus6", "org.kde.kglobalaccel", "/component/org_kde_powerdevil", "invokeShortcut", "Turn Off Screen"], ["qdbus", "org.kde.kglobalaccel", "/component/org_kde_powerdevil", "invokeShortcut", "Turn Off Screen"]))) return;
  if (isGNOME && (await first(["busctl", "--user", "set-property", "org.gnome.Mutter.DisplayConfig", "/org/gnome/Mutter/DisplayConfig", "org.gnome.Mutter.DisplayConfig", "PowerSaveMode", "i", "1"]))) return;
  if (wayland && (await first(["wlopm", "--off", "*"]))) return;
  await first(["xset", "dpms", "force", "off"]);
}

function picturesDir(): string {
  for (const k of ["DESKTOP", "PICTURES"]) {
    const r = Bun.spawnSync(["xdg-user-dir", k], { stdout: "pipe", stderr: "ignore" });
    const d = r.success ? r.stdout.toString().trim() : "";
    if (d && d !== process.env.HOME && existsSync(d)) return d;
  }
  return process.env.HOME ?? tmpdir();
}

/** Pick a region on screen, copy it to the clipboard. Falls back to a full-screen file in ~/Pictures where no
 *  region tool exists. Resolves when the selection is made (or cancelled). */
async function screenshot(): Promise<void> {
  const region: string[][] = [
    ...(isKDE ? [["spectacle", "-r", "-b", "-n", "-c"]] : []),
    ...(isGNOME ? [["gnome-screenshot", "-a", "-c"]] : []),
  ];
  if (wayland && has("grim") && has("slurp") && has("wl-copy")) region.push(["sh", "-c", 'grim -g "$(slurp)" - | wl-copy -t image/png']);
  if (!wayland && has("maim") && has("xclip")) region.push(["sh", "-c", "maim -s | xclip -selection clipboard -t image/png"]);
  if (await first(...region)) return;
  const f = join(picturesDir(), `desk-${new Date().toISOString().replace(/[:.]/g, "-")}.png`);
  await first(
    ...(isKDE ? [["spectacle", "-b", "-n", "-f", "-o", f]] : []),
    ...(isGNOME ? [["gnome-screenshot", "-f", f]] : []),
    ...(wayland ? [["grim", f]] : []),
    ["spectacle", "-b", "-n", "-f", "-o", f],
    ["gnome-screenshot", "-f", f],
    ["grim", f],
    ["maim", f],
    ["scrot", f],
    ["import", "-window", "root", f],
  );
}

// ---- terminals and editors -----------------------------------------------------------

/** How to start terminal `t` in `cwd`, optionally running `cmd`. */
export function terminalArgv(t: string, cwd: string, cmd?: string[]): string[] {
  const name = basename(t);
  const run = (flag: string[]) => (cmd ? [...flag, ...cmd] : []);
  switch (name) {
    case "konsole":
      return [t, "--workdir", cwd, ...run(["-e"])];
    case "gnome-terminal":
    case "kgx":
    case "ptyxis":
    case "tilix":
    case "xfce4-terminal":
    case "mate-terminal":
      return [t, `--working-directory=${cwd}`, ...(cmd ? (name === "xfce4-terminal" || name === "mate-terminal" ? ["-x", ...cmd] : ["--", ...cmd]) : [])];
    case "alacritty":
      return [t, "--working-directory", cwd, ...run(["-e"])];
    case "kitty":
      return [t, "--directory", cwd, ...(cmd ?? [])];
    case "foot":
      return [t, `--working-directory=${cwd}`, ...(cmd ?? [])];
    case "wezterm":
      return [t, "start", "--cwd", cwd, ...(cmd ? ["--", ...cmd] : [])];
    case "ghostty":
      return [t, `--working-directory=${cwd}`, ...run(["-e"])];
    default: // xterm, urxvt, st…: -e and the spawn cwd
      return [t, ...run(["-e"])];
  }
}

function pickTerminal(): string | null {
  const prefs = [
    process.env.TERMINAL,
    ...(isKDE ? ["konsole"] : []),
    ...(isGNOME ? ["ptyxis", "kgx", "gnome-terminal"] : []),
    "x-terminal-emulator",
    "konsole",
    "gnome-terminal",
    "ptyxis",
    "kgx",
    "ghostty",
    "kitty",
    "alacritty",
    "foot",
    "wezterm",
    "xfce4-terminal",
    "tilix",
    "xterm",
  ];
  for (const p of prefs) {
    if (!p) continue;
    const w = Bun.which(p);
    if (!w) continue;
    // x-terminal-emulator is an alternatives symlink: resolve it to learn its flags
    try {
      return p === "x-terminal-emulator" ? realpathSync(w).replace(/\.wrapper$/, "") : w;
    } catch {
      return w;
    }
  }
  return null;
}

function openTerminal(cwd: string, cmd?: string[]): boolean {
  const t = pickTerminal();
  return !!t && launch(terminalArgv(t, cwd, cmd), cwd);
}

/** Deck Studio stores the macOS app name ("Visual Studio Code"); map it to a command. */
export function editorCommand(editor: string): string[] {
  const known: Record<string, string[]> = {
    "visual studio code": ["code"],
    vscode: ["code"],
    code: ["code"],
    vscodium: ["codium"],
    cursor: ["cursor"],
    zed: ["zeditor", "zed"],
    "sublime text": ["subl"],
    kate: ["kate"],
    "gnome text editor": ["gnome-text-editor"],
    "jetbrains fleet": ["fleet"],
    "intellij idea": ["idea"],
    webstorm: ["webstorm"],
  };
  return known[editor.trim().toLowerCase()] ?? [editor.trim()];
}

async function openFolder(cwd: string): Promise<void> {
  if (!launch(["xdg-open", cwd])) launch(["gio", "open", cwd]);
}

// ---- notifications, sound, clipboard ---------------------------------------------------

async function notify(title: string, body: string): Promise<void> {
  if (has("notify-send") && (await $`notify-send -a deckd ${title} ${body}`.quiet().nothrow()).exitCode === 0) return;
  await first([
    "gdbus", "call", "--session", "--dest", "org.freedesktop.Notifications", "--object-path", "/org/freedesktop/Notifications",
    "--method", "org.freedesktop.Notifications.Notify", "deckd", "0", "", title, body, "[]", "{}", "5000",
  ]);
}

const SOUNDS = ["/usr/share/sounds/freedesktop/stereo/message-new-instant.oga", "/usr/share/sounds/freedesktop/stereo/message.oga", "/usr/share/sounds/freedesktop/stereo/complete.oga"];

async function sound(): Promise<void> {
  const f = SOUNDS.find(existsSync);
  if (f) {
    if (await first(["pw-play", "--volume", "0.25", f], ["paplay", "--volume=16384", f])) return;
  }
  await first(["canberra-gtk-play", "-i", "message-new-instant"]);
}

async function copy(text: string): Promise<void> {
  const cmds = [...(wayland ? [["wl-copy"]] : []), ["xclip", "-selection", "clipboard"], ["xsel", "-ib"], ["wl-copy"]];
  for (const c of cmds) {
    if (!has(c[0]!)) continue;
    const p = Bun.spawn(c, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    p.stdin.write(text);
    p.stdin.end();
    // wl-copy and xclip fork a server that keeps the selection; don't wait on it
    const code = await Promise.race([p.exited, Bun.sleep(1000).then(() => 0)]);
    if (code === 0) return;
  }
}

// ---- raising a Claude Code session ---------------------------------------------------------

/** KWin's window runner (the one KRunner uses): matches open windows by title.
 *  Returns [id, title][] for one query. */
async function kwinWindows(query: string): Promise<[string, string][]> {
  if (!isKDE) return [];
  const r = await $`busctl --user --json=short call org.kde.KWin /WindowsRunner org.kde.krunner1 Match s ${query}`.quiet().nothrow();
  if (r.exitCode !== 0) return [];
  try {
    const rows: any[] = JSON.parse(r.stdout.toString()).data?.[0] ?? [];
    return rows.map((m) => [String(m[0]), String(m[1])] as [string, string]);
  } catch {
    return [];
  }
}

/** Pick the window to raise: a title containing the needle, terminals first. */
export function pickWindow(rows: [string, string][], needle: string): string | null {
  const n = needle.toLowerCase();
  const hits = rows.filter(([, t]) => t.toLowerCase().includes(n));
  const term = /konsole|terminal|kitty|alacritty|foot|wezterm|ghostty|xterm|tmux|zsh|bash|fish|✳/i;
  hits.sort((a, b) => Number(term.test(b[1])) - Number(term.test(a[1])));
  return hits[0]?.[0] ?? null;
}

async function kwinRaise(needles: string[]): Promise<boolean> {
  for (const n of needles) {
    const id = pickWindow(await kwinWindows(n), n);
    if (id && (await $`busctl --user call org.kde.KWin /WindowsRunner org.kde.krunner1 Run ss ${id} ${""}`.quiet().nothrow()).exitCode === 0) return true;
  }
  return false;
}

async function wmctrlRaise(needles: string[]): Promise<boolean> {
  if (!has("wmctrl") || wayland) return false;
  for (const n of needles) if ((await $`wmctrl -a ${n}`.quiet().nothrow()).exitCode === 0) return true;
  return false;
}

/** The Claude desktop app, if this machine has one (community builds). */
function claudeDesktop(): string[] | null {
  for (const c of ["claude-desktop", "claude-desktop-bin"]) if (has(c)) return [c];
  const dirs = [join(process.env.HOME ?? "", ".local/share/applications"), "/usr/share/applications", "/var/lib/flatpak/exports/share/applications"];
  for (const d of dirs)
    for (const f of ["claude-desktop.desktop", "com.anthropic.Claude.desktop", "claude.desktop"])
      if (existsSync(join(d, f))) return ["gtk-launch", f.replace(/\.desktop$/, "")];
  return null;
}

// ---- memory -------------------------------------------------------------------------

export function memFromMeminfo(s: string): number {
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(s)?.[1] ?? 0);
  const total = get("MemTotal");
  if (!total) return 0;
  return Math.max(0, Math.min(100, Math.round((100 * (total - get("MemAvailable"))) / total)));
}

/** /proc/meminfo → used (MemTotal − MemAvailable) and total, bytes. */
export function memInfoFromMeminfo(s: string): MemInfo | null {
  const get = (k: string) => Number(new RegExp(`^${k}:\\s+(\\d+)`, "m").exec(s)?.[1] ?? 0) * 1024;
  const total = get("MemTotal");
  return total ? { used: Math.max(0, total - get("MemAvailable")), total } : null;
}

// ---- screen: locked / asleep ---------------------------------------------------------

/** DRM connectors as [status, dpms] ("connected", "On"). Asleep = every connected output is off. */
export function displaysAsleep(conns: [string, string][]): boolean {
  const on = conns.filter(([st]) => st.trim() === "connected");
  return on.length > 0 && on.every(([, dpms]) => dpms.trim() !== "On");
}

function readDrm(): [string, string][] {
  const out: [string, string][] = [];
  try {
    for (const c of readdirSync("/sys/class/drm")) {
      if (!/^card\d+-/.test(c)) continue;
      try {
        out.push([readFileSync(`/sys/class/drm/${c}/status`, "utf8"), readFileSync(`/sys/class/drm/${c}/dpms`, "utf8")]);
      } catch {}
    }
  } catch {}
  return out;
}

/** `loginctl show-session -p LockedHint` output → locked? */
export const lockedHint = (out: string) => /^LockedHint=yes$/m.test(out);

let sessionId: string | null = null;
async function screen(): Promise<ScreenState> {
  if (displaysAsleep(readDrm())) return "asleep";
  if (!sessionId) sessionId = has("loginctl") ? await graphicalSession() : null;
  if (!sessionId) return "active";
  const r = await $`loginctl show-session ${sessionId} -p LockedHint`.quiet().nothrow();
  return lockedHint(r.stdout.toString()) ? "locked" : "active";
}

// ---- the host -------------------------------------------------------------------------

async function readState(): Promise<HostState | null> {
  const [out, inp] = await Promise.all([getVol("sink"), getVol("source")]);
  if (!out) return null;
  return {
    out: out[0],
    muted: out[1],
    input: inp?.[1] ? 0 : (inp?.[0] ?? 0),
    micMuted: inp ? inp[1] || inp[0] === 0 : true,
    caffeine: canCaffeine() ? caffeineOn() : null,
    dnd: await dndState().catch(() => null),
    nightLight: await nightState().catch(() => null),
  };
}

const deName = isKDE ? "KDE" : isGNOME ? "GNOME" : desktop || "no desktop";

export const linux: Host = {
  name: `Linux (${deName}, ${wayland ? "Wayland" : process.env.DISPLAY ? "X11" : "headless"})`,

  async memPercent() {
    try {
      return memFromMeminfo(readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return 0;
    }
  },

  async memInfo() {
    try {
      return memInfoFromMeminfo(readFileSync("/proc/meminfo", "utf8"));
    } catch {
      return null;
    }
  },

  screen,

  readState,

  watch,

  actions: {
    "mic.toggle": () => toggleMute("source"),
    "vol.down": () => stepVol("sink", -6),
    "vol.up": () => stepVol("sink", 6),
    "vol.mute": () => toggleMute("sink"),
    "open.terminal": async () => {
      openTerminal(process.env.HOME ?? "/");
    },
    "open.claude": async () => {
      const app = claudeDesktop();
      if (app ? launch(app) : false) return;
      if (await kwinRaise(["✳", "claude code"])) return;
      openTerminal(process.env.HOME ?? "/", ["claude"]);
    },
    screenshot,
    lock,
    "display.sleep": displayOff,
    "caffeine.toggle": caffeineToggle,
    "dnd.toggle": dndToggle,
    "nightlight.toggle": nightToggle,
    "music.toggle": () => mpris.control("PlayPause"),
    "music.next": () => mpris.control("Next"),
    "music.prev": () => mpris.control("Previous"),
  },

  info: {
    "mic.toggle": "mute / unmute the default microphone",
    "vol.down": "output volume −6",
    "vol.up": "output volume +6",
    "vol.mute": "mute / unmute the output",
    "open.terminal": "open a terminal",
    "open.claude": "Claude desktop app, else a terminal running claude",
    lock: "lock the screen",
    "display.sleep": "turn the monitors off",
    "dnd.toggle": "Do Not Disturb on / off (holds notifications back)",
    "nightlight.toggle": "Night Light on / off (KDE)",
    "screenshot": "pick a region, copy it to the clipboard",
    "caffeine.toggle": "caffeine on / off (blocks idle + sleep while deckd runs)",
    "music.toggle": "media play / pause (MPRIS)",
    "music.next": "media next track (MPRIS)",
    "music.prev": "media previous track (MPRIS)",
  },

  music: {
    read: mpris.readMusic,
    artwork: mpris.readArtwork,
    shuffle: mpris.toggleShuffle,
    repeat: mpris.cycleRepeat,
    seek: mpris.seekTo,
    volume: mpris.setVolume,
  },

  notify,
  sound,
  copy,

  async openTerminal(cwd) {
    openTerminal(cwd);
  },
  async openEditor(cwd, editor) {
    for (const c of editorCommand(editor)) if (launch([c, cwd], cwd)) return;
    await openFolder(cwd);
  },
  openFolder,
  async focusClaude(cwd, sessionName) {
    // Claude Code titles its terminal "✳ <topic>"; the folder name is the next best guess
    const needles = [sessionName, basename(cwd)].filter(Boolean);
    if (await kwinRaise(needles)) return;
    if (await wmctrlRaise(needles)) return;
    const app = claudeDesktop();
    if (app && launch(app)) return;
    openTerminal(cwd);
  },
};
