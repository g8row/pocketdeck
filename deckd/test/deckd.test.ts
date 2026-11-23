import { describe, expect, test } from "bun:test";
import { bundleHash, LineSplitter } from "../protocol.ts";
import { bmpToRgba, READ } from "../providers/music.ts";
import { $ } from "bun";
import { __resetSessions, claudeState, onHookEvent } from "../providers/claude.ts";
import { clockState } from "../providers/clock.ts";

describe("protocol", () => {
  test("line splitter keeps partial tails", () => {
    const s = new LineSplitter();
    expect(s.push('{"a":1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(':2}\n\n')).toEqual(['{"b":2}']);
  });
  test("bundle hash is FNV-1a 32 over js then pak", () => {
    // FNV-1a 32 of "a" is 0xe40c292c.
    expect(bundleHash(new TextEncoder().encode("a"), new Uint8Array())).toBe("e40c292c");
    expect(bundleHash(new TextEncoder().encode("a"), new TextEncoder().encode("b"))).toBe(
      bundleHash(new TextEncoder().encode("ab"), new Uint8Array()),
    );
  });
});

describe("music", () => {
  test.skipIf(process.platform !== "darwin")("the AppleScript compiles (no reserved-word variables)", async () => {
    const r = await $`osacompile -e ${READ} -o /dev/null`.quiet().nothrow();
    expect(r.stderr.toString()).toBe("");
    expect(r.exitCode).toBe(0);
  });
  test("decodes a bottom-up 24-bit BMP", () => {
    // 2×2: bottom row stored first. Rows padded to 8 bytes.
    const w = 2, h = 2, stride = 8, off = 54;
    const buf = new Uint8Array(off + stride * h);
    const dv = new DataView(buf.buffer);
    buf[0] = 0x42; buf[1] = 0x4d;
    dv.setUint32(10, off, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(28, 24, true);
    // bottom row (y=1): blue, green  | top row (y=0): red, white   (BGR order)
    buf.set([255, 0, 0, 0, 255, 0], off);
    buf.set([0, 0, 255, 255, 255, 255], off + stride);
    const px = bmpToRgba(buf, w, h)!;
    expect([...px.slice(0, 4)]).toEqual([255, 0, 0, 255]); // top-left red
    expect([...px.slice(8, 12)]).toEqual([0, 0, 255, 255]); // bottom-left blue
  });
});

describe("claude sessions", () => {
  test("hook events drive state, waiting sorts first", () => {
    __resetSessions();
    onHookEvent({ hook_event_name: "UserPromptSubmit", session_id: "a", cwd: "/x/proj-a", prompt: "do it" }, 1000);
    onHookEvent({ hook_event_name: "Notification", session_id: "b", cwd: "/x/proj-b", message: "Claude needs permission" }, 2000);
    onHookEvent({ hook_event_name: "Stop", session_id: "c", cwd: "/x/proj-c" }, 3000);
    const s = claudeState(4000).sessions;
    expect(s.map((x) => [x.name, x.state])).toEqual([
      ["proj-b", "waiting"],
      ["proj-a", "working"],
      ["proj-c", "done"],
    ]);
    onHookEvent({ hook_event_name: "SessionEnd", session_id: "b" }, 5000);
    expect(claudeState(5000).sessions.length).toBe(2);
  });
});

test("clock", () => {
  const c = clockState(new Date(2026, 10, 16, 9, 5));
  expect([c.h, c.m]).toEqual([9, 5]);
});

import { parseTablet } from "../providers/tablet.ts";
test("tablet vitals parse", () => {
  const t = parseTablet("  AC powered: false\n  USB powered: true\n  status: 2\n  level: 41\nMemTotal:  918548 kB\nMemAvailable:  482832 kB\n7384.12 2000.1\nfreq: 1092000\ninet 192.168.88.115\nzygote: running\n");
  expect(t).toEqual({ battery: 41, charging: true, memFreeMb: 472, memTotalMb: 897, uptime: "2h 3m", cpuMhz: 1092, wifi: "192.168.88.115", mode: "android" });
});
