// deck.config.json — the user-editable layout of the tablet: which panes, in
// what order, the deck tiles (label, color, action), the accent and the Claude
// options. Written by the config UI (ui/), read + watched by deckd, pushed to
// the tablet as the `layout` and `deck` state. Missing or broken files fall
// back to the defaults below (built from config.ts), so a fresh checkout works.

import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { env } from "./env.ts";
import { tiles as defaultTiles } from "./config.ts";

export const PANES = {
  board: "host cpu / ram with 1m · 10m · 1h history, tablet battery",
  deck: "tappable action tiles",
  claude: "claude code sessions, detail, timeline, approvals",
  usage: "claude usage: today by hour, the last 7 days by day, projects",
  music: "now playing (apple music / mpris): art, seek, shuffle, repeat, volume",
  settings: "the tablet itself: brightness, wifi, battery, boot slot",
} as const;
/** Pane ids from before the redesign → their replacement (null = gone). */
export const LEGACY_PANES: Record<string, PaneId | null> = { home: "board", pulse: null, focus: null, system: null };
export type PaneId = keyof typeof PANES;

export const COLORS = ["blue", "violet", "emerald", "amber", "rose", "latte", "zinc"] as const;
/** Icon names the tablet bakes (pocketjs/apps/desk/icons/gen.ts). An unknown
 *  name is dropped here; the tablet would fall back to the label anyway. */
export const ICONS: readonly string[] = [
  "mic", "mic-off", "vol-up", "vol-down", "terminal", "spark", "screenshot", "timer", "lock", "display",
  "cup", "play", "pause", "next", "prev", "link", "grid", "code", "bolt", "dot",
];
export type TileColor = (typeof COLORS)[number];

export const ACCENTS: Record<string, string> = {
  sky: "#a8c7fa", // the site's accent
  lilac: "#d0bcff",
  mint: "#9ee6c3",
  sun: "#ffd27a",
  coral: "#ffb4a8",
  paper: "#ededed",
};

export type TileAction =
  | { type: "builtin"; id: string }
  | { type: "shell"; cmd: string }
  | { type: "app"; name: string }
  | { type: "url"; url: string }
  | { type: "applescript"; script: string }
  | { type: "shortcut"; name: string };

export interface Tile {
  id: string;
  label: string;
  color: TileColor;
  /** Static subtitle; builtins with a live subtitle (mic) override it. */
  sub?: string;
  /** Icon name (see ICONS). 1×1 tiles without a subtitle show only this. */
  icon?: string;
  /** Icon while the live state is "on" (mic → mic-off). */
  iconOn?: string;
  /** Span in the tablet's 4×3 grid (cells). */
  w?: number;
  h?: number;
  /** Consecutive tiles with the same group render as one split pill. */
  group?: string;
  /** Always filled with the tile colour (else only while "on"). */
  fill?: boolean;
  shape?: "circle";
  action: TileAction;
}

export interface DeckConfig {
  /** 2 = the redesigned pane ids (board, deck, claude, usage, music, settings). */
  version: 2;
  panes: PaneId[];
  accent: string; // hex
  tiles: Tile[];
  claude: {
    /** Flash the tablet when a session needs you. */
    flash: boolean;
    /** Also play a quiet system sound on the computer. */
    sound: boolean;
    /** Hold permission prompts for a tablet allow/deny before falling back. */
    approvals: boolean;
    approvalTimeoutSec: number;
    /** App used by "open in editor" (macOS app name, or on Linux a command such as code / zed). */
    editor: string;
  };
  focus: { minutes: number };
}

export function defaultConfig(): DeckConfig {
  return {
    version: 2,
    panes: Object.keys(PANES) as PaneId[],
    accent: ACCENTS.sky!,
    tiles: defaultTiles.map((t) => {
      const { sub: _sub, ...rest } = t;
      return { ...rest, action: { type: "builtin", id: t.id } as TileAction };
    }),
    claude: { flash: true, sound: false, approvals: true, approvalTimeoutSec: 10, editor: "Visual Studio Code" },
    focus: { minutes: 25 },
  };
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const str = (v: unknown, max = 400) => (typeof v === "string" ? v.slice(0, max) : "");
const span = (v: unknown, max: number) => (Number.isInteger(v) ? Math.max(1, Math.min(max, v as number)) : 1);
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9.]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 32) || "tile";

function normAction(a: any): TileAction | null {
  if (!a || typeof a !== "object") return null;
  switch (a.type) {
    case "builtin":
      return str(a.id, 64) ? { type: "builtin", id: str(a.id, 64) } : null;
    case "shell":
      return str(a.cmd, 2000) ? { type: "shell", cmd: str(a.cmd, 2000) } : null;
    case "app":
      return str(a.name, 200) ? { type: "app", name: str(a.name, 200) } : null;
    case "url":
      return /^[a-z][a-z0-9+.-]*:/i.test(str(a.url, 2000)) ? { type: "url", url: str(a.url, 2000) } : null;
    case "applescript":
      return str(a.script, 4000) ? { type: "applescript", script: str(a.script, 4000) } : null;
    case "shortcut":
      return str(a.name, 200) ? { type: "shortcut", name: str(a.name, 200) } : null;
  }
  return null;
}

/** A saved pane list → current ids. Old ids are renamed or dropped; a config from before
 *  the redesign (version < 2) also gains the panes it could not have had (usage, settings),
 *  each after its predecessor in the default order. Unknown ids and repeats are dropped. */
export function migratePanes(raw: unknown[], version?: unknown): PaneId[] {
  const out: PaneId[] = [];
  for (const p of raw) {
    if (typeof p !== "string") continue;
    const id = p in LEGACY_PANES ? LEGACY_PANES[p] : p in PANES ? (p as PaneId) : null;
    if (id && !out.includes(id)) out.push(id);
  }
  if (typeof version === "number" && version >= 2) return out;
  const order = Object.keys(PANES) as PaneId[];
  for (const id of ["usage", "settings"] as PaneId[]) {
    if (out.includes(id) || !out.length) continue;
    // after the nearest earlier default pane that's present, else first
    const before = order.slice(0, order.indexOf(id)).reverse().find((x) => out.includes(x));
    out.splice(before ? out.indexOf(before) + 1 : 0, 0, id);
  }
  return out;
}

/** Coerce anything (a hand-edited file, a UI PUT) into a valid config. Throws
 *  only on non-objects; bad fields fall back to defaults field by field. */
export function normalizeConfig(raw: unknown): DeckConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be an object");
  const r = raw as Record<string, any>;
  const d = defaultConfig();
  const panes = Array.isArray(r.panes) ? migratePanes(r.panes, r.version) : d.panes;
  const seen = new Set<string>();
  const tiles: Tile[] = [];
  for (const t of Array.isArray(r.tiles) ? r.tiles : d.tiles) {
    if (!t || typeof t !== "object") continue;
    const action = normAction(t.action);
    const label = str(t.label, 24).trim();
    if (!action || !label) continue;
    let id = slug(str(t.id, 32) || label);
    while (seen.has(id)) id = `${id}-${seen.size}`;
    seen.add(id);
    tiles.push({
      id,
      label,
      color: COLORS.includes(t.color) ? t.color : "zinc",
      ...(str(t.sub, 24) ? { sub: str(t.sub, 24) } : {}),
      ...(ICONS.includes(t.icon) ? { icon: t.icon } : {}),
      ...(ICONS.includes(t.iconOn) ? { iconOn: t.iconOn } : {}),
      ...(span(t.w, 4) > 1 ? { w: span(t.w, 4) } : {}),
      ...(span(t.h, 3) > 1 ? { h: span(t.h, 3) } : {}),
      ...(str(t.group, 24).trim() ? { group: str(t.group, 24).trim() } : {}),
      ...(t.fill === true ? { fill: true } : {}),
      ...(t.shape === "circle" ? { shape: "circle" as const } : {}),
      action,
    });
    if (tiles.length >= 12) break;
  }
  const c = r.claude && typeof r.claude === "object" ? r.claude : {};
  const timeout = Number(c.approvalTimeoutSec);
  const minutes = Number(r.focus?.minutes);
  return {
    version: 2,
    panes: panes.length ? panes : d.panes,
    accent: HEX.test(r.accent) ? r.accent.toLowerCase() : d.accent,
    tiles,
    claude: {
      flash: typeof c.flash === "boolean" ? c.flash : d.claude.flash,
      sound: typeof c.sound === "boolean" ? c.sound : d.claude.sound,
      approvals: typeof c.approvals === "boolean" ? c.approvals : d.claude.approvals,
      approvalTimeoutSec: Number.isFinite(timeout) ? Math.max(3, Math.min(25, Math.round(timeout))) : d.claude.approvalTimeoutSec,
      editor: str(c.editor, 80).trim() || d.claude.editor,
    },
    focus: { minutes: Number.isFinite(minutes) ? Math.max(1, Math.min(180, Math.round(minutes))) : d.focus.minutes },
  };
}

/** deck.config.json next to this file; a desk.config.json from before the rename is taken over once. */
function defaultConfigPath(): string {
  const path = join(import.meta.dir, "deck.config.json");
  const old = join(import.meta.dir, "desk.config.json");
  if (!existsSync(path) && existsSync(old)) {
    renameSync(old, path);
    console.warn("deckd: renamed desk.config.json to deck.config.json");
  }
  return path;
}

export const CONFIG_PATH = env("CONFIG") ?? defaultConfigPath();

export function loadConfig(path = CONFIG_PATH): { config: DeckConfig; error?: string } {
  if (!existsSync(path)) return { config: defaultConfig() };
  try {
    return { config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (e) {
    return { config: defaultConfig(), error: String(e) };
  }
}

/** Atomic write (tmp + rename) so the watcher never reads half a file. */
export function saveConfig(cfg: DeckConfig, path = CONFIG_PATH): DeckConfig {
  const norm = normalizeConfig(cfg);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(norm, null, 2) + "\n");
  renameSync(tmp, path);
  return norm;
}

/** Calls `onChange` (debounced) whenever the file changes on disk. */
export function watchConfig(onChange: () => void, path = CONFIG_PATH): void {
  let t: ReturnType<typeof setTimeout> | undefined;
  const dir = join(path, "..");
  const name = path.slice(dir.length + 1);
  watch(dir, (_ev, file) => {
    if (file !== name) return;
    clearTimeout(t);
    t = setTimeout(onChange, 150);
  });
}

/** What the tablet needs to lay itself out. */
export function layoutState(cfg: DeckConfig) {
  return { panes: cfg.panes, accent: cfg.accent, flash: cfg.claude.flash, approvals: cfg.claude.approvals };
}
