// Linux host + tablet transport: the pure parts (no desktop, bus or tablet needed).

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { displaysAsleep, editorCommand, lockedHint, memFromMeminfo, memInfoFromMeminfo, parsePactl, parseWpctl, pickWindow, terminalArgv } from "../platform/linux.ts";
import { methodCall, parseMessages } from "../platform/dbus.ts";
import { fromGetAll, loopToRepeat, nextLoop, shortPlayer, toMusic, volumePct } from "../providers/mpris.ts";
import { parseTablet } from "../providers/tablet.ts";
import { findDesktopEntry } from "../runner.ts";
import { encodePng, fbToPng } from "../transport.ts";

describe("audio parsing", () => {
  test("wpctl", () => {
    expect(parseWpctl("Volume: 0.40\n")).toEqual([40, false]);
    expect(parseWpctl("Volume: 0.05 [MUTED]\n")).toEqual([5, true]);
    expect(parseWpctl("")).toBeNull();
  });
  test("pactl", () => {
    expect(parsePactl("Volume: front-left: 26214 /  40% / -23.88 dB,   front-right: 26214 /  40% / -23.88 dB", "Mute: yes")).toEqual([40, true]);
    expect(parsePactl("Volume: mono: 65536 / 100% / 0.00 dB", "Mute: no")).toEqual([100, false]);
  });
});

test("memory from /proc/meminfo", () => {
  expect(memFromMeminfo("MemTotal:       16000000 kB\nMemFree:  1 kB\nMemAvailable:    4000000 kB\n")).toBe(75);
  expect(memFromMeminfo("")).toBe(0);
});

describe("mpris", () => {
  const meta = (m: Record<string, [string, unknown]>) => Object.fromEntries(Object.entries(m).map(([k, [type, data]]) => [k, { type, data }]));
  test("a playing track", () => {
    const m = toMusic({
      bus: "org.mpris.MediaPlayer2.spotify",
      status: "Playing",
      position: 61_500_000,
      meta: meta({
        "xesam:title": ["s", "Song"],
        "xesam:artist": ["as", ["A", "B"]],
        "xesam:album": ["s", "LP"],
        "mpris:length": ["x", 200_000_000],
        "mpris:artUrl": ["s", "https://i.scdn.co/x"],
        "mpris:trackid": ["o", "/com/spotify/track/1"],
      }),
    });
    expect(m).toMatchObject({ state: "playing", title: "Song", artist: "A, B", album: "LP", position: 62, duration: 200, artUrl: "https://i.scdn.co/x" });
    expect(m.trackId).toMatch(/^[0-9a-f]+$/);
  });
  test("paused, stopped, nothing", () => {
    expect(toMusic({ bus: "x", status: "Paused", position: 0, meta: meta({ "xesam:title": ["s", "T"] }) }).state).toBe("paused");
    expect(toMusic({ bus: "x", status: "Stopped", position: 0, meta: {} })).toEqual({ state: "stopped", player: "x" });
    expect(toMusic(null)).toEqual({ state: "off" });
  });
  test("LoopStatus ↔ repeat, volume 0–1 → 0–100", () => {
    expect([loopToRepeat("None"), loopToRepeat("Playlist"), loopToRepeat("Track"), loopToRepeat(undefined), loopToRepeat("x")]).toEqual(["off", "all", "one", "off", "off"]);
    // the tablet's cycle: off → all → one → off
    expect([nextLoop("None"), nextLoop("Playlist"), nextLoop("Track"), nextLoop(undefined)]).toEqual(["Playlist", "Track", "None", "Playlist"]);
    expect([volumePct(0), volumePct(0.62), volumePct(0.005), volumePct(1), volumePct(1.5), volumePct(-1)]).toEqual([0, 62, 1, 100, 100, 0]);
  });
  test("player names: short and lowercase", () => {
    expect(shortPlayer("Spotify", "org.mpris.MediaPlayer2.spotify")).toBe("spotify");
    expect(shortPlayer("Mozilla Firefox", "org.mpris.MediaPlayer2.firefox.instance_1_42")).toBe("firefox");
    expect(shortPlayer("VLC media player", "org.mpris.MediaPlayer2.vlc")).toBe("vlc");
    expect(shortPlayer("mpv Media Player", "org.mpris.MediaPlayer2.mpv")).toBe("mpv");
    expect(shortPlayer("Google Chrome", "org.mpris.MediaPlayer2.chrome.instance9")).toBe("chrome");
    expect(shortPlayer("", "org.mpris.MediaPlayer2.chromium.instance123")).toBe("chromium");
    expect(shortPlayer(undefined, "org.mpris.MediaPlayer2.elisa")).toBe("elisa");
  });
  test("GetAll → player, shuffle, repeat, volume on the music state", () => {
    const p = fromGetAll("org.mpris.MediaPlayer2.spotify", {
      PlaybackStatus: { type: "s", data: "Playing" },
      Metadata: { type: "a{sv}", data: meta({ "xesam:title": ["s", "Song"], "mpris:length": ["x", 300_000_000] }) },
      Position: { type: "x", data: 12_000_000 },
      Shuffle: { type: "b", data: true },
      LoopStatus: { type: "s", data: "Track" },
      Volume: { type: "d", data: 0.62 },
    })!;
    expect(toMusic({ ...p, identity: "Spotify" })).toMatchObject({ state: "playing", position: 12, duration: 300, player: "spotify", shuffle: true, repeat: "one", volume: 62 });
    // a player without Shuffle / LoopStatus / Volume: the fields are left out, not guessed
    const bare = fromGetAll("org.mpris.MediaPlayer2.vlc", { PlaybackStatus: { type: "s", data: "Stopped" } })!;
    expect(toMusic(bare)).toEqual({ state: "stopped", player: "vlc" });
    expect(fromGetAll("x", {})).toBeNull();
  });
  test("NoTrack ids don't make every song look the same", () => {
    const a = toMusic({ bus: "x", status: "Playing", position: 0, meta: meta({ "xesam:title": ["s", "One"], "mpris:trackid": ["o", "/org/mpris/MediaPlayer2/TrackList/NoTrack"] }) });
    const b = toMusic({ bus: "x", status: "Playing", position: 0, meta: meta({ "xesam:title": ["s", "Two"], "mpris:trackid": ["o", "/org/mpris/MediaPlayer2/TrackList/NoTrack"] }) });
    expect(a.trackId).not.toBe(b.trackId);
  });
});

describe("terminals and editors", () => {
  test("cwd and command flags per terminal", () => {
    expect(terminalArgv("/usr/bin/konsole", "/p")).toEqual(["/usr/bin/konsole", "--workdir", "/p"]);
    expect(terminalArgv("/usr/bin/konsole", "/p", ["claude"])).toEqual(["/usr/bin/konsole", "--workdir", "/p", "-e", "claude"]);
    expect(terminalArgv("gnome-terminal", "/p", ["claude"])).toEqual(["gnome-terminal", "--working-directory=/p", "--", "claude"]);
    expect(terminalArgv("kitty", "/p", ["claude"])).toEqual(["kitty", "--directory", "/p", "claude"]);
    expect(terminalArgv("wezterm", "/p")).toEqual(["wezterm", "start", "--cwd", "/p"]);
    expect(terminalArgv("xterm", "/p", ["claude"])).toEqual(["xterm", "-e", "claude"]);
  });
  test("macOS editor names map to commands", () => {
    expect(editorCommand("Visual Studio Code")).toEqual(["code"]);
    expect(editorCommand("Zed")).toEqual(["zeditor", "zed"]);
    expect(editorCommand("nvim-qt")).toEqual(["nvim-qt"]);
  });
  test("window picking prefers terminals", () => {
    const rows: [string, string][] = [
      ["1", "deckd — Dolphin"],
      ["2", "deckd : claude — Konsole"],
      ["3", "Something else"],
    ];
    expect(pickWindow(rows, "deckd")).toBe("2");
    expect(pickWindow(rows, "nope")).toBeNull();
  });
});

test("desktop entries by id or Name", () => {
  const d = mkdtempSync(join(tmpdir(), "deckd-apps-"));
  const apps = join(d, "applications");
  mkdirSync(apps);
  writeFileSync(join(apps, "org.mozilla.firefox.desktop"), "[Desktop Entry]\nName=Firefox\nExec=firefox %u\n");
  writeFileSync(join(apps, "hidden.desktop"), "[Desktop Entry]\nName=Hidden\nNoDisplay=true\n");
  writeFileSync(join(apps, "org.kde.dolphin.desktop"), "[Desktop Entry]\nName=Dolphin\n[Desktop Action new]\nName=Firefox\n");
  expect(findDesktopEntry("Firefox", [apps])).toBe(join(apps, "org.mozilla.firefox.desktop"));
  expect(findDesktopEntry("firefox", [apps])).toBe(join(apps, "org.mozilla.firefox.desktop"));
  expect(findDesktopEntry("org.kde.dolphin", [apps])).toBe(join(apps, "org.kde.dolphin.desktop"));
  expect(findDesktopEntry("hidden", [apps])).toBe(join(apps, "hidden.desktop")); // by id still works
  expect(findDesktopEntry("Hidden", [apps.replace("applications", "nope")])).toBeNull();
  expect(findDesktopEntry("/usr/bin/x", [apps])).toBeNull();
});

describe("dbus wire format", () => {
  test("a method call parses back as a message", () => {
    const m = methodCall(7, "org.freedesktop.ScreenSaver", "/org/freedesktop/ScreenSaver", "org.freedesktop.ScreenSaver", "Inhibit", [{ s: "deckd" }, { s: "why" }]);
    expect(m[0]).toBe(0x6c);
    expect(m[1]).toBe(1);
    const [msgs, rest] = parseMessages(m);
    expect(msgs).toHaveLength(1);
    expect(rest.length).toBe(0);
    // body: two strings "deckd", "why"
    const dv = new DataView(msgs[0]!.body.buffer, msgs[0]!.body.byteOffset);
    expect(dv.getUint32(0, true)).toBe(5);
  });
  test("partial messages wait for the rest", () => {
    const m = methodCall(1, "a.b", "/", "a.b", "C", [{ u: 3 }]);
    const [msgs, rest] = parseMessages(m.subarray(0, m.length - 2));
    expect(msgs).toHaveLength(0);
    expect(rest.length).toBe(m.length - 2);
  });
});

test("mainline tablet vitals", () => {
  const t = parseTablet("MemTotal:  1000000 kB\nMemAvailable:  700000 kB\n3725.20 9000.10\nfreq: 1196000\nos: linux\n");
  expect(t).toMatchObject({ memFreeMb: 684, memTotalMb: 977, uptime: "1h 2m", cpuMhz: 1196, mode: "linux" });
  expect(t.battery).toBeUndefined();
  expect(t.tempC).toBeUndefined();
  expect(parseTablet("cap: 80\nchg: Charging\nos: linux\n")).toMatchObject({ battery: 80, charging: true });
  expect(parseTablet("os: mainline\n").mode).toBe("linux"); // the old marker still reads as linux
});

test("tablet battery sysfs: temp 0.1 °C, voltage µV, current µA signed as charging +", () => {
  const t = parseTablet("cap: 76\nchg: Charging\ntemp: 312\nuv: 4021500\nua: 420300\nos: linux\n");
  expect(t).toMatchObject({ battery: 76, charging: true, tempC: 31.2, volts: 4.02, currentMa: 420, mode: "linux" });
  // drivers that report discharge as a positive number get the sign the page expects
  expect(parseTablet("chg: Discharging\nua: 250000\nos: linux\n").currentMa).toBe(-250);
  expect(parseTablet("chg: Discharging\nua: -250000\nos: linux\n").currentMa).toBe(-250);
  expect(parseTablet("chg: Charging\nua: -300000\nos: linux\n").currentMa).toBe(300);
  expect(parseTablet("chg: Full\nua: 0\ntemp: -45\nos: linux\n")).toMatchObject({ currentMa: 0, tempC: -4.5 });
  // Android's dumpsys: temperature 0.1 °C, voltage mV, no current
  const a = parseTablet("  status: 2\n  level: 41\n  voltage: 4012\n  temperature: 305\n  Max charging voltage: 5000000\nzygote: running\n");
  expect(a).toMatchObject({ battery: 41, tempC: 30.5, volts: 4.01, mode: "android" });
  expect(a.currentMa).toBeUndefined();
});

describe("host screen (linux)", () => {
  test("asleep only when every connected output is off", () => {
    expect(displaysAsleep([["connected\n", "On\n"], ["disconnected\n", "Off\n"]])).toBe(false);
    expect(displaysAsleep([["connected\n", "Off\n"], ["disconnected\n", "Off\n"]])).toBe(true);
    expect(displaysAsleep([["connected", "Off"], ["connected", "On"]])).toBe(false);
    expect(displaysAsleep([["disconnected", "Off"]])).toBe(false); // no outputs: can't tell, not asleep
    expect(displaysAsleep([])).toBe(false);
  });
  test("logind LockedHint", () => {
    expect(lockedHint("LockedHint=yes\n")).toBe(true);
    expect(lockedHint("LockedHint=no\n")).toBe(false);
    expect(lockedHint("")).toBe(false);
  });
  test("memory in bytes from /proc/meminfo", () => {
    expect(memInfoFromMeminfo("MemTotal:  16000000 kB\nMemFree: 1 kB\nMemAvailable:  6000000 kB\n")).toEqual({ used: 10_000_000 * 1024, total: 16_000_000 * 1024 });
    expect(memInfoFromMeminfo("")).toBeNull();
  });
});

describe("framebuffer → png", () => {
  test("png structure", () => {
    const png = encodePng(new Uint8Array([255, 0, 0]), 1, 1);
    expect([...png.subarray(0, 8)]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(new TextDecoder().decode(png.subarray(12, 16))).toBe("IHDR");
  });
  test("portrait panel turns landscape like fb2png.py", () => {
    // 2×3 portrait, stride 8 (no padding); pixel (x,y) has blue = 10*y + x
    const w = 2, h = 3, stride = 8;
    const fb = new Uint8Array(h * stride);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) fb[y * stride + x * 4] = 10 * y + x;
    const png = fbToPng(fb, w, h, stride)!;
    const dv = new DataView(png.buffer, png.byteOffset);
    expect([dv.getUint32(16), dv.getUint32(20)]).toEqual([3, 2]); // landscape 3×2
    const idatLen = dv.getUint32(33);
    const raw = inflateSync(png.subarray(41, 41 + idatLen));
    // output (x2, y2) = panel (W-1-y2, x2); blue lands in the B channel (index 2)
    const px = (x2: number, y2: number) => raw[y2 * (3 * 3 + 1) + 1 + x2 * 3 + 2];
    expect(px(0, 0)).toBe(10 * 0 + 1);
    expect(px(2, 0)).toBe(10 * 2 + 1);
    expect(px(1, 1)).toBe(10 * 1 + 0);
  });
});
