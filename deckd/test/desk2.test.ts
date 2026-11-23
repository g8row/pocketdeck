import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig, layoutState, loadConfig, normalizeConfig, saveConfig } from "../deskconfig.ts";
import { actionArgv, runAction } from "../runner.ts";
import { __resetSessions, claudeState, onHookEvent, permissionDecided, summarizeTool, toolName, onAlert } from "../providers/claude.ts";
import { decideById, hold, hookResponse, currentPending, dropSession } from "../gate.ts";
import { TranscriptTail, parseAssistant } from "../providers/transcript.ts";
import { __newDay, addEntry, projectName } from "../providers/usage.ts";
import { focusAction, focusState, focusTick, newFocus } from "../providers/focus.ts";

const tmp = () => mkdtempSync(join(tmpdir(), "deskd-"));

describe("desk config", () => {
  test("defaults mirror config.ts tiles as builtin actions", () => {
    const d = defaultConfig();
    expect(d.tiles.find((t) => t.id === "mic.toggle")?.action).toEqual({ type: "builtin", id: "mic.toggle" });
    expect(d.panes[0]).toBe("home");
  });
  test("normalize drops junk field by field", () => {
    const c = normalizeConfig({
      panes: ["claude", "nope", "claude", "home"],
      accent: "red",
      tiles: [
        { label: "Build", color: "violet", action: { type: "shell", cmd: "make" } },
        { label: "Build", color: "pink", action: { type: "url", url: "https://x.dev" } },
        { label: "", action: { type: "shell", cmd: "x" } },
        { label: "Bad url", action: { type: "url", url: "not a url" } },
        { label: "Bad type", action: { type: "rm" } },
      ],
      claude: { approvalTimeoutSec: 999, sound: "yes" },
    });
    expect(c.panes).toEqual(["claude", "home"]);
    expect(c.accent).toBe(defaultConfig().accent);
    expect(c.tiles.map((t) => [t.id, t.color])).toEqual([
      ["build", "violet"],
      ["build-1", "zinc"],
    ]);
    expect(c.claude.approvalTimeoutSec).toBe(25);
    expect(c.claude.sound).toBe(false);
    expect(() => normalizeConfig([])).toThrow();
  });
  test("tile layout fields: kept when valid, clamped or dropped when not", () => {
    const c = normalizeConfig({
      tiles: [
        { label: "A", icon: "cup", iconOn: "nope", w: 2, h: 9, group: " g ", fill: true, shape: "circle", action: { type: "shell", cmd: "x" } },
        { label: "B", icon: "nope", w: 1.5, h: 1, fill: "yes", shape: "star", action: { type: "shell", cmd: "x" } },
      ],
    });
    const [a, b] = c.tiles;
    expect([a?.icon, a?.iconOn, a?.w, a?.h, a?.group, a?.fill, a?.shape]).toEqual(["cup", undefined, 2, 3, "g", true, "circle"]);
    expect(b).toEqual({ id: "b", label: "B", color: "zinc", action: { type: "shell", cmd: "x" } });
  });
  test("default deck is the rail: volume pill first, caffeine last", () => {
    const t = defaultConfig().tiles;
    expect(t.slice(0, 2).map((x) => [x.id, x.group])).toEqual([["vol.up", "volume"], ["vol.down", "volume"]]);
    expect(t[0]?.h).toBe(3);
    expect(t.at(-1)?.id).toBe("caffeine.toggle");
    expect(t.every((x) => x.icon)).toBe(true);
    expect(normalizeConfig(defaultConfig())).toEqual(defaultConfig()); // defaults survive normalize
  });
  test("empty pane list falls back to defaults", () => {
    expect(normalizeConfig({ panes: [] }).panes).toEqual(defaultConfig().panes);
  });
  test("save → load round trip; broken file falls back with an error", () => {
    const p = join(tmp(), "desk.config.json");
    const c = defaultConfig();
    c.accent = "#ABCDEF";
    saveConfig(c, p);
    expect(loadConfig(p).config.accent).toBe("#abcdef");
    writeFileSync(p, "{oops");
    const r = loadConfig(p);
    expect(r.error).toBeTruthy();
    expect(r.config.panes).toEqual(defaultConfig().panes);
  });
  test("layout state carries what the tablet needs", () => {
    expect(Object.keys(layoutState(defaultConfig())).sort()).toEqual(["accent", "approvals", "flash", "panes"]);
  });
});

describe("runner", () => {
  test("argv per platform", () => {
    expect(actionArgv({ type: "url", url: "https://a" }, "darwin")).toEqual(["open", "https://a"]);
    expect(actionArgv({ type: "url", url: "https://a" }, "linux")).toEqual(["xdg-open", "https://a"]);
    expect(actionArgv({ type: "shell", cmd: "echo hi" }, "win32")).toEqual(["cmd", "/c", "echo hi"]);
    expect(actionArgv({ type: "app", name: "Zed" }, "darwin")).toEqual(["open", "-a", "Zed"]);
    expect(actionArgv({ type: "applescript", script: "beep" }, "linux")).toEqual({ error: "AppleScript needs macOS" });
    expect(actionArgv({ type: "shortcut", name: "Lights" }, "darwin")).toEqual(["shortcuts", "run", "Lights"]);
  });
  test("runs shell actions and reports failures", async () => {
    const dir = tmp();
    expect(await runAction({ type: "shell", cmd: `touch ${dir}/ran` }, {})).toEqual({ ok: true });
    expect(readFileSync(`${dir}/ran`, "utf8")).toBe("");
    const bad = await runAction({ type: "shell", cmd: "echo nope >&2; exit 3" }, {});
    expect(bad).toEqual({ ok: false, error: "nope" });
    let hit = 0;
    expect(await runAction({ type: "builtin", id: "x" }, { x: async () => hit++ })).toEqual({ ok: true });
    expect(hit).toBe(1);
    expect((await runAction({ type: "builtin", id: "zz" }, {})).ok).toBe(false);
  });
});

describe("claude timeline", () => {
  beforeEach(() => __resetSessions());
  const base = { session_id: "s1", cwd: "/Users/me/proj" };

  test("tool summaries", () => {
    expect(summarizeTool("Bash", { command: "ls -la", description: "List files" })).toBe("List files");
    expect(summarizeTool("Edit", { file_path: "/a/b/c.ts" })).toBe("c.ts");
    expect(summarizeTool("WebFetch", { url: "https://docs.x.dev/a" })).toBe("docs.x.dev");
    expect(summarizeTool("TodoWrite", { todos: [1, 2] })).toBe("2 todos");
    expect(toolName("mcp__plugin_chrome-devtools-mcp_chrome-devtools__click")).toBe("chrome-dev:click");
  });

  test("pre/post pairs give durations and failures; prompts are kept newest first", () => {
    onHookEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "first" }, 1000);
    onHookEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "second" }, 2000);
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a", tool_input: { command: "make" } }, 3000);
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "b", tool_input: { file_path: "/x/y.md" } }, 3100);
    onHookEvent({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "a", tool_response: { is_error: true } }, 4500);
    onHookEvent({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "b", tool_response: {} }, 3150);
    const s = claudeState(5000).sessions[0]!;
    expect(s.name).toBe("proj");
    expect(s.prompts.map((p) => p.text)).toEqual(["second", "first"]);
    expect(s.tools.map((t) => [t.tool, t.summary, t.ms, t.ok])).toEqual([
      ["Read", "y.md", "50ms", "ok"],
      ["Bash", "make", "1.5s", "fail"],
    ]);
    expect(s.toolCount).toBe(2);
    expect(s.failCount).toBe(1);
    expect(s.top).toBe("Bash 1 · Read 1");
  });

  test("without PostToolUse, the next event closes a call as an estimate", () => {
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_use_id: "a", tool_input: { command: "make" } }, 1000);
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "b", tool_input: { file_path: "/x/y.md" } }, 3500);
    let s = claudeState(4000).sessions[0]!;
    expect(s.tools.map((t) => [t.tool, t.ms, t.ok])).toEqual([
      ["Read", "…", "run"],
      ["Bash", "~2.5s", "est"],
    ]);
    onHookEvent({ ...base, hook_event_name: "Stop" }, 3800);
    s = claudeState(4000).sessions[0]!;
    expect(s.tools[0]!.ms).toBe("~300ms");
    // a late real PostToolUse still wins
    onHookEvent({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_use_id: "a", tool_response: {} }, 2000);
    expect(claudeState(4000).sessions[0]!.tools[1]).toMatchObject({ ms: "1.0s", ok: "ok" });
  });

  test("permission requests make a session wait and bump the alert once", () => {
    const seen: number[] = [];
    onAlert((a) => seen.push(a.seq));
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "rm x" } }, 1);
    onHookEvent({ ...base, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "rm x" } }, 2);
    onHookEvent({ ...base, hook_event_name: "Notification", message: "Claude needs your permission to use Bash", notification_type: "permission_prompt" }, 3);
    let st = claudeState(4);
    expect(st.sessions[0]!.state).toBe("waiting");
    expect(st.sessions[0]!.permission).toBe("Bash: rm x");
    expect(st.alert.seq).toBe(1);
    expect(seen.at(-1)).toBe(1);
    permissionDecided("s1"); // answered on the tablet
    expect(claudeState(5).sessions[0]).toMatchObject({ state: "working", permission: "" });
    onHookEvent({ ...base, hook_event_name: "PostToolUse", tool_name: "Bash", tool_response: {} }, 5);
    st = claudeState(6);
    expect(st.sessions[0]!.state).toBe("working");
    expect(st.sessions[0]!.permission).toBe("");
  });

  test("idle_prompt notifications are not alerts; waiting sorts first; SessionEnd removes", () => {
    onHookEvent({ session_id: "a", cwd: "/x/aa", hook_event_name: "Stop" }, 1);
    onHookEvent({ session_id: "a", cwd: "/x/aa", hook_event_name: "Notification", message: "waiting", notification_type: "idle_prompt" }, 2);
    onHookEvent({ session_id: "b", cwd: "/x/bb", hook_event_name: "Notification", message: "needs you" }, 3);
    const st = claudeState(4);
    expect(st.sessions.map((s) => [s.name, s.state])).toEqual([
      ["bb", "waiting"],
      ["aa", "done"],
    ]);
    expect(st.counts).toEqual({ waiting: 1, working: 0, done: 1, idle: 0 });
    onHookEvent({ session_id: "b", hook_event_name: "SessionEnd" }, 5);
    expect(claudeState(6).sessions.length).toBe(1);
  });
});

describe("permission gate", () => {
  const ev = { session_id: "s", tool_name: "Bash", tool_input: { command: "deploy" } };
  test("allow / deny produce hook JSON; timeout falls back to empty output", async () => {
    let changes = 0;
    const p1 = hold(ev, 1000, () => changes++);
    const id = currentPending()!.id;
    expect(currentPending()!.summary).toBe("deploy");
    expect(decideById(id, "allow")).toBe(true);
    expect(await p1).toBe("allow");
    expect(decideById(id, "deny")).toBe(false); // stale
    expect(JSON.parse(hookResponse("allow")).hookSpecificOutput.decision.behavior).toBe("allow");
    expect(JSON.parse(hookResponse("deny")).hookSpecificOutput.decision.behavior).toBe("deny");
    expect(hookResponse("timeout")).toBe("");
    expect(await hold(ev, 20, () => changes++)).toBe("timeout");
    expect(currentPending()).toBeNull();
    expect(changes).toBeGreaterThanOrEqual(2);
  });
  test("requests queue; answering at the Mac drops a session's holds", async () => {
    const a = hold({ ...ev, session_id: "x" }, 5000, () => {});
    const b = hold({ ...ev, session_id: "y" }, 5000, () => {});
    expect(currentPending()!.session).toBe("x");
    dropSession("x");
    expect(await a).toBe("timeout");
    expect(currentPending()!.session).toBe("y");
    decideById(currentPending()!.id, "deny");
    expect(await b).toBe("deny");
  });
});

describe("transcripts + usage", () => {
  const line = (id: string, out: number, text = "", ts = "2026-11-16T10:15:00Z") =>
    JSON.stringify({
      type: "assistant",
      sessionId: "S",
      timestamp: ts,
      message: { id, model: "claude-opus-5-5", content: text ? [{ type: "text", text }] : [], usage: { input_tokens: 10, output_tokens: out, cache_read_input_tokens: 100, cache_creation_input_tokens: 5 } },
    }) + "\n";

  test("tail reads incrementally, dedupes streamed ids, ignores partial lines", async () => {
    const p = join(tmp(), "t.jsonl");
    writeFileSync(p, line("m1", 3) + JSON.stringify({ type: "user" }) + "\n" + line("m1", 7, "hello"));
    const t = new TranscriptTail(p);
    await t.poll();
    expect(t.total.output).toBe(7);
    expect(t.messages).toBe(1);
    expect(t.lastText).toBe("hello");
    expect(t.context).toBe(115);
    appendFileSync(p, line("m2", 4, "bye") + '{"type":"assis');
    await t.poll();
    expect(t.total.output).toBe(11);
    expect(t.lastText).toBe("bye");
    expect(parseAssistant('{"type":"user"}')).toBeNull();
  });

  test("usage buckets by local hour and day", () => {
    const at = Date.parse("2026-11-16T10:15:00Z");
    const d = __newDay(`${new Date(at).getFullYear()}-${new Date(at).getMonth() + 1}-${new Date(at).getDate()}`);
    const e = parseAssistant(line("m1", 50))!;
    addEntry(d, e, "proj");
    addEntry(d, e, "proj"); // dup id
    addEntry(d, parseAssistant(line("m2", 20, "", "2020-01-01T00:00:00Z"))!, "proj"); // other day
    expect(d.output).toBe(50);
    expect(d.hourOut[new Date(at).getHours()]).toBe(50);
    expect(d.sessions.size).toBe(1);
  });

  test("project names drop the home prefix", () => {
    const home = (process.env.HOME ?? "").replace(/\//g, "-");
    expect(projectName(`${home}-lenovo-tab`)).toBe("lenovo-tab");
    expect(projectName(`${home}-Documents-erp`)).toBe("erp");
  });
});

describe("focus timer", () => {
  test("start, pause, resume, finish, add, reset", () => {
    let f = newFocus(25, 0);
    f = focusAction(f, "focus.start", { min: 1 }, 25, 0);
    expect(focusState(f).left).toBe("01:00");
    let done: boolean;
    [f, done] = focusTick(f, 30_000);
    expect([f.remaining, done]).toEqual([30, false]);
    f = focusAction(f, "focus.toggle", null, 25, 30_000);
    expect(f.mode).toBe("paused");
    [f] = focusTick(f, 100_000);
    expect(f.remaining).toBe(30);
    f = focusAction(f, "focus.toggle", null, 25, 100_000);
    [f, done] = focusTick(f, 130_000);
    expect([f.mode, f.rounds, done]).toEqual(["done", 1, true]);
    f = focusAction(f, "focus.add", null, 25, 130_000);
    expect([f.mode, f.remaining]).toEqual(["paused", 300]);
    f = focusAction(f, "focus.reset", null, 25, 131_000);
    expect([f.mode, f.remaining, f.rounds]).toEqual(["idle", 1500, 1]);
    expect(focusState(f).progress).toBe(0);
  });
});
