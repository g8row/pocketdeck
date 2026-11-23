// Runs a deck tile's action on the host. Cross-platform where it can be:
// shell/url/app work on macOS, Linux (apps by .desktop entry) and Windows; AppleScript and Shortcuts are
// macOS-only and report an error elsewhere. Every child gets a timeout and its
// output is discarded — a tile tap must never wedge deskd.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TileAction } from "./deskconfig.ts";

export interface Spawned {
  argv: string[];
}

const P = process.platform;

/** The argv a tile action turns into (pure; unit-tested). */
export function actionArgv(a: TileAction, platform: string = P): string[] | { error: string } {
  switch (a.type) {
    case "shell":
      return platform === "win32" ? ["cmd", "/c", a.cmd] : ["/bin/sh", "-c", a.cmd];
    case "url":
      return platform === "darwin" ? ["open", a.url] : platform === "win32" ? ["cmd", "/c", "start", "", a.url] : ["xdg-open", a.url];
    case "app":
      return platform === "darwin" ? ["open", "-a", a.name] : platform === "win32" ? ["cmd", "/c", "start", "", a.name] : ["/bin/sh", "-c", `${a.name} >/dev/null 2>&1 &`];
    case "applescript":
      return platform === "darwin" ? ["osascript", "-e", a.script] : { error: "AppleScript needs macOS" };
    case "shortcut":
      return platform === "darwin" ? ["shortcuts", "run", a.name] : { error: "Shortcuts needs macOS" };
    case "builtin":
      return { error: "builtin actions are not spawned" };
  }
}

/** Linux: the .desktop entry for an app named like Desk Studio stores it
 *  ("Firefox", "firefox", "org.kde.dolphin"), or null. */
export function findDesktopEntry(name: string, dirs = appDirs()): string | null {
  const want = name.trim().toLowerCase();
  if (!want || want.includes("/")) return null;
  let byName: string | null = null;
  for (const d of dirs) {
    let files: string[];
    try {
      files = readdirSync(d).filter((f) => f.endsWith(".desktop"));
    } catch {
      continue;
    }
    for (const f of files) {
      const id = f.slice(0, -8).toLowerCase();
      if (id === want || id.endsWith(`.${want}`)) return join(d, f);
      if (byName) continue;
      try {
        const txt = readFileSync(join(d, f), "utf8");
        const entry = txt.split(/^\[/m).find((sec) => sec.startsWith("Desktop Entry]")) ?? "";
        const n = /^Name=(.*)$/m.exec(entry)?.[1]?.trim().toLowerCase();
        if (n === want && !/^NoDisplay=true/m.test(entry)) byName = join(d, f);
      } catch {}
    }
  }
  return byName;
}

function appDirs(): string[] {
  const home = process.env.XDG_DATA_HOME ?? join(process.env.HOME ?? "", ".local/share");
  const sys = (process.env.XDG_DATA_DIRS || "/usr/local/share:/usr/share").split(":");
  return [home, ...sys, "/var/lib/flatpak/exports/share", join(process.env.HOME ?? "", ".local/share/flatpak/exports/share")]
    .map((d) => join(d, "applications"))
    .filter((d, i, a) => a.indexOf(d) === i && existsSync(d));
}

/** Launch a .desktop file with whatever launcher this desktop has. */
function desktopLauncher(path: string): string[] | null {
  const id = path.split("/").pop()!.slice(0, -8);
  if (Bun.which("gio")) return ["gio", "launch", path];
  if (Bun.which("gtk-launch")) return ["gtk-launch", id];
  if (Bun.which("kioclient")) return ["kioclient", "exec", path];
  if (Bun.which("kioclient5")) return ["kioclient5", "exec", path];
  if (Bun.which("dex")) return ["dex", path];
  return null;
}

export async function runAction(
  a: TileAction,
  builtins: Record<string, (args?: unknown) => Promise<unknown>>,
  timeoutMs = 30_000,
): Promise<{ ok: boolean; error?: string }> {
  if (a.type === "builtin") {
    const fn = builtins[a.id];
    if (!fn) return { ok: false, error: `unknown builtin ${a.id}` };
    await fn();
    return { ok: true };
  }
  let argv = actionArgv(a);
  if (!Array.isArray(argv)) return { ok: false, error: argv.error };
  // Linux "open app": prefer the app's desktop entry (right env, icon, single
  // instance handling); a plain command is the fallback
  if (a.type === "app" && P === "linux") {
    const entry = findDesktopEntry(a.name);
    const launcher = entry && desktopLauncher(entry);
    if (launcher) argv = launcher;
  }
  const proc = Bun.spawn(argv, { stdout: "ignore", stderr: "pipe", stdin: "ignore", env: process.env });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const code = await proc.exited;
  clearTimeout(timer);
  if (code === 0) return { ok: true };
  const err = (await new Response(proc.stderr).text()).trim().slice(0, 200);
  return { ok: false, error: err || `exit ${code}` };
}
