// desk.config.json — the user-editable layout of the tablet: which panes, in
// what order, the deck tiles (label, color, action), the accent and the Claude
// options. Written by the config UI (ui/), read + watched by deskd, pushed to
// the tablet as the `layout` and `deck` state. Missing or broken files fall
// back to the defaults below (built from config.ts), so a fresh checkout works.

import { existsSync, readFileSync, renameSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tiles as defaultTiles } from "./config.ts";

export const PANES = {
  home: "clock, now playing, claude + computer at a glance",
  deck: "tappable action tiles",
  music: "now playing (apple music / mpris): art, wave, transport",
  claude: "claude code sessions, detail, timeline, approvals",
  pulse: "claude usage today: ascii token field + hourly bars",
  board: "ops board: cell grid of every live number",
  focus: "focus timer: a morphing shape that eats the time",
  system: "frame-time graph + tablet spec table",
} as const;
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

export interface DeskConfig {
  version: 1;
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

export function defaultConfig(): DeskConfig {
  return {
    version: 1,
    panes: ["home", "claude", "pulse", "deck", "music", "board", "focus", "system"],
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

/** Coerce anything (a hand-edited file, a UI PUT) into a valid config. Throws
 *  only on non-objects; bad fields fall back to defaults field by field. */
export function normalizeConfig(raw: unknown): DeskConfig {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("config must be an object");
  const r = raw as Record<string, any>;
  const d = defaultConfig();
  const panes = Array.isArray(r.panes)
    ? [...new Set(r.panes.filter((p: unknown): p is PaneId => typeof p === "string" && p in PANES))]
    : d.panes;
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
    version: 1,
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

export const CONFIG_PATH = process.env.DESKD_CONFIG ?? join(import.meta.dir, "desk.config.json");

export function loadConfig(path = CONFIG_PATH): { config: DeskConfig; error?: string } {
  if (!existsSync(path)) return { config: defaultConfig() };
  try {
    return { config: normalizeConfig(JSON.parse(readFileSync(path, "utf8"))) };
  } catch (e) {
    return { config: defaultConfig(), error: String(e) };
  }
}

/** Atomic write (tmp + rename) so the watcher never reads half a file. */
export function saveConfig(cfg: DeskConfig, path = CONFIG_PATH): DeskConfig {
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
export function layoutState(cfg: DeskConfig) {
  return { panes: cfg.panes, accent: cfg.accent, flash: cfg.claude.flash, approvals: cfg.claude.approvals };
}
