// The data the redesigned pages read (pocketjs/apps/desk/DESIGN.md §5): sys history,
// usage days / projects7d, host, and the macOS parsers (pure parts only).

import { describe, expect, test } from "bun:test";
import { History, HIST_LEN } from "../providers/hist.ts";
import { cpuGhz } from "../providers/sys.ts";
import { hostOs } from "../providers/host.ts";
import { parseAssistant } from "../providers/transcript.ts";
import { addWeekEntry, newWeek, weekState } from "../providers/usage.ts";
import { parseMusicOut } from "../providers/music.ts";
import { parseMacScreen, usedFromVmStat } from "../platform/darwin.ts";

describe("sys history", () => {
  test("1m keeps the last 30 raw samples", () => {
    const h = new History();
    for (let i = 1; i <= 45; i++) h.push(i);
    const s = h.state();
    expect(s["1m"]).toHaveLength(HIST_LEN);
    expect(s["1m"][0]).toBe(16);
    expect(s["1m"].at(-1)).toBe(45);
  });
  test("10m = means of 10 samples (20 s), 1h = means of 60 (2 min); the open bucket is the last point", () => {
    const h = new History();
    for (let i = 0; i < 10; i++) h.push(10);
    for (let i = 0; i < 10; i++) h.push(30);
    expect(h.state()["10m"]).toEqual([10, 30]);
    h.push(50); // a new 20 s bucket, one sample in
    expect(h.state()["10m"]).toEqual([10, 30, 50]);
    expect(h.state()["1h"]).toEqual([Math.round((100 + 300 + 50) / 21)]);
  });
  test("each window is capped at 30 points after an hour+", () => {
    const h = new History();
    for (let i = 0; i < 60 * 40; i++) h.push(i % 100); // 80 min of 2 s samples
    const s = h.state();
    expect(s["1m"]).toHaveLength(30);
    expect(s["10m"]).toHaveLength(30);
    expect(s["1h"]).toHaveLength(30);
    // 60-sample buckets of 0..99 cycling: whole numbers, within range
    expect(s["1h"].every((v) => Number.isInteger(v) && v >= 0 && v <= 99)).toBe(true);
  });
  test("non-finite samples are ignored", () => {
    const h = new History();
    h.push(NaN);
    h.push(5);
    expect(h.state()).toEqual({ "1m": [5], "10m": [5], "1h": [5] });
  });
  test("clock speed in GHz; Apple silicon's nominal values are dropped", () => {
    expect(cpuGhz([3400, 3400, 3500, 3500])).toBe(3.45);
    expect(cpuGhz([24, 24])).toBeUndefined();
    expect(cpuGhz([])).toBeUndefined();
  });
  test("host os names", () => {
    expect([hostOs("linux"), hostOs("darwin"), hostOs("win32"), hostOs("freebsd")]).toEqual(["linux", "macos", "windows", "linux"]);
  });
});

describe("usage: 7 days", () => {
  const entry = (id: string, out: number, at: Date) =>
    parseAssistant(
      JSON.stringify({
        type: "assistant",
        sessionId: "S",
        timestamp: at.toISOString(),
        message: { id, model: "claude-opus-5-5", content: [], usage: { input_tokens: 1, output_tokens: out } },
      }),
    )!;
  // Monday 23 Nov 2026, 14:00 local
  const now = new Date(2026, 10, 23, 14, 0).getTime();
  const daysAgo = (n: number, h = 10) => new Date(2026, 10, 23 - n, h, 0);

  test("days[7] oldest first, today last, zero-filled, weekday names", () => {
    const w = newWeek();
    addWeekEntry(w, entry("a", 1000, daysAgo(0)), "deck");
    addWeekEntry(w, entry("b", 500, daysAgo(0, 1)), "deck");
    addWeekEntry(w, entry("c", 2000, daysAgo(3)), "api");
    addWeekEntry(w, entry("d", 9999, daysAgo(7)), "api"); // a week ago today: outside
    addWeekEntry(w, entry("a", 1000, daysAgo(0)), "deck"); // streamed repeat of an id
    const s = weekState(w, now);
    expect(s.days.map((d) => d.d)).toEqual(["tue", "wed", "thu", "fri", "sat", "sun", "mon"]);
    expect(s.days.map((d) => d.out)).toEqual([0, 0, 0, 2000, 0, 0, 1500]);
  });
  test("projects7d: output summed over the window, pct = share, largest first", () => {
    const w = newWeek();
    addWeekEntry(w, entry("1", 7000, daysAgo(6)), "deck");
    addWeekEntry(w, entry("2", 1000, daysAgo(2)), "deck");
    addWeekEntry(w, entry("3", 1500, daysAgo(1)), "api");
    addWeekEntry(w, entry("4", 500, daysAgo(0)), "notes");
    addWeekEntry(w, entry("5", 99999, daysAgo(8)), "old");
    const p = weekState(w, now).projects7d;
    expect(p).toEqual([
      { name: "deck", out: "8.0k", pct: 80 },
      { name: "api", out: "1.5k", pct: 15 },
      { name: "notes", out: "500", pct: 5 },
    ]);
  });
  test("nothing used: seven zero days, no projects", () => {
    const s = weekState(newWeek(), now);
    expect(s.days).toHaveLength(7);
    expect(s.days.every((d) => d.out === 0)).toBe(true);
    expect(s.projects7d).toEqual([]);
  });
});

describe("macOS parsers (written on Linux, the Mac side is untested)", () => {
  test("Music: modes in every state", () => {
    const S = "\u001f";
    expect(parseMusicOut("off")).toEqual({ state: "off" });
    expect(parseMusicOut(["stopped", "false", "all", "40"].join(S))).toEqual({ state: "stopped", player: "music", shuffle: false, repeat: "all", volume: 40 });
    expect(parseMusicOut(["playing", "true", "one", "62", "T", "A", "L", "161,5", "367.2", "ID"].join(S) + "\n")).toEqual({
      state: "playing",
      title: "T",
      artist: "A",
      album: "L",
      position: 162,
      duration: 367,
      player: "music",
      shuffle: true,
      repeat: "one",
      volume: 62,
      trackId: "ID",
    });
  });
  test("screen: locked from ioreg Root, asleep from the display wrangler", () => {
    const root = `+-o Root  <class IORegistryEntry>
    "IOConsoleUsers" = ({"kCGSSessionOnConsoleKey"=Yes,"CGSSessionScreenIsLocked"=Yes,"kCGSSessionUserNameKey"="x"})`;
    expect(parseMacScreen(root, "")).toBe("locked");
    expect(parseMacScreen(root.replace("IsLocked\"=Yes", "IsLocked\"=No"), "")).toBe("active");
    expect(parseMacScreen("", `"IOPowerManagement" = {"CurrentPowerState"=1,"DevicePowerState"=1}`)).toBe("asleep");
    expect(parseMacScreen("", `"IOPowerManagement" = {"CurrentPowerState"=4}`)).toBe("active");
  });
  test("vm_stat used bytes", () => {
    const out = `Mach Virtual Memory Statistics: (page size of 16384 bytes)
Pages wired down:                        100.
Anonymous pages:                         1000.
Pages purgeable:                         50.
Pages occupied by compressor:            10.`;
    expect(usedFromVmStat(out)).toBe((1000 - 50 + 100 + 10) * 16384);
  });
});
