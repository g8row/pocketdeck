// What the tablet's deck shows and what each tap does. Edit freely: deskd
// pushes the new tiles on restart. Actions run on the host (platform/) as the
// logged-in user.
//
// Layout: the tablet packs tiles in order into a 4×3 grid; `w`×`h` is a tile's
// span in cells. Consecutive tiles sharing a `group` become one split pill
// (vertical when it is taller than wide) and take the first member's span.
// A column holding only a full-height pill shrinks to a narrow rail.

import { host, type HostState } from "./platform/index.ts";

export type TileColor = "blue" | "violet" | "emerald" | "amber" | "rose" | "latte" | "zinc";

export interface TileDef {
  id: string;
  label: string;
  color: TileColor;
  icon?: string;
  /** Icon while the tile's live state is "on" (mic → mic-off). */
  iconOn?: string;
  w?: number;
  h?: number;
  group?: string;
  /** Always draw filled with the tile colour (else only while "on"). */
  fill?: boolean;
  shape?: "circle";
  sub?: string;
}

/** Live values behind the builtin tiles; null when the host can't say. */
export const readHostState = (): Promise<HostState | null> => host.readState().catch(() => null);
/** @deprecated old name */
export const readMacState = readHostState;

export const tiles: TileDef[] = [
  { id: "vol.up", label: "Vol +", color: "zinc", icon: "vol-up", group: "volume", h: 3 },
  { id: "vol.down", label: "Vol −", color: "zinc", icon: "vol-down", group: "volume" },
  { id: "mic.toggle", label: "Mic", color: "rose", icon: "mic", iconOn: "mic-off", h: 2, shape: "circle" },
  { id: "open.claude", label: "Claude", color: "amber", icon: "spark", w: 2 },
  { id: "open.terminal", label: "Terminal", color: "blue", icon: "terminal" },
  { id: "screenshot", label: "Screenshot", color: "emerald", icon: "screenshot" },
  { id: "focus.toggle", label: "Focus", color: "blue", icon: "timer", fill: true },
  { id: "lock", label: "Lock", color: "violet", icon: "lock", group: "away", fill: true },
  { id: "display.sleep", label: "Sleep display", color: "zinc", icon: "display", group: "away" },
  { id: "caffeine.toggle", label: "Caffeine", color: "latte", icon: "cup" },
];

export const actions: Record<string, (args?: unknown) => Promise<unknown>> = {
  ...host.actions,
  /** Test hook: no side effects beyond the log line. */
  ping: async () => "pong",
};

/** Human descriptions of the builtins, for the config UI's action picker. */
export const builtinInfo: Record<string, string> = {
  ...host.info,
  "focus.toggle": "focus timer start / pause",
  "focus.add": "focus timer +5 min",
  "focus.reset": "focus timer reset",
  ping: "no-op (test)",
};

/** Live state for builtin-backed tiles: subtitle, "on" (draw filled / iconOn)
 *  and a 0–100 level (shown between a split pill's halves). */
export interface LiveTile {
  sub?: string;
  on?: boolean;
  level?: number;
}
export const builtinState: Record<string, (m: HostState) => LiveTile> = {
  "mic.toggle": (m) => (m.micMuted ? { sub: "MUTED", on: true } : { sub: "live", on: false }),
  "vol.up": (m) => ({ level: m.muted ? 0 : m.out }),
  "vol.down": (m) => ({ level: m.muted ? 0 : m.out }),
  "caffeine.toggle": (m) => (m.caffeine ? { sub: "awake", on: true } : { sub: "off", on: false }),
};
