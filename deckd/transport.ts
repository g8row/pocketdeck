// How the tablet reaches deskd, and how deskd reaches the tablet's shell.
//
//   Android tablet:   adb reverse tcp:7777 tcp:7777            (USB, adbd)
//   mainline tablet:  ssh -R 7777:127.0.0.1:7777 root@tablet   (USB network, dropbear)
//
// Both keepers run every few seconds and are no-ops when their tablet isn't
// there, so one deskd serves either kind, replugs and reboots included. The
// tablet's host always dials 127.0.0.1:7777 on its own side, so deskd never
// listens on anything but loopback.
//
// Env: DESKD_SSH  ssh target of a mainline tablet (default root@172.16.42.1;
//                 any ~/.ssh/config alias works; "off" disables the tunnel).

import { $ } from "bun";
import { deflateSync } from "node:zlib";
import { join } from "node:path";
import { tmpdir } from "node:os";

type Log = (...a: unknown[]) => void;

// ---- adb ---------------------------------------------------------------------------

let adbDevice = false;
const hasAdb = !!Bun.which("adb");

export async function keepAdbReverse(port: number, log: Log): Promise<void> {
  if (!hasAdb) return;
  const devs = (await $`adb devices`.quiet().nothrow()).stdout.toString();
  adbDevice = /\tdevice$/m.test(devs);
  if (!adbDevice) return;
  const list = (await $`adb reverse --list`.quiet().nothrow()).stdout.toString();
  if (!list.includes(`tcp:${port}`)) {
    const r = await $`adb reverse tcp:${port} tcp:${port}`.quiet().nothrow();
    log(r.exitCode === 0 ? `adb reverse tcp:${port} applied` : `adb reverse failed: ${r.stderr}`);
  }
}

// ---- ssh (mainline Linux on the tablet) ---------------------------------------------------

const SSH_TARGET = process.env.DESKD_SSH ?? "root@172.16.42.1";
const sshEnabled = SSH_TARGET !== "off" && SSH_TARGET !== "" && !!Bun.which("ssh");
const CONTROL = join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), `deskd-ssh-${process.getuid?.() ?? 0}.sock`);
// the tablet is reflashed often: don't pin its host key (same as mainline/scripts/tb.sh)
const SSH_OPTS = [
  "-o", "BatchMode=yes",
  "-o", "ConnectTimeout=4",
  "-o", "StrictHostKeyChecking=no",
  "-o", "UserKnownHostsFile=/dev/null",
  "-o", "LogLevel=ERROR",
];

let tunnel: ReturnType<typeof Bun.spawn> | null = null;
let tunnelUp = false;
let resolved: { host: string; port: number } | null = null;
let lastSshNote = "";

/** `ssh -G` resolves aliases from ~/.ssh/config to the real host and port. */
async function resolveTarget(): Promise<{ host: string; port: number } | null> {
  if (resolved) return resolved;
  const r = await $`ssh -G ${SSH_TARGET}`.quiet().nothrow();
  const out = r.stdout.toString();
  const host = /^hostname (\S+)/m.exec(out)?.[1];
  const port = Number(/^port (\d+)/m.exec(out)?.[1] ?? 22);
  if (!host) return null;
  resolved = { host, port };
  return resolved;
}

/** TCP connect with a short timeout: is anything listening there? */
function probe(host: string, port: number, ms = 800): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const end = (v: boolean) => {
      if (!done) {
        done = true;
        resolve(v);
      }
    };
    setTimeout(() => end(false), ms);
    Bun.connect({
      hostname: host,
      port,
      socket: {
        open: (s) => {
          s.end();
          end(true);
        },
        data: () => {},
        error: () => end(false),
        connectError: () => end(false),
      },
    }).catch(() => end(false));
  });
}

export async function keepSshTunnel(port: number, log: Log): Promise<void> {
  if (!sshEnabled) return;
  if (tunnel && tunnel.exitCode === null) return;
  if (tunnel) {
    tunnel = null;
    if (tunnelUp) log(`ssh tunnel to ${SSH_TARGET} closed`);
    tunnelUp = false;
  }
  const t = await resolveTarget();
  if (!t || !(await probe(t.host, t.port))) return;
  const p = Bun.spawn(
    [
      "ssh", "-N", "-T",
      ...SSH_OPTS,
      "-o", "ExitOnForwardFailure=yes",
      "-o", "ServerAliveInterval=5",
      "-o", "ServerAliveCountMax=2",
      "-o", "ControlMaster=yes",
      "-o", `ControlPath=${CONTROL}`,
      "-R", `${port}:127.0.0.1:${port}`,
      SSH_TARGET,
    ],
    { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
  );
  tunnel = p;
  // ssh -N prints nothing on success: give it a moment, then call it up if it's still alive
  const early = await Promise.race([p.exited, Bun.sleep(2500).then(() => null)]);
  if (early === null) {
    tunnelUp = true;
    lastSshNote = "";
    log(`ssh tunnel up: ${SSH_TARGET} 127.0.0.1:${port} → here`);
    return;
  }
  const err = (await new Response(p.stderr).text()).trim().split("\n").pop() ?? `exit ${early}`;
  if (err !== lastSshNote) log(`ssh tunnel to ${SSH_TARGET} failed: ${err}`);
  lastSshNote = err;
  tunnel = null;
}

/** Stop the tunnel (deskd shutting down). */
export function closeTransports(): void {
  tunnel?.kill();
}

// ---- running things on the tablet ------------------------------------------------------------

export type Via = "ssh" | "adb";

export function tabletVia(): Via | null {
  if (tunnelUp && tunnel?.exitCode === null) return "ssh";
  if (adbDevice) return "adb";
  return null;
}

async function sshRun(cmd: string): Promise<{ code: number; out: Buffer }> {
  // reuse the tunnel's connection when it's up; ssh falls back to a fresh one otherwise
  const r = await $`ssh ${SSH_OPTS} -o ControlMaster=no -o ControlPath=${CONTROL} ${SSH_TARGET} ${cmd}`.quiet().nothrow();
  return { code: r.exitCode, out: r.stdout };
}

/** Run a shell snippet on whichever tablet is attached. */
export async function tabletShell(script: string): Promise<{ via: Via; out: string } | null> {
  const via = tabletVia();
  if (via === "ssh") {
    const r = await sshRun(script);
    return r.code === 0 || r.out.length ? { via, out: r.out.toString() } : null;
  }
  if (via === "adb") {
    const r = await $`adb shell ${script}`.quiet().nothrow();
    return r.exitCode === 0 || r.stdout.length ? { via, out: r.stdout.toString() } : null;
  }
  return null;
}

// Mainline kiosk: it draws through DRM, so fb0 only holds the text console. A
// kiosk built with the dump handler writes its front buffer (tight BGRX) on
// SIGUSR1; only signal a binary that has it (SIGUSR1's default action is to
// exit). Older kiosks / plain fbdev: read fb0. Prints "w,h stride bpp\n" + raw.
const SHOT = `f=/sys/class/graphics/fb0; g=$(cat $f/virtual_size); w=\${g%,*}; h=\${g#*,}; n=$((w*h*4)); d=/tmp/pocketjs-front.raw
p=$(pidof pocketjs-kiosk | cut -d' ' -f1)
if [ -n "$p" ] && grep -q pocketjs-front.raw /proc/$p/exe 2>/dev/null; then
  rm -f $d; kill -USR1 $p; i=0
  while [ $i -lt 30 ] && [ "$(stat -c %s $d 2>/dev/null)" != "$n" ]; do sleep 0.05; i=$((i+1)); done
fi
if [ "$(stat -c %s $d 2>/dev/null)" = "$n" ]; then sleep 0.05; echo "$w,$h $((w*4)) 32"; cat $d; rm -f $d
else echo "$g $(cat $f/stride) $(cat $f/bits_per_pixel)"; head -c $((h*$(cat $f/stride))) /dev/fb0; fi`;

/** The tablet's screen as PNG, or null. */
export async function tabletScreenshot(): Promise<Uint8Array | null> {
  const via = tabletVia();
  if (via === "adb") {
    const r = await $`adb exec-out screencap -p`.quiet().nothrow();
    return r.exitCode === 0 && r.stdout.length > 100 ? new Uint8Array(r.stdout) : null;
  }
  if (via === "ssh") {
    const r = await sshRun(SHOT);
    if (r.code !== 0) return null;
    const nl = r.out.indexOf(10);
    const m = /^(\d+),(\d+) (\d+) (\d+)/.exec(r.out.subarray(0, nl).toString());
    if (!m || m[4] !== "32") return null;
    return fbToPng(new Uint8Array(r.out.subarray(nl + 1)), Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return null;
}

// ---- framebuffer → PNG -------------------------------------------------------------------

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(b: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(rgb: Uint8Array, w: number, h: number): Uint8Array {
  const raw = new Uint8Array(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) raw.set(rgb.subarray(y * w * 3, (y + 1) * w * 3), y * (w * 3 + 1) + 1);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr.set([8, 2, 0, 0, 0], 8); // 8-bit RGB
  const parts = [new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw, { level: 6 })), chunk("IEND", new Uint8Array())];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** XRGB8888 (BGRA bytes) framebuffer → PNG. A portrait panel (the TB-7304X is
 *  600×1024) is turned to landscape the way the kiosk draws on it: output row =
 *  panel column, right to left (same as mainline/scripts/fb2png.py). */
export function fbToPng(fb: Uint8Array, w: number, h: number, stride: number): Uint8Array | null {
  if (fb.length < h * stride) return null;
  const rotate = h > w;
  const ow = rotate ? h : w;
  const oh = rotate ? w : h;
  const rgb = new Uint8Array(ow * oh * 3);
  let d = 0;
  for (let y = 0; y < oh; y++) {
    for (let x = 0; x < ow; x++) {
      const o = rotate ? x * stride + (w - 1 - y) * 4 : y * stride + x * 4;
      rgb[d++] = fb[o + 2]!;
      rgb[d++] = fb[o + 1]!;
      rgb[d++] = fb[o]!;
    }
  }
  return encodePng(rgb, ow, oh);
}
