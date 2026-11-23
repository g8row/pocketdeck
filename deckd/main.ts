// deskd — the computer half of the TB-7304X desk companion (macOS or Linux;
// OS-specific bits live in platform/, tablet transports in transport.ts).
//
//   tablet (PocketJS host, link.rs) ──TCP 127.0.0.1:7777 over `adb reverse` or `ssh -R`──▶ deskd
//   Claude Code hooks ──HTTP POST 127.0.0.1:7778/claude──▶ deskd
//
// Responsibilities: keep the adb tunnel up, push provider state, run tapped
// actions, and hot-reload the Desk app (rebuild on source change → push the
// bundle → the host swaps it in place).
//
//   bun main.ts            run (watches apps/desk and rebuilds on change)
//   DESKD_NO_WATCH=1       don't watch/rebuild; push the existing dist bundle

import { $, type Socket } from "bun";
import { watch } from "node:fs";
import { join } from "node:path";
import { actions, builtinInfo, builtinState, readHostState } from "./config.ts";
import { host } from "./platform/index.ts";
import { closeTransports, keepAdbReverse, keepSshTunnel, tabletScreenshot, tabletVia } from "./transport.ts";
import { ACCENTS, COLORS, CONFIG_PATH, ICONS, type Tile, PANES, layoutState, loadConfig, normalizeConfig, saveConfig, watchConfig, type DeskConfig } from "./deskconfig.ts";
import { runAction } from "./runner.ts";
import { allPending, currentPending, decideById, dropSession, findPending, holdFull, hookResponse, tabletDecision } from "./gate.ts";
import { scanUsage, usageState } from "./providers/usage.ts";
import { focusAction, focusState, focusTick, newFocus, type Focus } from "./providers/focus.ts";
import { bundleHash, encode, LineSplitter, type FromTablet, type ToTablet } from "./protocol.ts";
import { clockState } from "./providers/clock.ts";
import { cpuPercent, memPercent } from "./providers/sys.ts";
import { claudeState, getSession, lastMessage, onAlert, onHookEvent, permissionDecided, pollTranscripts } from "./providers/claude.ts";
import { readTablet } from "./providers/tablet.ts";

const PORT = Number(process.env.DESKD_PORT ?? 7777);
const HOOK_PORT = Number(process.env.DESKD_HOOK_PORT ?? 7778);
const POCKETJS = process.env.POCKETJS_DIR ?? join(import.meta.dir, "../pocketjs");
const APP_MANIFEST = "apps/desk/pocket.json";
const APP_DIR = join(POCKETJS, "apps/desk");

const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

let cfg: DeskConfig = loadConfig().config;
let focus: Focus = newFocus(cfg.focus.minutes);
const UI_TOKEN = crypto.randomUUID();
const UI_DIR = join(import.meta.dir, "ui");

// ---- state ------------------------------------------------------------------

const state = new Map<string, string>(); // key → last encoded line (dedupe)
const blobs = new Map<string, string>(); // key → last encoded blob line
interface Client {
  sock: Socket<{ split: LineSplitter }>;
  ready: boolean;
  /** Bytes the kernel hasn't accepted yet (Bun's write() may be partial). */
  pending: Uint8Array[];
  /** Bundle hash the tablet is running (from hello / our last push). */
  bundle?: string;
}
const clients = new Set<Client>();
const enc = new TextEncoder();

function flush(c: Client) {
  while (c.pending.length > 0) {
    const buf = c.pending[0]!;
    const n = c.sock.write(buf);
    if (n < 0) return; // closed
    if (n < buf.length) {
      c.pending[0] = buf.subarray(n);
      return; // wait for drain()
    }
    c.pending.shift();
  }
}

function send(c: Client, line: string) {
  c.pending.push(enc.encode(line));
  if (c.pending.length === 1) flush(c);
}

function broadcast(line: string) {
  for (const c of clients) if (c.ready) send(c, line);
}

export function setState(k: string, v: unknown) {
  const line = encode({ t: "state", k, v });
  if (state.get(k) === line) return;
  state.set(k, line);
  broadcast(line);
}

function setBlob(k: string, w: number, h: number, rgba: Uint8Array) {
  const line = encode({ t: "blob", k, w, h, b64: Buffer.from(rgba).toString("base64") });
  blobs.set(k, line);
  broadcast(line);
}

// ---- bundle (build + hot reload) ---------------------------------------------

interface Bundle {
  js: Uint8Array;
  pak: Uint8Array;
  hash: string;
  viewport: [number, number];
}
let bundle: Bundle | null = null;

async function build(): Promise<Bundle | null> {
  const t0 = performance.now();
  const r = await $`${process.execPath} pocket compile --target android --manifest ${APP_MANIFEST} --project-root .`
    .cwd(POCKETJS)
    .quiet()
    .nothrow();
  if (r.exitCode !== 0) {
    log("build FAILED:\n" + r.stderr.toString().split("\n").filter((l) => /error|Error/.test(l)).slice(0, 8).join("\n"));
    return null;
  }
  return loadDist(performance.now() - t0);
}

async function loadDist(ms = 0): Promise<Bundle> {
  const manifest = await Bun.file(join(POCKETJS, APP_MANIFEST)).json();
  const out = manifest.app.output as string;
  const js = new Uint8Array(await Bun.file(join(POCKETJS, "dist", `${out}.js`)).arrayBuffer());
  const pak = new Uint8Array(await Bun.file(join(POCKETJS, "dist", `${out}.pak`)).arrayBuffer());
  const viewport = manifest.app.viewport.fixed.logical as [number, number];
  const b = { js, pak, hash: bundleHash(js, pak), viewport };
  log(`bundle ${b.hash} (js ${js.length} B, pak ${pak.length} B${ms ? `, built in ${Math.round(ms)} ms` : ""})`);
  return b;
}

function syncBundle(c: Client) {
  if (c.ready && bundle && c.bundle !== bundle.hash) pushBundle(c, bundle);
}

function pushBundle(c: Client, b: Bundle) {
  c.bundle = b.hash;
  const msg: ToTablet = {
    t: "bundle",
    js: Buffer.from(b.js).toString("base64"),
    pak: Buffer.from(b.pak).toString("base64"),
    viewport: b.viewport,
  };
  send(c, encode(msg));
  log(`→ pushed bundle ${b.hash}`);
}

let rebuildTimer: ReturnType<typeof setTimeout> | undefined;
function watchApp() {
  watch(APP_DIR, { recursive: true }, (_ev, file) => {
    if (!file || !/\.(tsx?|json|png|svg)$/.test(file)) return;
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(async () => {
      log(`change: ${file} → rebuilding`);
      const b = await build();
      if (!b || b.hash === bundle?.hash) return;
      bundle = b;
      for (const c of clients) syncBundle(c);
    }, 250);
  });
}

// ---- actions -------------------------------------------------------------------

/** Session-scoped Claude actions; args = { session: id }. */
const claudeActions: Record<string, (s: { cwd: string; id: string; name: string }) => Promise<unknown>> = {
  "claude.terminal": (s) => host.openTerminal(s.cwd),
  "claude.editor": (s) => host.openEditor(s.cwd, cfg.claude.editor),
  "claude.finder": (s) => host.openFolder(s.cwd),
  "claude.copy": async (s) => {
    const text = lastMessage(s.id);
    if (!text) return;
    await host.copy(text);
    await host.notify(`Copied from ${getSession(s.id)?.name ?? "Claude"}`, text.slice(0, 120));
  },
  "claude.focus": (s) => host.focusClaude(s.cwd, s.name),
};

/** A tile tap: focus.* builtins drive deskd's own timer; the rest run on the Mac. */
async function runTile(t: Tile): Promise<{ ok: boolean; error?: string }> {
  if (t.action.type === "builtin" && t.action.id.startsWith("focus.")) {
    focus = focusAction(focus, t.action.id, undefined, cfg.focus.minutes);
    setState("focus", focusState(focus));
    return { ok: true };
  }
  return runAction(t.action, actions);
}

async function runTabletAction(id: string, args: any): Promise<void> {
  const tile = cfg.tiles.find((t) => t.id === id);
  if (tile) {
    const r = await runTile(tile);
    if (!r.ok) log(`tile ${id} failed: ${r.error}`);
    refreshDeck().catch(() => {}); // show the new state (caffeine, mic…) now, not in 5 s
    return;
  }
  if (id === "claude.permit" || id === "claude.answer") {
    const p = findPending(String(args?.id ?? ""));
    if (!p) {
      log(`permission ${args?.id} stale`);
      pushClaude();
      return;
    }
    const { d, extra } = tabletDecision(p, args);
    decideById(p.id, d, extra);
    log(`permission ${p.id} ${p.toolRaw} → ${d}${extra?.updatedPermissions ? " +rule" : ""}${args?.answers ? " (answered)" : ""}`);
    pushClaude();
    return;
  }
  if (id in claudeActions) {
    const s = getSession(String(args?.session ?? ""));
    if (s?.cwd) await claudeActions[id]!(s);
    return;
  }
  if (id.startsWith("focus.")) {
    focus = focusAction(focus, id, args, cfg.focus.minutes);
    setState("focus", focusState(focus));
    return;
  }
  const fn = actions[id];
  if (!fn) throw new Error("unknown action");
  await fn(args);
}

// ---- tablet connections --------------------------------------------------------

function onTablet(c: Client, msg: FromTablet) {
  switch (msg.t) {
    case "hello":
      log(`tablet hello: host=${msg.host} abi=${msg.abi} bundle=${msg.bundle}`);
      c.ready = true;
      c.bundle = msg.bundle;
      syncBundle(c);
      for (const line of state.values()) send(c, line);
      for (const line of blobs.values()) send(c, line);
      break;
    case "action":
      log(`action ${msg.id}${msg.args ? ` ${JSON.stringify(msg.args).slice(0, 80)}` : ""}`);
      runTabletAction(msg.id, msg.args)
        .then(() => refreshFast())
        .catch((e) => log(`action ${msg.id} failed: ${e}`));
      break;
    case "reloaded":
      log(msg.ok ? "tablet reloaded the bundle ✓" : `tablet reload FAILED: ${msg.error}`);
      if (msg.ok) for (const line of [...state.values(), ...blobs.values()]) send(c, line);
      break;
    case "error":
      log(`tablet app error: ${msg.error}`);
      break;
  }
}

Bun.listen<{ split: LineSplitter }>({
  hostname: "127.0.0.1",
  port: PORT,
  socket: {
    open(sock) {
      sock.data = { split: new LineSplitter() };
      const c: Client = { sock, ready: false, pending: [] };
      clients.add(c);
      (sock as any).client = c;
      log("tablet connected");
    },
    data(sock, chunk) {
      const c = (sock as any).client as Client;
      for (const line of sock.data.split.push(chunk.toString())) {
        try {
          onTablet(c, JSON.parse(line));
        } catch (e) {
          log(`bad line from tablet: ${e}`);
        }
      }
    },
    drain(sock) {
      flush((sock as any).client as Client);
    },
    close(sock) {
      clients.delete((sock as any).client);
      log("tablet disconnected");
    },
    error(sock, e) {
      log(`socket error: ${e}`);
    },
  },
});

const tabletReady = () => [...clients].some((c) => c.ready);

// ---- HTTP: Claude Code hooks + the config UI -------------------------------------

// The per-second labels ("ago", the gate countdown) go in a tiny separate key,
// so the ~5 KB claude snapshot is only re-sent when something real changed —
// parsing + reconciling it every second cost the tablet a few ms per push.
function pushClaude() {
  const c = claudeState(Date.now(), currentPending(), allPending());
  const ago: Record<string, string> = {};
  for (const s of c.sessions as { id: string; ago?: string }[]) {
    ago[s.id] = s.ago ?? "";
    delete s.ago;
  }
  const left = c.pending?.left ?? null;
  if (c.pending) delete (c.pending as { left?: number }).left;
  // per-session countdowns + running-tool timers tick here too
  const held: Record<string, number> = {};
  const run: Record<string, string> = {};
  for (const s of c.sessions as { id: string; held?: { left?: number }; run?: string }[]) {
    if (s.held) {
      held[s.id] = s.held.left ?? 0;
      delete s.held.left;
    }
    run[s.id] = s.run ?? "";
    delete s.run;
  }
  setState("claude", c);
  setState("claudeTick", { ago, left, held, run });
}

function applyConfig(next: DeskConfig, why: string) {
  cfg = next;
  setState("layout", layoutState(cfg));
  refreshDeck().catch(() => {});
  log(`config ${why}: ${cfg.panes.length} panes, ${cfg.tiles.length} tiles, accent ${cfg.accent}`);
}

const MIME: Record<string, string> = { html: "text/html; charset=utf-8", js: "text/javascript", css: "text/css", svg: "image/svg+xml", png: "image/png" };
const allowedHost = (h: string | null) => !!h && /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h);

let navSeq = 0;
async function api(req: Request, url: URL): Promise<Response> {
  // DNS-rebinding + CSRF guard: the token lives only in the page deskd serves.
  if (req.headers.get("x-desk-token") !== UI_TOKEN) return new Response("forbidden", { status: 403 });
  const path = url.pathname.slice(4);
  if (path === "/config" && req.method === "GET") return Response.json({ config: cfg, path: CONFIG_PATH });
  if (path === "/config" && req.method === "PUT") {
    try {
      const saved = saveConfig(normalizeConfig(await req.json()));
      applyConfig(saved, "saved from UI");
      return Response.json({ config: saved });
    } catch (e) {
      return Response.json({ error: String(e) }, { status: 400 });
    }
  }
  if (path === "/meta")
    return Response.json({
      panes: PANES,
      colors: COLORS,
      icons: ICONS,
      accents: ACCENTS,
      builtins: builtinInfo,
      platform: process.platform,
      host: host.name,
      tablet: tabletReady(),
      via: tabletVia(),
    });
  if (path === "/state") {
    const out: Record<string, unknown> = {};
    for (const [k, line] of state) out[k] = JSON.parse(line).v;
    return Response.json(out);
  }
  if (path === "/screenshot") {
    const png = await tabletScreenshot().catch(() => null);
    if (!png) return new Response("no tablet", { status: 503 });
    return new Response(new Blob([png as Uint8Array<ArrayBuffer>]), { headers: { "content-type": "image/png", "cache-control": "no-store" } });
  }
  if (path === "/tile/test" && req.method === "POST") {
    const t = normalizeConfig({ tiles: [await req.json()] }).tiles[0];
    if (!t) return Response.json({ ok: false, error: "invalid tile" }, { status: 400 });
    return Response.json(await runTile(t));
  }
  if (path === "/nav" && req.method === "POST") {
    const { pane } = (await req.json()) as { pane?: string };
    setState("nav", { pane, seq: ++navSeq });
    return Response.json({ ok: true });
  }
  return new Response("not found", { status: 404 });
}

Bun.serve({
  hostname: "127.0.0.1",
  port: HOOK_PORT,
  idleTimeout: 60, // the permission gate holds requests up to ~25 s
  async fetch(req) {
    const url = new URL(req.url);
    if (!allowedHost(req.headers.get("host"))) return new Response("bad host", { status: 421 });
    if (req.method === "POST" && url.pathname === "/claude") {
      try {
        const ev = await req.json();
        onHookEvent(ev);
        if (ev.hook_event_name === "PostToolUse" || ev.hook_event_name === "UserPromptSubmit" || ev.hook_event_name === "Stop")
          dropSession(String(ev.session_id ?? "")); // answered at the Mac
        pushClaude();
      } catch {}
      return new Response("ok");
    }
    if (req.method === "POST" && url.pathname === "/claude/permission") {
      let ev: Record<string, any>;
      try {
        ev = await req.json();
      } catch {
        return new Response("");
      }
      ev.hook_event_name = "PermissionRequest";
      onHookEvent(ev);
      pushClaude();
      if (!cfg.claude.approvals || !tabletReady()) return new Response("");
      // questions and plans take longer to read than a yes/no
      const slow = ev.tool_name === "AskUserQuestion" || ev.tool_name === "ExitPlanMode";
      const ms = slow ? Math.max(cfg.claude.approvalTimeoutSec, 50) * 1000 : cfg.claude.approvalTimeoutSec * 1000;
      const { d, extra } = await holdFull(ev, ms, pushClaude);
      log(`permission ${ev.tool_name} → ${d}`);
      if (d !== "timeout") {
        permissionDecided(String(ev.session_id ?? ""));
        pushClaude();
      }
      return new Response(hookResponse(d, extra), { headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/health") return Response.json({ clients: clients.size, bundle: bundle?.hash });
    if (url.pathname.startsWith("/api/")) return api(req, url);
    // the tablet's baked deck icons, for the studio's preview
    const icon = /^\/icons\/([a-z-]+-(?:32|48)[ld]\.svg)$/.exec(url.pathname);
    if (icon) {
      const f = Bun.file(join(APP_DIR, "icons", icon[1]!));
      return (await f.exists())
        ? new Response(f, { headers: { "content-type": MIME.svg!, "cache-control": "max-age=3600" } })
        : new Response("not found", { status: 404 });
    }
    if (url.pathname === "/" || url.pathname === "/ui" || url.pathname.startsWith("/ui/")) {
      const rel = url.pathname === "/" || url.pathname === "/ui" || url.pathname === "/ui/" ? "index.html" : url.pathname.slice(4);
      if (rel.includes("..")) return new Response("no", { status: 400 });
      const f = Bun.file(join(UI_DIR, rel));
      if (!(await f.exists())) return new Response("not found", { status: 404 });
      const ext = rel.split(".").pop() ?? "";
      if (rel === "index.html") {
        const html = (await f.text()).replace("__DESK_TOKEN__", UI_TOKEN);
        return new Response(html, { headers: { "content-type": MIME.html!, "cache-control": "no-store" } });
      }
      return new Response(f, { headers: { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-store" } });
    }
    return new Response("not found", { status: 404 });
  },
});

// ---- providers -----------------------------------------------------------------------

let lastTrack: string | undefined;
async function refreshMusic() {
  const m = await host.music.read();
  setState("music", m);
  if (m.trackId && m.trackId !== lastTrack) {
    lastTrack = m.trackId;
    const art = await host.music.artwork(256);
    if (art) setBlob("music.art", 256, 256, art);
  }
}

const KIND: Record<string, string> = { builtin: "action", shell: "shell", app: "app", url: "link", applescript: "script", shortcut: "shortcut" };
async function refreshDeck() {
  const mac = await readHostState();
  const waiting = (claudeState(Date.now(), currentPending()).sessions as { state?: string }[]).filter((x) => x.state === "waiting").length;
  const list = cfg.tiles.map((t) => {
    const b = t.action.type === "builtin" ? t.action.id : "";
    const live = mac && builtinState[b] ? builtinState[b](mac) : {};
    if (b === "open.claude" && waiting > 0) Object.assign(live, { sub: `${waiting} waiting`, on: true });
    const { action: _a, ...look } = t;
    return {
      ...look,
      ...live,
      sub: live.sub ?? t.sub,
      kind: KIND[t.action.type] ?? "action",
      // the tablet reads desk.focus itself: it ticks every second, the deck every 5
      ...(b.startsWith("focus.") ? { live: "focus" } : {}),
    };
  });
  setState("deck", { tiles: list });
}

async function refreshFast() {
  await Promise.all([refreshDeck(), refreshMusic()]);
}

onAlert((a) => {
  log(`claude alert: ${a.name} — ${a.reason}`);
  if (cfg.claude.sound) host.sound().catch(() => {});
});

async function main() {
  bundle = process.env.DESKD_NO_WATCH ? await loadDist() : await build();
  for (const c of clients) syncBundle(c); // tablets that connected mid-build
  if (!process.env.DESKD_NO_WATCH) watchApp();
  log(`deskd on ${host.name}`);
  log(`deskd listening on 127.0.0.1:${PORT} (tablet) and :${HOOK_PORT} (hooks, config UI at http://127.0.0.1:${HOOK_PORT}/)`);
  const loaded = loadConfig();
  if (loaded.error) log(`config: ${loaded.error} — using defaults`);
  applyConfig(loaded.config, "loaded");
  watchConfig(() => {
    const r = loadConfig();
    if (r.error) return log(`config reload failed: ${r.error}`);
    if (JSON.stringify(r.config) !== JSON.stringify(cfg)) applyConfig(r.config, "changed on disk");
  });

  setInterval(() => setState("clock", clockState()), 1000);
  setInterval(async () => setState("sys", { cpu: cpuPercent(), mem: await memPercent() }), 2000);
  setInterval(() => refreshMusic().catch(() => {}), 1000);
  setInterval(() => refreshDeck().catch(() => {}), 5000);
  setInterval(() => pollTranscripts().then(pushClaude).catch(() => {}), 3000);
  setInterval(() => pushClaude(), 1000); // "ago" labels + the gate countdown
  setInterval(() => scanUsage().then(() => setState("usage", usageState())).catch(() => {}), 30_000);
  setInterval(() => {
    const [f, finished] = focusTick(focus);
    focus = f;
    setState("focus", focusState(focus));
    if (finished) host.notify("Desk focus", "Time is up — take a break.").catch(() => {});
  }, 1000);
  setInterval(() => keepAdbReverse(PORT, log).catch(() => {}), 3000);
  setInterval(() => keepSshTunnel(PORT, log).catch(() => {}), 3000);
  setInterval(async () => {
    const t = await readTablet().catch(() => null);
    if (t) setState("tablet", t);
  }, 30_000); // battery/RAM move slowly; each probe wakes system_server (dumpsys)

  setState("clock", clockState());
  setState("focus", focusState(focus));
  readTablet().then((t) => t && setState("tablet", t)).catch(() => {});
  pushClaude();
  scanUsage()
    .then(() => setState("usage", usageState()))
    .catch(() => {});
  await Promise.all([refreshFast(), keepAdbReverse(PORT, log), keepSshTunnel(PORT, log)]);
  // a tablet found on the first pass is worth its vitals right away
  if (tabletVia()) readTablet().then((t) => t && setState("tablet", t)).catch(() => {});
}

for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => {
    closeTransports();
    process.exit(0);
  });

await main();
