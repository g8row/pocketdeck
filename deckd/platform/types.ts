// What deskd needs from the computer it runs on. One implementation per OS
// (darwin.ts, linux.ts); index.ts picks one at startup. Everything here must
// fail soft: a missing tool is a no-op or a null reading, never a throw that
// takes a provider or a tile tap down.

import type { MusicState } from "../providers/music.ts";

/** Live values behind the builtin tiles (volume pill, mic, caffeine). */
export interface HostState {
  /** Output volume 0–100. */
  out: number;
  /** Input (mic) volume 0–100. */
  input: number;
  muted: boolean;
  micMuted: boolean;
  /** null = not available on this machine. */
  caffeine: boolean | null;
}

export type Builtin = (args?: unknown) => Promise<unknown>;

export interface Host {
  /** "macOS", "Linux (KDE, Wayland)"… for logs and Desk Studio. */
  name: string;
  /** Used memory, percent. */
  memPercent(): Promise<number>;
  readState(): Promise<HostState | null>;
  /** Builtin tile actions (vol.up, mic.toggle, lock…). */
  actions: Record<string, Builtin>;
  /** Descriptions of the builtins above, for Desk Studio's picker. */
  info: Record<string, string>;
  music: {
    read(): Promise<MusicState>;
    /** size×size RGBA8, or null when the track has no art. */
    artwork(size: number): Promise<Uint8Array | null>;
  };
  notify(title: string, body: string): Promise<void>;
  /** A quiet "needs you" sound. */
  sound(): Promise<void>;
  copy(text: string): Promise<void>;
  /** Session actions from the CLAUDE pane. */
  openTerminal(cwd: string): Promise<void>;
  openEditor(cwd: string, editor: string): Promise<void>;
  openFolder(cwd: string): Promise<void>;
  /** Bring the Claude session to the front (sessionName helps find its window). */
  focusClaude(cwd: string, sessionName: string): Promise<void>;
}
