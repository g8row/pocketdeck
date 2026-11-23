// Today's Claude Code usage, from the local transcripts: every
// ~/.claude/projects/*/*.jsonl touched today is tailed incrementally and its
// assistant messages are bucketed by local hour. No network, no API keys.

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TranscriptTail, type AssistantEntry } from "./transcript.ts";

const ROOT = process.env.CLAUDE_PROJECTS ?? join(process.env.HOME ?? "", ".claude/projects");

interface Day {
  key: string; // yyyy-mm-dd local
  tails: Map<string, TranscriptTail>;
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
    tails: new Map(),
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
  const startOfDay = new Date(now).setHours(0, 0, 0, 0);
  let dirs: string[] = [];
  try {
    dirs = readdirSync(ROOT);
  } catch {
    return;
  }
  for (const dir of dirs) {
    let files: string[] = [];
    try {
      files = readdirSync(join(ROOT, dir)).filter((f) => f.endsWith(".jsonl"));
    } catch {
      continue;
    }
    for (const f of files) {
      const path = join(ROOT, dir, f);
      let tail = day.tails.get(path);
      if (!tail) {
        try {
          if (statSync(path).mtimeMs < startOfDay) continue;
        } catch {
          continue;
        }
        tail = new TranscriptTail(path);
        day.tails.set(path, tail);
      }
      const project = projectName(dir);
      await tail.poll((e) => addEntry(day, e, project)).catch(() => false);
    }
  }
}

const kfmt = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}m` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : `${n}`);

export function usageState(now = Date.now()) {
  const d = day;
  const peak = Math.max(1, ...d.hourOut);
  const projects = [...d.projects.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4);
  const pmax = Math.max(1, ...projects.map((p) => p[1]));
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
    projects: projects.map(([name, v]) => ({ name, out: kfmt(v), pct: Math.round((v / pmax) * 100) })),
    model: [...d.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]?.replace(/^claude-/, "") ?? "",
  };
}
