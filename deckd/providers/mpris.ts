// Now Playing on Linux: any MPRIS player on the session bus (Spotify, browsers,
// Elisa, VLC, mpv with mpv-mpris…), read with `busctl --json`. With several
// players the one playing wins, then a paused one, in bus-name order.
// Album art: mpris:artUrl (file://, http(s):// or data:) scaled to RGBA8 with
// ImageMagick (`magick`, else `convert`).

import { $ } from "bun";
import { readFileSync } from "node:fs";
import type { MusicState } from "./music.ts";

const PATH = "/org/mpris/MediaPlayer2";
const PLAYER = "org.mpris.MediaPlayer2.Player";

type V = { type: string; data: any };

async function busctl(...a: string[]): Promise<V[]> {
  const r = await $`busctl --user --json=short ${a}`.quiet().nothrow();
  if (r.exitCode !== 0) return [];
  return r.stdout
    .toString()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as V);
}

export async function players(): Promise<string[]> {
  const [names] = await busctl("call", "org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "ListNames");
  const list: string[] = names?.data?.[0] ?? [];
  return list.filter((n) => n.startsWith("org.mpris.MediaPlayer2.")).sort();
}

export interface PlayerInfo {
  bus: string;
  status: string;
  meta: Record<string, V>;
  position: number; // µs
}

async function info(bus: string): Promise<PlayerInfo | null> {
  // three properties in one round trip, one JSON value per line
  const v = await busctl("get-property", bus, PATH, PLAYER, "PlaybackStatus", "Metadata", "Position");
  if (v.length < 2) {
    // some players fail Position (no track); retry without it
    const w = await busctl("get-property", bus, PATH, PLAYER, "PlaybackStatus", "Metadata");
    if (w.length < 2) return null;
    return { bus, status: String(w[0]!.data), meta: w[1]!.data ?? {}, position: 0 };
  }
  return { bus, status: String(v[0]!.data), meta: v[1]!.data ?? {}, position: Number(v[2]?.data ?? 0) };
}

const RANK: Record<string, number> = { Playing: 0, Paused: 1, Stopped: 2 };

/** The player the deck should show and control (or null). */
export async function activePlayer(): Promise<PlayerInfo | null> {
  const all = (await Promise.all((await players()).map(info))).filter((p): p is PlayerInfo => !!p);
  all.sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
  return all[0] ?? null;
}

const val = (m: Record<string, V>, k: string) => m[k]?.data;

/** MPRIS → the tablet's music state (pure; unit-tested). */
export function toMusic(p: PlayerInfo | null): MusicState & { artUrl?: string } {
  if (!p) return { state: "off" };
  if (p.status === "Stopped" || !val(p.meta, "xesam:title")) return { state: p.status === "Stopped" ? "stopped" : "off" };
  const artist = val(p.meta, "xesam:artist");
  const title = String(val(p.meta, "xesam:title") ?? "");
  const len = Number(val(p.meta, "mpris:length") ?? 0);
  const art = val(p.meta, "mpris:artUrl");
  const trackid = String(val(p.meta, "mpris:trackid") ?? "");
  const artistStr = Array.isArray(artist) ? artist.join(", ") : String(artist ?? "");
  return {
    state: p.status === "Playing" ? "playing" : "paused",
    title,
    artist: artistStr,
    album: String(val(p.meta, "xesam:album") ?? ""),
    position: Math.round(p.position / 1e6),
    duration: Math.round(len / 1e6),
    // many players reuse one trackid (or send NoTrack): key on what's shown
    trackId: Bun.hash(`${p.bus}|${trackid.includes("NoTrack") ? "" : trackid}|${title}|${artistStr}|${art ?? ""}`).toString(16),
    ...(typeof art === "string" && art ? { artUrl: art } : {}),
  };
}

let lastArt: string | undefined;

export async function readMusic(): Promise<MusicState> {
  const m = toMusic(await activePlayer());
  lastArt = m.artUrl;
  delete m.artUrl;
  return m;
}

async function artBytes(url: string): Promise<Uint8Array | null> {
  try {
    if (url.startsWith("file://")) return new Uint8Array(readFileSync(decodeURIComponent(new URL(url).pathname)));
    if (url.startsWith("/")) return new Uint8Array(readFileSync(url));
    if (/^(https?|data):/.test(url)) {
      const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
      return r.ok ? new Uint8Array(await r.arrayBuffer()) : null;
    }
  } catch {}
  return null;
}

let magick: string[] | null | undefined;
function magickCmd(): string[] | null {
  if (magick === undefined) magick = Bun.which("magick") ? ["magick"] : Bun.which("convert") ? ["convert"] : null;
  return magick;
}

/** Any image → size×size RGBA8 (cover-cropped), or null. */
export async function toRgba(img: Uint8Array, size: number): Promise<Uint8Array | null> {
  const m = magickCmd();
  if (!m) return null;
  const p = Bun.spawn([...m, "-", "-resize", `${size}x${size}^`, "-gravity", "center", "-extent", `${size}x${size}`, "-depth", "8", "rgba:-"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "ignore",
  });
  p.stdin.write(img);
  p.stdin.end();
  const timer = setTimeout(() => p.kill(), 5000);
  const out = new Uint8Array(await new Response(p.stdout).arrayBuffer());
  clearTimeout(timer);
  await p.exited;
  return out.length === size * size * 4 ? out : null;
}

export async function readArtwork(size = 128): Promise<Uint8Array | null> {
  if (!lastArt) return null;
  const img = await artBytes(lastArt);
  return img ? toRgba(img, size) : null;
}

/** PlayPause / Next / Previous on the active player. */
export async function control(method: "PlayPause" | "Next" | "Previous"): Promise<void> {
  const p = await activePlayer();
  if (p) await $`busctl --user call ${p.bus} ${PATH} ${PLAYER} ${method}`.quiet().nothrow();
}
