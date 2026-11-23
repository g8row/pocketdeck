// Claude Code session tracker, fed by hooks (hooks/claude-hook.sh POSTs each
// hook event JSON to http://127.0.0.1:7778/claude; hooks/claude-gate.sh holds
// PermissionRequest events on /claude/permission, see gate.ts).
//
// Per session we keep: state, the latest prompts, a tool-call timeline with
// durations (PreToolUse ↔ PostToolUse by tool_use_id), counts, the pending
// permission request, and — from the transcript — model, token usage, context
// size and the last assistant message.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { TranscriptTail } from "./transcript.ts";

export type SessionState = "working" | "waiting" | "done" | "idle";

export interface ToolCall {
  id: string;
  tool: string;
  /** Raw tool name + a plain-language sentence for the "now" card. */
  raw: string;
  act: string;
  /** Second line under the sentence: "$ bun test", "Edit · claude.ts". */
  sub: string;
  summary: string;
  at: number;
  ms?: number;
  ok?: boolean;
  /** ms is an estimate (closed by the next event, no PostToolUse seen). */
  est?: boolean;
}

export interface Session {
  id: string;
  name: string;
  cwd: string;
  state: SessionState;
  detail: string;
  updated: number;
  started: number;
  prompts: { text: string; at: number }[];
  tools: ToolCall[];
  promptCount: number;
  toolCount: number;
  failCount: number;
  byTool: Record<string, number>;
  permission?: { tool: string; summary: string; at: number };
  subagents: number;
  transcript?: string;
  /** A multiple-choice question Claude is asking (AskUserQuestion input). */
  question?: Question[];
  /** A plan waiting for approval (ExitPlanMode). */
  plan?: string;
  turnStart?: number;
  turnEnd?: number;
  /** Files edited/written since the last prompt. */
  changed: string[];
}

export interface Question {
  q: string;
  header: string;
  multi: boolean;
  options: { label: string; desc: string }[];
}

const sessions = new Map<string, Session>();
const tails = new Map<string, TranscriptTail>();
const STALE_MS = 3 * 60 * 60 * 1000;
const MAX_TOOLS = 14;
const MAX_PROMPTS = 6;

/** Bumped every time a session newly needs the user (tablet flashes on change). */
let alert = { seq: 0, session: "", name: "", reason: "", at: 0 };
const alertListeners: ((a: typeof alert) => void)[] = [];
export const onAlert = (fn: (a: typeof alert) => void) => alertListeners.push(fn);

const clip = (s: unknown, n = 120) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, n) : "");
const short = (p: unknown) => (typeof p === "string" && p ? basename(p) : "");

/** One-line human summary of a tool call's input. */
export function summarizeTool(tool: string, input: any): string {
  const i = input && typeof input === "object" ? input : {};
  switch (tool) {
    case "Bash":
      return clip(i.description || i.command, 70);
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return short(i.file_path ?? i.notebook_path);
    case "Grep":
      return clip(`/${i.pattern ?? ""}/${i.path ? ` in ${short(i.path)}` : ""}`, 70);
    case "Glob":
      return clip(i.pattern, 70);
    case "WebFetch":
      try {
        return new URL(i.url).host;
      } catch {
        return clip(i.url, 70);
      }
    case "WebSearch":
      return clip(i.query, 70);
    case "Task":
    case "Agent":
      return clip(i.description ?? i.prompt, 70);
    case "TodoWrite":
      return Array.isArray(i.todos) ? `${i.todos.length} todos` : "todos";
  }
  for (const v of Object.values(i)) if (typeof v === "string" && v.trim()) return clip(v, 70);
  return "";
}

const cap = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** The tool call as a sentence ("Editing claude.ts") for the tablet's "now" card. */
export function activity(tool: string, input: any, summary: string): string {
  const i = input && typeof input === "object" ? input : {};
  switch (tool) {
    case "Bash":
      return cap(clip(i.description, 70)) || "Running a command";
    case "Read":
      return `Reading ${summary}`;
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return `Editing ${summary}`;
    case "Write":
      return `Writing ${summary}`;
    case "Grep":
      return `Searching for ${clip(i.pattern, 40)}`;
    case "Glob":
      return "Finding files";
    case "WebFetch":
      return `Reading ${summary}`;
    case "WebSearch":
      return "Searching the web";
    case "Task":
    case "Agent":
      return `Running an agent: ${clip(i.description, 50)}`;
    case "TodoWrite":
      return "Updating its task list";
    case "AskUserQuestion":
      return "Asking you a question";
    case "ExitPlanMode":
      return "Presenting a plan";
  }
  return `Using ${toolName(tool)}`;
}

function subLine(raw: string, tool: string, input: any, summary: string): string {
  if (raw === "Bash" && typeof input?.command === "string") return `$ ${clip(input.command, 80)}`;
  return `${tool}${summary ? ` · ${summary}` : ""}`;
}

/** AskUserQuestion input → what the tablet needs (clipped; answers go back by index). */
export function questionsOf(input: any): Question[] {
  const qs = Array.isArray(input?.questions) ? input.questions : [];
  return qs.slice(0, 4).map((q: any) => ({
    q: clip(q?.question, 200),
    header: clip(q?.header, 24),
    multi: q?.multiSelect === true,
    options: (Array.isArray(q?.options) ? q.options : []).slice(0, 4).map((o: any) => ({ label: clip(o?.label, 60), desc: clip(o?.description, 100) })),
  }));
}

/** Markdown → plain text for the tablet (keeps paragraphs and bullets). */
export function plain(md: string, max = 3000): string {
  return md
    .replace(/\r/g, "")
    .replace(/```[\w-]*\n?/g, "")
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

/** mcp__server__tool → server:tool, so the tablet's narrow columns fit. */
export const toolName = (t: unknown) => {
  const s = typeof t === "string" ? t : "tool";
  const m = s.match(/^mcp__(.+?)__(.+)$/);
  return m ? `${m[1]!.replace(/^plugin_[^_]+_/, "").slice(0, 10)}:${m[2]}` : s;
};

/** Without a PostToolUse hook a call never closes; the session moving on (next
 *  tool, prompt or Stop) bounds its duration, so close it as an estimate. A
 *  real PostToolUse still overrides it. */
function closeOpen(s: Session, now: number) {
  for (const c of s.tools)
    if (c.ms === undefined) {
      c.ms = now - c.at;
      c.est = true;
    }
}

function setState(s: Session, st: SessionState, now: number, reason: string) {
  if (st === "waiting" && s.state !== "waiting") {
    alert = { seq: alert.seq + 1, session: s.id, name: s.name, reason, at: now };
    for (const fn of alertListeners) fn(alert);
  }
  s.state = st;
}

export function onHookEvent(ev: Record<string, any>, now = Date.now()): void {
  const id = String(ev.session_id ?? "unknown");
  if (ev.hook_event_name === "SessionEnd") {
    sessions.delete(id);
    tails.delete(id);
    return;
  }
  const cwd = typeof ev.cwd === "string" ? ev.cwd : "";
  const s: Session = sessions.get(id) ?? {
    id,
    name: "session",
    cwd,
    state: "idle",
    detail: "",
    updated: now,
    started: now,
    prompts: [],
    tools: [],
    promptCount: 0,
    toolCount: 0,
    failCount: 0,
    byTool: {},
    subagents: 0,
    changed: [],
  };
  if (cwd) {
    s.cwd = cwd;
    s.name = basename(cwd);
  }
  if (typeof ev.transcript_path === "string" && ev.transcript_path) {
    s.transcript = ev.transcript_path;
    if (!tails.has(id) || tails.get(id)!.path !== ev.transcript_path) tails.set(id, new TranscriptTail(ev.transcript_path));
  }
  s.updated = now;
  const tool = toolName(ev.tool_name);
  switch (ev.hook_event_name) {
    case "SessionStart":
      setState(s, "idle", now, "");
      s.detail = ev.source && ev.source !== "startup" ? `${ev.source}d` : "started";
      break;
    case "UserPromptSubmit":
      closeOpen(s, now);
      setState(s, "working", now, "");
      s.detail = clip(ev.prompt) || "thinking";
      s.permission = undefined;
      s.question = undefined;
      s.plan = undefined;
      s.turnStart = now;
      s.turnEnd = undefined;
      s.changed = [];
      s.promptCount++;
      s.prompts.unshift({ text: clip(ev.prompt, 300), at: now });
      s.prompts.length = Math.min(s.prompts.length, MAX_PROMPTS);
      break;
    case "PreToolUse": {
      closeOpen(s, now);
      setState(s, "working", now, "");
      const raw = String(ev.tool_name ?? "");
      const summary = summarizeTool(raw, ev.tool_input);
      s.detail = summary ? `${tool}: ${summary}` : tool;
      s.toolCount++;
      s.byTool[tool] = (s.byTool[tool] ?? 0) + 1;
      s.tools.unshift({ id: String(ev.tool_use_id ?? `${now}`), tool, raw, act: activity(raw, ev.tool_input, summary), sub: subLine(raw, tool, ev.tool_input, summary), summary, at: now });
      if (/^(Edit|MultiEdit|Write|NotebookEdit)$/.test(raw) && summary && !s.changed.includes(summary)) s.changed.push(summary);
      noteAsk(s, raw, ev.tool_input, now);
      s.tools.length = Math.min(s.tools.length, MAX_TOOLS);
      break;
    }
    case "PostToolUse":
    case "PostToolUseFailure": {
      const failed =
        ev.hook_event_name === "PostToolUseFailure" ||
        ev.tool_response?.is_error === true ||
        (typeof ev.tool_response?.error === "string" && ev.tool_response.error !== "") ||
        ev.tool_response?.interrupted === true;
      const call =
        s.tools.find((t) => ev.tool_use_id && t.id === String(ev.tool_use_id)) ??
        s.tools.find((t) => t.tool === tool && (t.ms === undefined || t.est));
      if (call && (call.ms === undefined || call.est)) {
        call.ms = now - call.at;
        call.ok = !failed;
        call.est = false;
      }
      if (failed) s.failCount++;
      if (s.state === "waiting") setState(s, "working", now, "");
      s.permission = undefined;
      s.question = undefined;
      s.plan = undefined;
      break;
    }
    case "PermissionRequest": {
      const summary = summarizeTool(String(ev.tool_name ?? ""), ev.tool_input);
      s.permission = { tool, summary, at: now };
      s.detail = `allow ${tool}${summary ? `: ${summary}` : ""}?`;
      // questions/plans: the PermissionRequest input carries the injected plan text
      if (!noteAsk(s, String(ev.tool_name ?? ""), ev.tool_input, now)) setState(s, "waiting", now, s.detail);
      break;
    }
    case "Notification": {
      const msg = clip(ev.message) || "needs your attention";
      const type = String(ev.notification_type ?? "");
      if (type === "idle_prompt") {
        // Claude finished a while ago and is waiting for the next prompt — not urgent.
        if (s.state !== "waiting") s.state = "done";
        s.detail = "waiting for your next prompt";
        break;
      }
      if (!s.permission && /permission/i.test(msg)) s.permission = { tool: "", summary: msg, at: now };
      s.detail = msg;
      setState(s, "waiting", now, msg);
      break;
    }
    case "SubagentStop":
      s.subagents++;
      break;
    case "PreCompact":
      s.detail = "compacting context";
      break;
    case "Stop":
      closeOpen(s, now);
      setState(s, "done", now, "");
      s.permission = undefined;
      s.question = undefined;
      s.plan = undefined;
      s.turnEnd = now;
      s.detail = "finished";
      break;
  }
  sessions.set(id, s);
}

/** AskUserQuestion / ExitPlanMode need you even without the permission gate:
 *  keep what they ask so the tablet can show it. Returns true if it was one. */
function noteAsk(s: Session, raw: string, input: any, now: number): boolean {
  if (raw === "AskUserQuestion") {
    const q = questionsOf(input);
    if (q.length) s.question = q;
    s.detail = "asks you a question";
  } else if (raw === "ExitPlanMode") {
    const plan = typeof input?.plan === "string" ? input.plan : "";
    if (plan) s.plan = plain(plan, 4000);
    s.detail = "plan ready for approval";
  } else return false;
  setState(s, "waiting", now, s.detail);
  return true;
}

/** The tablet answered a held PermissionRequest: the tool now runs (allow) or
 *  Claude carries on without it (deny) — either way it no longer needs you. */
export function permissionDecided(sessionId: string): void {
  const s = sessions.get(sessionId);
  if (!s) return;
  s.permission = undefined;
  s.question = undefined;
  s.plan = undefined;
  if (s.state === "waiting") s.state = "working";
  s.detail = "answered on the tablet";
}

/** Pull new transcript bytes for every live session (cheap, incremental). */
export async function pollTranscripts(): Promise<void> {
  await Promise.all([...tails.values()].map((t) => t.poll().catch(() => false)));
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id);
}
export function lastMessage(id: string): string {
  return tails.get(id)?.lastText ?? "";
}

export function ago(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

export const ORDER: Record<SessionState, number> = { waiting: 0, working: 1, done: 2, idle: 3 };

export function hooksInstalled(): boolean {
  try {
    return readFileSync(`${process.env.HOME}/.claude/settings.json`, "utf8").includes("claude-hook.sh");
  } catch {
    return false;
  }
}

const kfmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}m` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
const hhmm = (t: number) => {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

/** The tablet-facing snapshot. Everything pre-formatted: the tablet only lays out strings. */
type Held = { id: string; session: string; tool: string; toolRaw?: string; input?: any; summary: string; expires: number };

const KIND: Record<string, string> = { AskUserQuestion: "question", ExitPlanMode: "plan" };

export function claudeState(now = Date.now(), pending?: Held | null, held: Held[] = pending ? [pending] : []) {
  for (const [id, s] of sessions)
    if (now - s.updated > STALE_MS) {
      sessions.delete(id);
      tails.delete(id);
    }
  const list = [...sessions.values()]
    .sort((a, b) => ORDER[a.state] - ORDER[b.state] || b.updated - a.updated)
    .map((s) => {
      const t = tails.get(s.id);
      const top = Object.entries(s.byTool)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
        .map(([k, v]) => `${k} ${v}`)
        .join(" · ");
      return {
        id: s.id,
        name: s.name,
        cwd: s.cwd.replace(process.env.HOME ?? "~", "~"),
        state: s.state,
        detail: s.detail,
        ago: ago(now - s.updated),
        up: ago(now - s.started),
        prompts: s.prompts.map((p) => ({ text: p.text, at: hhmm(p.at) })),
        tools: s.tools.map((c) => ({
          tool: c.tool,
          summary: c.summary,
          at: hhmm(c.at),
          ms: c.ms === undefined ? "…" : `${c.est ? "~" : ""}${c.ms < 1000 ? `${c.ms}ms` : `${(c.ms / 1000).toFixed(1)}s`}`,
          ok: c.ms === undefined ? "run" : c.est ? "est" : c.ok ? "ok" : "fail",
        })),
        promptCount: s.promptCount,
        toolCount: s.toolCount,
        failCount: s.failCount,
        top,
        subagents: s.subagents,
        permission: s.permission ? `${s.permission.tool}${s.permission.tool && s.permission.summary ? ": " : ""}${s.permission.summary}` : "",
        model: (t?.model ?? "").replace(/^claude-/, ""),
        tokens: t ? `${kfmt(t.total.input + t.total.cacheRead + t.total.cacheWrite)} in · ${kfmt(t.total.output)} out` : "",
        context: t?.context ? kfmt(t.context) : "",
        // past 200k the session must be on a 1M-context model
        contextPct: t?.context ? Math.min(100, Math.round((t.context / (t.context > 200_000 ? 1_000_000 : 200_000)) * 100)) : 0,
        last: clip(t?.lastText ?? "", 220),
        // ---- conversation layout ----
        prompt: s.prompts[0]?.text ?? "",
        reply: plain(t?.lastText ?? ""),
        now: nowCard(s),
        run: running(s, now),
        steps: s.tools
          .filter((c) => c.ms !== undefined)
          .slice(0, 3)
          .map((c) => ({ t: `${c.tool} ${c.summary}`.trim(), fail: c.ok === false && !c.est })),
        ctx: t?.context ? `${kfmt(t.context)} / ${t.context > 200_000 ? "1M" : "200k"}` : "",
        took: s.turnStart !== undefined && s.turnEnd !== undefined ? ago(s.turnEnd - s.turnStart) : "",
        changed: s.changed.slice(-4).reverse(),
        question: s.question ?? null,
        plan: s.plan ?? "",
        held: heldFor(s.id, held, now),
      };
    });
  const counts = { waiting: 0, working: 0, done: 0, idle: 0 } as Record<SessionState, number>;
  for (const s of sessions.values()) counts[s.state]++;
  return {
    hooks: hooksInstalled(),
    sessions: list,
    counts,
    alert,
    pending: pending
      ? {
          id: pending.id,
          session: sessions.get(pending.session)?.name ?? "session",
          tool: pending.tool,
          kind: KIND[pending.toolRaw ?? ""] ?? "permission",
          summary: pending.summary,
          left: Math.max(0, Math.ceil((pending.expires - now) / 1000)),
        }
      : null,
  };
}

function nowCard(s: Session): { text: string; sub: string } {
  const cur = s.tools[0];
  if (s.state === "working" && cur && cur.ms === undefined) return { text: cur.act || cur.tool, sub: cur.sub };
  if (s.state === "working") return { text: s.detail === "compacting context" ? "Compacting context" : "Thinking", sub: s.detail === "compacting context" ? "frees room · back shortly" : "" };
  if (s.state === "waiting") return { text: cap(s.detail), sub: "" };
  if (s.state === "done") return { text: "Finished", sub: "" };
  return { text: "Idle", sub: "" };
}

function running(s: Session, now: number): string {
  const cur = s.tools[0];
  if (s.state === "working" && cur && cur.ms === undefined) return ago(now - cur.at);
  return ago(now - s.updated);
}

function heldFor(id: string, held: Held[], now: number) {
  const p = held.find((h) => h.session === id);
  if (!p) return null;
  const input = p.input ?? {};
  return {
    id: p.id,
    kind: KIND[p.toolRaw ?? ""] ?? "permission",
    tool: p.tool,
    command: clip(typeof input.command === "string" ? input.command : p.summary, 400),
    why: clip(typeof input.description === "string" ? input.description : "", 120),
    left: Math.max(0, Math.ceil((p.expires - now) / 1000)),
  };
}

export function __resetSessions(): void {
  sessions.clear();
  tails.clear();
  alert = { seq: 0, session: "", name: "", reason: "", at: 0 };
}
