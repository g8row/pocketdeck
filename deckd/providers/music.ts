// Apple Music via AppleScript (macOS; Linux uses MPRIS, providers/mpris.ts). Never launches Music: only reads it when running.
// Album art: exported once per track, scaled to 128×128 with `sips`, decoded
// from BMP to RGBA here (the tablet's core wants pow2 RGBA8 textures).

import { $ } from "bun";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface MusicState {
  state: "playing" | "paused" | "stopped" | "off";
  title?: string;
  artist?: string;
  album?: string;
  position?: number;
  duration?: number;
  trackId?: string;
  /** Short lowercase player name: "spotify", "firefox", "music". */
  player?: string;
  shuffle?: boolean;
  repeat?: "off" | "all" | "one";
  /** Player volume 0–100. */
  volume?: number;
}

const SEP = "\u001f";
// Shuffle / repeat / volume are app properties, sent in every state (also stopped).
// UNTESTED on a Mac (written on Linux): `song repeat` is off / one / all, `sound volume` 0–100.
export const READ = `
if application "Music" is running then
  tell application "Music"
    set ps to player state as text
    set md to (shuffle enabled as text) & "${SEP}" & (song repeat as text) & "${SEP}" & (sound volume as text)
    if ps is "stopped" then return "stopped" & "${SEP}" & md
    set t to current track
    return ps & "${SEP}" & md & "${SEP}" & (name of t) & "${SEP}" & (artist of t) & "${SEP}" & (album of t) & "${SEP}" & (player position as text) & "${SEP}" & (duration of t as text) & "${SEP}" & (persistent ID of t)
  end tell
else
  return "off"
end if`;

/** READ's output → MusicState (pure; unit-tested). */
export function parseMusicOut(out: string): MusicState {
  out = out.trim();
  if (out === "" || out === "off") return { state: "off" };
  const [st, shuf, rep, vol, title, artist, album, pos, dur, id] = out.split(SEP);
  const num = (s?: string) => Number((s ?? "0").replace(",", ".")) || 0;
  const modes = {
    player: "music",
    shuffle: shuf === "true",
    repeat: rep === "one" || rep === "all" ? rep : ("off" as const),
    volume: Math.max(0, Math.min(100, Math.round(num(vol)))),
  };
  if (st === "stopped") return { state: "stopped", ...modes };
  return {
    state: st === "playing" ? "playing" : "paused",
    title,
    artist,
    album,
    position: Math.round(num(pos)),
    duration: Math.round(num(dur)),
    ...modes,
    trackId: id,
  };
}

export async function readMusic(): Promise<MusicState> {
  const r = await $`osascript -e ${READ}`.quiet().nothrow();
  if (r.exitCode !== 0) return { state: "off" };
  return parseMusicOut(r.stdout.toString());
}

// Controls (UNTESTED on a Mac). Each only talks to Music when it is already running.
const ifRunning = (body: string) => `if application "Music" is running then
  tell application "Music"
${body}
  end tell
end if`;
export const SHUFFLE = ifRunning("    set shuffle enabled to not shuffle enabled");
export const REPEAT = ifRunning(`    if song repeat is off then
      set song repeat to all
    else if song repeat is all then
      set song repeat to one
    else
      set song repeat to off
    end if`);
const osaRun = (script: string) => $`osascript -e ${script}`.quiet().nothrow();
export const musicControls = {
  shuffle: async () => void (await osaRun(SHUFFLE)),
  repeat: async () => void (await osaRun(REPEAT)),
  seek: async (pos: number) => void (await osaRun(ifRunning(`    set player position to ${Math.max(0, Math.round(pos))}`))),
  volume: async (v: number) => void (await osaRun(ifRunning(`    set sound volume to ${Math.max(0, Math.min(100, Math.round(v)))}`))),
};

/** Export the current track's artwork as 128×128 RGBA, or null if it has none. */
export async function readArtwork(size = 128): Promise<Uint8Array | null> {
  const raw = join(tmpdir(), "deckd-art.bin");
  const bmp = join(tmpdir(), "deckd-art.bmp");
  const script = `
tell application "Music"
  if (count of artworks of current track) is 0 then return "none"
  set d to raw data of artwork 1 of current track
end tell
set f to open for access (POSIX file "${raw}") with write permission
set eof f to 0
write d to f
close access f
return "ok"`;
  const r = await $`osascript -e ${script}`.quiet().nothrow();
  if (r.stdout.toString().trim() !== "ok") return null;
  const s = await $`sips -s format bmp -z ${size} ${size} ${raw} --out ${bmp}`.quiet().nothrow();
  if (s.exitCode !== 0) return null;
  return bmpToRgba(new Uint8Array(await Bun.file(bmp).arrayBuffer()), size, size);
}

/** Minimal BMP decoder (24/32-bit, bottom-up or top-down) → RGBA8, w×h. */
export function bmpToRgba(buf: Uint8Array, w: number, h: number): Uint8Array | null {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (buf[0] !== 0x42 || buf[1] !== 0x4d) return null;
  const off = dv.getUint32(10, true);
  const bw = dv.getInt32(18, true);
  const bh = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  if (bw !== w || Math.abs(bh) !== h || (bpp !== 24 && bpp !== 32)) return null;
  const bytes = bpp / 8;
  const stride = Math.ceil((bw * bytes) / 4) * 4;
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const srcY = bh > 0 ? h - 1 - y : y;
    for (let x = 0; x < w; x++) {
      const s = off + srcY * stride + x * bytes;
      const d = (y * w + x) * 4;
      out[d] = buf[s + 2]!;
      out[d + 1] = buf[s + 1]!;
      out[d + 2] = buf[s]!;
      out[d + 3] = 255;
    }
  }
  return out;
}
