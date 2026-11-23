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
}

const SEP = "\u001f";
export const READ = `
if application "Music" is running then
  tell application "Music"
    set ps to player state as text
    if ps is "stopped" then return "stopped"
    set t to current track
    return ps & "${SEP}" & (name of t) & "${SEP}" & (artist of t) & "${SEP}" & (album of t) & "${SEP}" & (player position as text) & "${SEP}" & (duration of t as text) & "${SEP}" & (persistent ID of t)
  end tell
else
  return "off"
end if`;

export async function readMusic(): Promise<MusicState> {
  const r = await $`osascript -e ${READ}`.quiet().nothrow();
  const out = r.stdout.toString().trim();
  if (r.exitCode !== 0 || out === "" || out === "off") return { state: "off" };
  if (out === "stopped") return { state: "stopped" };
  const [st, title, artist, album, pos, dur, id] = out.split(SEP);
  const num = (s?: string) => Number((s ?? "0").replace(",", ".")) || 0;
  return {
    state: st === "playing" ? "playing" : "paused",
    title,
    artist,
    album,
    position: Math.round(num(pos)),
    duration: Math.round(num(dur)),
    trackId: id,
  };
}

/** Export the current track's artwork as 128×128 RGBA, or null if it has none. */
export async function readArtwork(size = 128): Promise<Uint8Array | null> {
  const raw = join(tmpdir(), "deskd-art.bin");
  const bmp = join(tmpdir(), "deskd-art.bmp");
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
