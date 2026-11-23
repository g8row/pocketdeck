// A minimal D-Bus client: just enough to hold a connection open and make method
// calls with string / uint32 arguments. deskd needs it for one thing busctl and
// gdbus can't do: inhibitors (org.freedesktop.ScreenSaver.Inhibit and friends)
// live exactly as long as the caller's bus connection, and those CLIs exit
// right after the call. Little-endian only, no signals, no introspection.

import type { Socket } from "bun";

type Arg = { s: string } | { u: number };

class Writer {
  buf: number[] = [];
  pad(n: number) {
    while (this.buf.length % n) this.buf.push(0);
  }
  u8(v: number) {
    this.buf.push(v & 0xff);
  }
  u32(v: number) {
    this.pad(4);
    this.buf.push(v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff);
  }
  str(s: string) {
    const b = new TextEncoder().encode(s);
    this.u32(b.length);
    this.buf.push(...b, 0);
  }
  sig(s: string) {
    this.u8(s.length);
    this.buf.push(...new TextEncoder().encode(s), 0);
  }
}

function args(w: Writer, a: Arg[]) {
  for (const x of a) "s" in x ? w.str(x.s) : w.u32(x.u);
}

/** Marshal a METHOD_CALL. Exported for tests. */
export function methodCall(serial: number, dest: string, path: string, iface: string, member: string, a: Arg[] = []): Uint8Array {
  const body = new Writer();
  args(body, a);
  const signature = a.map((x) => ("s" in x ? "s" : "u")).join("");
  const h = new Writer();
  h.buf.push(0x6c, 1, 0, 1); // 'l', METHOD_CALL, no flags, version 1
  h.u32(body.buf.length);
  h.u32(serial);
  const fields = new Writer();
  const field = (code: number, type: string, write: () => void) => {
    fields.pad(8);
    fields.u8(code);
    fields.sig(type);
    write();
  };
  // field offsets must be aligned relative to the whole message: the array
  // starts at 16, a multiple of 8, so aligning within `fields` is equivalent
  field(1, "o", () => fields.str(path));
  field(6, "s", () => fields.str(dest));
  field(2, "s", () => fields.str(iface));
  field(3, "s", () => fields.str(member));
  if (signature) field(8, "g", () => fields.sig(signature));
  h.u32(fields.buf.length);
  h.buf.push(...fields.buf);
  h.pad(8);
  return new Uint8Array([...h.buf, ...body.buf]);
}

interface Reply {
  type: number; // 2 = return, 3 = error
  replySerial: number;
  error?: string;
  body: Uint8Array;
}

/** Split complete messages off the front of `buf`; returns [messages, rest]. */
export function parseMessages(buf: Uint8Array): [Reply[], Uint8Array] {
  const out: Reply[] = [];
  let off = 0;
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (buf.length - off >= 16) {
    const bodyLen = dv.getUint32(off + 4, true);
    const fieldsLen = dv.getUint32(off + 12, true);
    const hdrEnd = off + 16 + fieldsLen;
    const bodyStart = off + Math.ceil((16 + fieldsLen) / 8) * 8;
    const end = bodyStart + bodyLen;
    if (buf.length < end) break;
    const r: Reply = { type: buf[off + 1]!, replySerial: 0, body: buf.slice(bodyStart, end) };
    let p = off + 16;
    const align = (n: number) => (p = off + Math.ceil((p - off) / n) * n);
    while (p < hdrEnd) {
      align(8);
      const code = buf[p++]!;
      const sl = buf[p++]!;
      const sig = String.fromCharCode(...buf.slice(p, p + sl));
      p += sl + 1;
      if (sig === "u") {
        align(4);
        if (code === 5) r.replySerial = dv.getUint32(p, true);
        p += 4;
      } else if (sig === "s" || sig === "o") {
        align(4);
        const n = dv.getUint32(p, true);
        p += 4;
        if (code === 4) r.error = new TextDecoder().decode(buf.slice(p, p + n));
        p += n + 1;
      } else if (sig === "g") {
        const n = buf[p++]!;
        p += n + 1;
      } else break; // unknown field type: stop reading fields (body is still right)
    }
    out.push(r);
    off = end;
  }
  return [out, buf.slice(off)];
}

function busPath(): string {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS ?? "";
  const m = /unix:(?:[^;]*,)?path=([^,;]+)/.exec(addr);
  if (m) return m[1]!;
  return `/run/user/${process.getuid?.() ?? 1000}/bus`;
}

/** A session-bus connection. close() drops everything tied to it (inhibitors). */
export class Bus {
  private sock?: Socket<undefined>;
  private serial = 0;
  private rx: Uint8Array = new Uint8Array(0);
  private authed = false;
  private waiters = new Map<number, (r: Reply) => void>();
  private onAuth?: (ok: boolean) => void;

  static async session(timeoutMs = 2000): Promise<Bus> {
    const bus = new Bus();
    await bus.open(busPath(), timeoutMs);
    return bus;
  }

  private open(path: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("dbus: timeout")), timeoutMs);
      this.onAuth = (ok) => {
        clearTimeout(timer);
        ok ? resolve() : reject(new Error("dbus: auth rejected"));
      };
      Bun.connect({
        unix: path,
        socket: {
          open: (s) => {
            this.sock = s;
            const uid = String(process.getuid?.() ?? 1000);
            const hex = [...uid].map((c) => c.charCodeAt(0).toString(16)).join("");
            s.write(`\0AUTH EXTERNAL ${hex}\r\n`);
          },
          data: (s, chunk) => this.onData(s, chunk),
          close: () => {
            this.sock = undefined;
            for (const w of this.waiters.values()) w({ type: 3, replySerial: 0, error: "closed", body: new Uint8Array() });
            this.waiters.clear();
          },
          error: () => {},
        },
      }).catch((e) => {
        clearTimeout(timer);
        reject(e);
      });
    }).then(() => this.call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", "Hello").then(() => {}));
  }

  private onData(s: Socket<undefined>, chunk: Uint8Array) {
    if (!this.authed) {
      const line = new TextDecoder().decode(chunk);
      if (line.startsWith("OK")) {
        this.authed = true;
        s.write("BEGIN\r\n");
        this.onAuth?.(true);
      } else this.onAuth?.(false);
      return;
    }
    const all = new Uint8Array(this.rx.length + chunk.length);
    all.set(this.rx);
    all.set(chunk, this.rx.length);
    const [msgs, rest] = parseMessages(all);
    this.rx = rest;
    for (const m of msgs) {
      if (m.type !== 2 && m.type !== 3) continue;
      const w = this.waiters.get(m.replySerial);
      if (w) {
        this.waiters.delete(m.replySerial);
        w(m);
      }
    }
  }

  /** Call a method; rejects on a D-Bus error reply. Resolves with the raw body. */
  call(dest: string, path: string, iface: string, member: string, a: Arg[] = [], timeoutMs = 3000): Promise<Uint8Array> {
    if (!this.sock) return Promise.reject(new Error("dbus: not connected"));
    const serial = ++this.serial;
    const sock = this.sock;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(serial);
        reject(new Error(`dbus: ${member} timed out`));
      }, timeoutMs);
      this.waiters.set(serial, (r) => {
        clearTimeout(timer);
        r.type === 2 ? resolve(r.body) : reject(new Error(`dbus: ${r.error ?? "error"}`));
      });
      sock.write(methodCall(serial, dest, path, iface, member, a));
    });
  }

  get connected() {
    return !!this.sock;
  }

  close() {
    this.sock?.end();
    this.sock = undefined;
  }
}
