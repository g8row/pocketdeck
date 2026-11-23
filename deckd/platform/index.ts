// The host deskd runs on, picked once at startup. Windows isn't supported yet:
// it gets the Linux implementation, whose tools are all looked up with
// Bun.which, so it degrades to no-ops instead of crashing.

import { darwin } from "./darwin.ts";
import { linux } from "./linux.ts";
import type { Host } from "./types.ts";

export type { Host, HostState } from "./types.ts";
export const host: Host = process.platform === "darwin" ? darwin : linux;
