// Claude Code usage, from the local transcripts: every ~/.claude/projects/*/*.jsonl
// touched in the last 7 days is tailed incrementally. Today's assistant messages are
// bucketed by local hour (`Day`); every message also lands in a per-day total for the
// 7-day view (`Week`). No network, no API keys.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TranscriptTail, type AssistantEntry } from "./transcript.ts";

const ROOT = process.env.CLAUDE_PROJECTS ?? join(process.env.HOME ?? "", ".claude/projects");

interface Day {
  key: string; // yyyy-mm-dd local
  hourOut: number[]; // output tokens per hour
  hourMsgs: number[];
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  messages: number;
  sessions: Set<string>;
  projects: Map<string, number>; // project dir → output tokens
  models: Map<string, number>;
  seen: Set<string>;
}

const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
};
function newDay(key: string): Day {
  return {
    key,
    hourOut: new Array(24).fill(0),
    hourMsgs: new Array(24).fill(0),
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    messages: 0,
    sessions: new Set(),
    projects: new Map(),
    models: new Map(),
    seen: new Set(),
  };
}
let day = newDay(dayKey(Date.now()));

// ---- the last 7 days ------------------------------------------------------------------

export const WEEK_DAYS = 7;
interface DayTotal {
  out: number;
  projects: Map<string, number>;
  seen: Set<string>;
}
/** dayKey → that day's output tokens, overall and per project. */
export type Week = Map<string, DayTotal>;
export const newWeek = (): Week => new Map();
let week = newWeek();

/** Local midnight `n` days before `now`'s. */
const dayStart = (now: number, n = 0) => {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - n);
  return d.getTime();
};

/** Fold one assistant entry into the week, deduped per message id (exported for tests). */
export function addWeekEntry(w: Week, e: AssistantEntry, project: string): void {
  if (!e.at) return;
  const key = dayKey(e.at);
  let t = w.get(key);
  if (!t) w.set(key, (t = { out: 0, projects: new Map(), seen: new Set() }));
  if (t.seen.has(e.id)) return;
  t.seen.add(e.id);
  t.out += e.usage.output;
  t.projects.set(project, (t.projects.get(project) ?? 0) + e.usage.output);
}

/** Drop days that fell out of the window. */
function pruneWeek(w: Week, now: number) {
  const keep = new Set(Array.from({ length: WEEK_DAYS }, (_, i) => dayKey(dayStart(now, i))));
  for (const k of w.keys()) if (!keep.has(k)) w.delete(k);
}

const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const MAX_PROJECTS = 12;

/** { name, out "12.3k", pct share of the total } sorted by output, largest first. */
function projectList(m: Map<string, number>) {
  const total = [...m.values()].reduce((a, b) => a + b, 0);
  return [...m.entries()]
    .filter(([, v]) => v > 0)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_PROJECTS)
    .map(([name, v]) => ({ name, out: kfmt(v), pct: total > 0 ? Math.round((v / total) * 100) : 0 }));
}

/** days[7] (oldest first, today last) and projects7d (exported for tests). */
export function weekState(w: Week, now = Date.now()) {
  const days = [];
  const projects = new Map<string, number>();
  for (let i = WEEK_DAYS - 1; i >= 0; i--) {
    const start = dayStart(now, i);
    const t = w.get(dayKey(start));
    days.push({ d: DOW[new Date(start).getDay()]!, out: t?.out ?? 0 });
    for (const [p, v] of t?.projects ?? []) projects.set(p, (projects.get(p) ?? 0) + v);
  }
  return { days, projects7d: projectList(projects) };
}

/** Every transcript tailed (path → tail), kept across midnight so nothing is read twice. */
const tails = new Map<string, TranscriptTail>();

/** Fold one assistant entry into the day (exported for tests). */
export function addEntry(d: Day, e: AssistantEntry, project: string): void {
  if (!e.at || dayKey(e.at) !== d.key) return;
  // Streamed chunks repeat the id; output_tokens grows, so count the first
  // occurrence's input and keep the max output via a re-add of the delta.
  if (d.seen.has(e.id)) return;
  d.seen.add(e.id);
  const h = new Date(e.at).getHours();
  d.hourOut[h]! += e.usage.output;
  d.hourMsgs[h]!++;
  d.input += e.usage.input;
  d.output += e.usage.output;
  d.cacheRead += e.usage.cacheRead;
  d.cacheWrite += e.usage.cacheWrite;
  d.messages++;
  if (e.sessionId) d.sessions.add(e.sessionId);
  d.projects.set(project, (d.projects.get(project) ?? 0) + e.usage.output);
  if (e.model && !e.model.startsWith("<")) d.models.set(e.model, (d.models.get(e.model) ?? 0) + 1);
}
export const __newDay = newDay;

/** Pretty project name from the dir (-Users-me-lenovo-tab → lenovo-tab). */
export function projectName(dir: string): string {
  const parts = dir.split("-").filter(Boolean);
  const home = (process.env.HOME ?? "").split("/").filter(Boolean);
  let i = 0;
  while (i < home.length && parts[i] === home[i]) i++;
  const rest = parts.slice(i);
  if (rest[0] === "Documents" || rest[0] === "src" || rest[0] === "code") rest.shift();
  return rest.join("-") || dir;
}

export async function scanUsage(now = Date.now()): Promise<void> {
  const key = dayKey(now);
  if (key !== day.key) day = newDay(key);
  pruneWeek(week, now);
  const since = dayStart(now, WEEK_DAYS - 1);
  let dirs: string[] = [];
  try {
    dirs = readdirSync(ROOT);
  } catch {
    return;
  }
  const live = new Set<string>();
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    const project = projectName(dir);
    for (const f of files) {
      const path = join(ROOT, dir, f);
      try {
        if (statSync(path).mtimeMs < since) continue;
      } catch {
        continue;
      }
      live.add(path);
      let tail = tails.get(path);
      if (!tail) {
        tail = new TranscriptTail(path);
        tails.set(path, tail);
      }
      await tail
        .poll((e) => {
          addEntry(day, e, project);
          addWeekEntry(week, e, project);
        })
        .catch(() => false);
    }
  }
  // transcripts untouched for a week (or deleted) are done with
  for (const p of tails.keys()) if (!live.has(p)) tails.delete(p);
  pruneWeek(week, now);
}

const kfmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

export function usageState(now = Date.now()) {
  const d = day;
  const peak = Math.max(1, ...d.hourOut);
  return {
    hour: new Date(now).getHours(),
    /** 0..8 per hour, for ASCII bars */
    bars: d.hourOut.map((v) => (v === 0 ? 0 : Math.max(1, Math.round((v / peak) * 8)))),
    peak: kfmt(peak),
    output: kfmt(d.output),
    input: kfmt(d.input + d.cacheRead + d.cacheWrite),
    cacheHit: d.input + d.cacheRead + d.cacheWrite > 0 ? Math.round((d.cacheRead / (d.input + d.cacheRead + d.cacheWrite)) * 100) : 0,
    messages: d.messages,
    sessions: d.sessions.size,
    /** output tokens in the last 60 minutes (rough "rate") */
    lastHour: kfmt(d.hourOut[new Date(now).getHours()]!),
    /** pct = share of today's output (the page sums them for "+N more") */
    projects: projectList(d.projects),
    model: [...d.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/^claude-/, "") ?? "",
    ...weekState(week, now),
  };
}
