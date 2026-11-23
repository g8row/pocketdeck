// Wire protocol shared with hosts/android/src/link.rs: one JSON object per line.

export type ToTablet =
  | { t: "state"; k: string; v: unknown }
  | { t: "blob"; k: string; w: number; h: number; b64: string }
  | { t: "bundle"; js: string; pak: string; viewport?: [number, number] };

export type FromTablet =
  | { t: "hello"; host: string; abi: number; bundle: string; viewport: [number, number] }
  | { t: "action"; id: string; args?: unknown }
  | { t: "reloaded"; ok: boolean; error?: string }
  | { t: "error"; error: string };

export function encode(msg: ToTablet): string {
  return JSON.stringify(msg) + "\n";
}

/** Splits a TCP byte stream into complete lines; keeps the partial tail. */
export class LineSplitter {
  private buf = "";
  push(chunk: string): string[] {
    this.buf += chunk;
    const parts = this.buf.split("\n");
    this.buf = parts.pop() ?? "";
    return parts.filter((l) => l.length > 0);
  }
}

/** FNV-1a 32 over js then pak — identical to the host's `hello` fingerprint. */
export function bundleHash(js: Uint8Array, pak: Uint8Array): string {
  let h = 0x811c9dc5;
  for (const buf of [js, pak]) {
    for (let i = 0; i < buf.length; i++) {
      h = Math.imul(h ^ buf[i]!, 0x01000193);
    }
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
