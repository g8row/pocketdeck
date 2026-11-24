// Incremental reader for Claude Code transcripts (~/.claude/projects/*/*.jsonl).
// Each call reads only the bytes appended since the last call (up to the last
// complete line), so polling a multi-MB transcript every few seconds is cheap.

import { statSync } from "node:fs";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export const zeroUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });

export interface AssistantEntry {
  id: string;
  model: string;
  usage: Usage;
  text: string;
  /** epoch ms (from the entry's ISO timestamp; 0 when missing) */
  at: number;
  sessionId: string;
}

/** Parse one JSONL line; returns the assistant entry or null for anything else. */
export function parseAssistant(line: string): AssistantEntry | null {
  if (!line.includes('"assistant"')) return null; // cheap reject before JSON.parse
  let e: any;
  try {
    e = JSON.parse(line);
  } catch {
    return null;
  }
  if (e?.type !== "assistant" || !e.message) return null;
  const m = e.message;
  const u = m.usage ?? {};
  const text = Array.isArray(m.content)
    ? m.content
        .filter((c: any) => c?.type === "text" && typeof c.text === "string")
        .map((c: any) => c.text)
        .join("\n")
    : typeof m.content === "string"
      ? m.content
      : "";
  return {
    id: String(m.id ?? e.uuid ?? ""),
    model: String(m.model ?? ""),
    usage: {
      input: Number(u.input_tokens) || 0,
      output: Number(u.output_tokens) || 0,
      cacheRead: Number(u.cache_read_input_tokens) || 0,
      cacheWrite: Number(u.cache_creation_input_tokens) || 0,
    },
    text,
    at: e.timestamp ? Date.parse(e.timestamp) || 0 : 0,
    sessionId: String(e.sessionId ?? ""),
  };
}

export class TranscriptTail {
  private offset = 0;
  /** Streamed chunks of one message repeat its id; count usage once per id
   *  (keep the last-seen usage, which carries the final output count). */
  private seen = new Map<string, Usage>();
  readonly total: Usage = zeroUsage();
  model = "";
  lastText = "";
  /** Context window in use after the latest turn (input + cache tokens). */
  context = 0;
  messages = 0;

  constructor(readonly path: string) {}

  /** Read appended lines; calls `each` for every new assistant entry. */
  async poll(each?: (e: AssistantEntry) => void): Promise<boolean> {
    let size: number;
    try {
      size = statSync(this.path).size;
    } catch {
      return false;
    }
    if (size < this.offset) this.reset(); // truncated/rewritten
    if (size === this.offset) return false;
    const buf = await Bun.file(this.path).slice(this.offset, size).text();
    const end = buf.lastIndexOf("\n");
    if (end < 0) return false;
    this.offset += Buffer.byteLength(buf.slice(0, end + 1));
    for (const line of buf.slice(0, end).split("\n")) {
      const a = parseAssistant(line);
      if (!a) continue;
      this.add(a);
      each?.(a);
    }
    return true;
  }

  private add(a: AssistantEntry) {
    const prev = this.seen.get(a.id);
    if (prev) for (const k of Object.keys(prev) as (keyof Usage)[]) this.total[k] -= prev[k];
    else this.messages++;
    this.seen.set(a.id, a.usage);
    for (const k of Object.keys(a.usage) as (keyof Usage)[]) this.total[k] += a.usage[k];
    if (a.model && !a.model.startsWith("<")) this.model = a.model;
    if (a.text.trim()) this.lastText = a.text.trim();
    this.context = a.usage.input + a.usage.cacheRead + a.usage.cacheWrite;
  }

  private reset() {
    this.offset = 0;
    this.seen.clear();
    Object.assign(this.total, zeroUsage());
    this.messages = 0;
  }
}
