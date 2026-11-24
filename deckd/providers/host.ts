// `host`: which OS the deck is attached to, its hostname, and whether its screen is
// in use, locked or asleep (the tablet dims along when it follows the host).
// Nothing beyond the hostname leaves the machine.

import os from "node:os";
import { host } from "../platform/index.ts";
import type { ScreenState } from "../platform/types.ts";

export type HostOs = "linux" | "macos" | "windows";

export const hostOs = (p: string = process.platform): HostOs => (p === "darwin" ? "macos" : p === "win32" ? "windows" : "linux");

export async function hostState(): Promise<{ os: HostOs; name: string; screen: ScreenState }> {
  const screen = await host.screen().catch(() => "active" as const);
  return { os: hostOs(), name: os.hostname(), screen };
}
