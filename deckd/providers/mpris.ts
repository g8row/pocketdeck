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
  /** org.mpris.MediaPlayer2.Identity ("Spotify", "Mozilla Firefox"); optional. */
  identity?: string;
  shuffle?: boolean;
  /** "None" | "Track" | "Playlist" */
  loop?: string;
  /** 0–1 (some players go above 1) */
  volume?: number;
}

const identities = new Map<string, string>();
async function identity(bus: string): Promise<string> {
  let id = identities.get(bus);
  if (id === undefined) {
    const [v] = await busctl("get-property", bus, PATH, "org.mpris.MediaPlayer2", "Identity");
    id = typeof v?.data === "string" ? v.data : "";
    identities.set(bus, id);
  }
  return id;
}

/** busctl's a{sv} from Properties.GetAll → PlayerInfo (pure; exported for tests). */
export function fromGetAll(bus: string, props: Record<string, V>): PlayerInfo | null {
  const status = props.PlaybackStatus?.data;
  if (typeof status !== "string") return null;
  const num = (k: string) => (typeof props[k]?.data === "number" ? (props[k]!.data as number) : undefined);
  return {
    bus,
    status,
    meta: (props.Metadata?.data as Record<string, V>) ?? {},
    position: num("Position") ?? 0,
    ...(typeof props.Shuffle?.data === "boolean" ? { shuffle: props.Shuffle.data } : {}),
    ...(typeof props.LoopStatus?.data === "string" ? { loop: props.LoopStatus.data } : {}),
    ...(num("Volume") !== undefined ? { volume: num("Volume") } : {}),
  };
}

async function info(bus: string): Promise<PlayerInfo | null> {
  // everything in one round trip; unsupported properties (Shuffle, LoopStatus…) are just absent
  const [all] = await busctl("call", bus, PATH, "org.freedesktop.DBus.Properties", "GetAll", "s", PLAYER);
  const fromAll = all?.data?.[0] ? fromGetAll(bus, all.data[0]) : null;
  if (fromAll) return { ...fromAll, identity: await identity(bus) };
  // a player whose GetAll fails (usually on Position): the old per-property path
  const v = await busctl("get-property", bus, PATH, PLAYER, "PlaybackStatus", "Metadata", "Position");
  if (v.length < 2) {
    const w = await busctl("get-property", bus, PATH, PLAYER, "PlaybackStatus", "Metadata");
    if (w.length < 2) return null;
    return { bus, status: String(w[0]!.data), meta: w[1]!.data ?? {}, position: 0, identity: await identity(bus) };
  }
  return { bus, status: String(v[0]!.data), meta: v[1]!.data ?? {}, position: Number(v[2]?.data ?? 0), identity: await identity(bus) };
}

const RANK: Record<string, number> = { Playing: 0, Paused: 1, Stopped: 2 };

/** The player the deck should show and control (or null). */
export async function activePlayer(): Promise<PlayerInfo | null> {
  const all = (await Promise.all((await players()).map(info))).filter((p): p is PlayerInfo => !!p);
  all.sort((a, b) => (RANK[a.status] ?? 3) - (RANK[b.status] ?? 3));
  return all[0] ?? null;
}

const val = (m: Record<string, V>, k: string) => m[k]?.data;

const LOOP: Record<string, "off" | "all" | "one"> = { None: "off", Playlist: "all", Track: "one" };
/** MPRIS LoopStatus → the tablet's repeat (unknown → off). */
export const loopToRepeat = (loop?: string): "off" | "all" | "one" => LOOP[loop ?? ""] ?? "off";
/** The LoopStatus that follows `loop` in off → all → one → off. */
export const nextLoop = (loop?: string): "None" | "Playlist" | "Track" =>
  loopToRepeat(loop) === "off" ? "Playlist" : loopToRepeat(loop) === "all" ? "Track" : "None";
/** MPRIS Volume (0–1, may exceed 1) → 0–100. */
export const volumePct = (v: number) => Math.max(0, Math.min(100, Math.round(v * 100)));

/** "Mozilla Firefox" → "firefox", "VLC media player" → "vlc"; else the bus-name suffix. */
export function shortPlayer(identity: string | undefined, bus: string): string {
  const words = (identity ?? "")
    .toLowerCase()
    .replace(/\b(mozilla|google|gnome|kde|media|player|music)\b/g, " ")
    .split(/[^a-z0-9.+-]+/)
    .filter(Boolean);
  if (words[0]) return words[0];
  if ((identity ?? "").trim()) return identity!.trim().toLowerCase().split(/\s+/)[0]!;
  return bus.replace(/^org\.mpris\.MediaPlayer2\./, "").split(".")[0]!.toLowerCase();
}

/** Player name and modes: shown in every state, so the controls stay right while stopped. */
function modes(p: PlayerInfo) {
  return {
    player: shortPlayer(p.identity, p.bus),
    ...(p.shuffle !== undefined ? { shuffle: p.shuffle } : {}),
    ...(p.loop !== undefined ? { repeat: loopToRepeat(p.loop) } : {}),
    ...(p.volume !== undefined ? { volume: volumePct(p.volume) } : {}),
  };
}

/** MPRIS → the tablet's music state (pure; unit-tested). */
export function toMusic(p: PlayerInfo | null): MusicState & { artUrl?: string } {
  if (!p) return { state: "off" };
  if (p.status === "Stopped" || !val(p.meta, "xesam:title"))
    return p.status === "Stopped" ? { state: "stopped", ...modes(p) } : { state: "off" };
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
    ...modes(p),
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

const setProp = (bus: string, prop: string, type: string, value: string) =>
  $`busctl --user set-property ${bus} ${PATH} ${PLAYER} ${prop} ${type} ${value}`.quiet().nothrow();

export async function toggleShuffle(): Promise<void> {
  const p = await activePlayer();
  if (p) await setProp(p.bus, "Shuffle", "b", p.shuffle ? "false" : "true");
}

export async function cycleRepeat(): Promise<void> {
  const p = await activePlayer();
  if (p) await setProp(p.bus, "LoopStatus", "s", nextLoop(p.loop));
}

export async function setVolume(v: number): Promise<void> {
  const p = await activePlayer();
  if (p) await setProp(p.bus, "Volume", "d", String(Math.max(0, Math.min(100, v)) / 100));
}

/** SetPosition needs the current track's object path; without a usable one, Seek by the difference. */
export async function seekTo(pos: number): Promise<void> {
  const p = await activePlayer();
  if (!p) return;
  const us = Math.max(0, Math.round(pos * 1e6));
  const trackid = val(p.meta, "mpris:trackid");
  if (typeof trackid === "string" && trackid.startsWith("/") && !trackid.includes("NoTrack")) {
    const r = await $`busctl --user call ${p.bus} ${PATH} ${PLAYER} SetPosition ox ${trackid} ${us}`.quiet().nothrow();
    if (r.exitCode === 0) return;
  }
  await $`busctl --user call ${p.bus} ${PATH} ${PLAYER} Seek x ${us - p.position}`.quiet().nothrow();
}
