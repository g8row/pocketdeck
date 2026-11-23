// macOS: AppleScript for volumes, Music and keystrokes; `open` for apps.

import { $ } from "bun";
import os from "node:os";
import { readArtwork, readMusic } from "../providers/music.ts";
import type { Host, HostState } from "./types.ts";

const osa = (script: string) => $`osascript -e ${script}`.quiet().nothrow();
const osaQ = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

/** One osascript round trip for every live tile: volumes + Caffeine. Caffeine
 *  is only asked when already running (`tell` would launch it). */
const STATE = `set v to get volume settings
set c to "none"
if application "Caffeine" is running then
  tell application "Caffeine" to set c to (active as text)
end if
return ((output volume of v) as text) & "," & ((input volume of v) as text) & "," & ((output muted of v) as text) & "," & c`;

async function readState(): Promise<HostState | null> {
  const r = await osa(STATE);
  const [out, input, muted, caf] = r.stdout.toString().trim().split(",");
  if (out === undefined || input === undefined) return null;
  const inp = Number(input) || 0;
  return { out: Number(out) || 0, input: inp, muted: muted === "true", micMuted: inp === 0, caffeine: caf === "none" ? null : caf === "true" };
}

let micRestore = 75;

export const darwin: Host = {
  name: "macOS",

  /** Used memory % like Activity Monitor's "memory used" (app + wired + compressed). */
  async memPercent() {
    const out = (await $`vm_stat`.quiet().nothrow()).stdout.toString();
    const page = Number(/page size of (\d+)/.exec(out)?.[1] ?? 16384);
    const get = (label: string) => Number(new RegExp(`${label}:\\s+(\\d+)`).exec(out)?.[1] ?? 0) * page;
    const used = get("Anonymous pages") - get("Pages purgeable") + get("Pages wired down") + get("Pages occupied by compressor");
    return Math.max(0, Math.min(100, Math.round((100 * used) / os.totalmem())));
  },

  readState,

  actions: {
    "mic.toggle": async () => {
      const v = (await readState())?.input ?? 0;
      if (v > 0) micRestore = v;
      await osa(`set volume input volume ${v > 0 ? 0 : micRestore}`);
    },
    "vol.down": () => osa("set volume output volume ((output volume of (get volume settings)) - 6)"),
    "vol.up": () => osa("set volume output volume ((output volume of (get volume settings)) + 6)"),
    "open.terminal": () => $`open -a Terminal`.quiet().nothrow(),
    "open.claude": () => $`open -a Claude`.quiet().nothrow(),
    screenshot: () =>
      $`screencapture -x ${`${process.env.HOME}/Desktop/desk-${new Date().toISOString().replace(/[:.]/g, "-")}.png`}`
        .quiet()
        .nothrow(),
    // ⌃⌘Q: the system "Lock Screen" shortcut (needs Accessibility for osascript)
    lock: () => osa('tell application "System Events" to keystroke "q" using {control down, command down}'),
    "display.sleep": () => $`pmset displaysleepnow`.quiet().nothrow(),
    "caffeine.toggle": () =>
      osa(`tell application "Caffeine"
  if active then
    turn off
  else
    turn on
  end if
end tell`),
    "music.toggle": () => osa('tell application "Music" to playpause'),
    "music.next": () => osa('tell application "Music" to next track'),
    "music.prev": () => osa('tell application "Music" to previous track'),
  },

  info: {
    "mic.toggle": "mute / unmute the Mac microphone",
    "vol.down": "output volume −6",
    "vol.up": "output volume +6",
    "open.terminal": "open Terminal",
    "open.claude": "open the Claude app",
    screenshot: "screenshot to Desktop",
    lock: "lock the screen",
    "display.sleep": "sleep the display",
    "caffeine.toggle": "Caffeine on / off (keeps the Mac awake)",
    "music.toggle": "Music play / pause",
    "music.next": "Music next track",
    "music.prev": "Music previous track",
  },

  music: { read: readMusic, artwork: readArtwork },

  async notify(title, body) {
    await osa(`display notification "${osaQ(body)}" with title "${osaQ(title)}"`);
  },
  async sound() {
    await $`afplay -v 0.25 /System/Library/Sounds/Glass.aiff`.quiet().nothrow();
  },
  async copy(text) {
    const p = Bun.spawn(["pbcopy"], { stdin: "pipe" });
    p.stdin.write(text);
    p.stdin.end();
    await p.exited;
  },
  async openTerminal(cwd) {
    await $`open -a Terminal ${cwd}`.quiet().nothrow();
  },
  async openEditor(cwd, editor) {
    const r = await $`open -a ${editor} ${cwd}`.quiet().nothrow();
    if (r.exitCode !== 0) await $`open ${cwd}`.quiet().nothrow(); // editor missing → Finder
  },
  async openFolder(cwd) {
    await $`open ${cwd}`.quiet().nothrow();
  },
  async focusClaude() {
    await $`open -a Claude`.quiet().nothrow();
  },
};
