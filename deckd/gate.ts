// Permission gate: Claude Code's PermissionRequest hook (hooks/claude-gate.sh)
// POSTs to /claude/permission and waits for the response body. deskd holds the
// request until the tablet taps allow/deny or the timeout passes. On timeout
// (or when the gate is off / no tablet is connected) the body is empty, the
// hook prints nothing, and Claude Code shows its normal prompt — a session is
// never blocked for longer than the timeout.

import { summarizeTool, toolName } from "./providers/claude.ts";

export interface Pending {
  id: string;
  session: string;
  tool: string;
  /** Raw tool name (AskUserQuestion, ExitPlanMode, Bash…). */
  toolRaw: string;
  input: Record<string, any>;
  summary: string;
  expires: number;
  resolve: (d: Decision, extra?: Extra) => void;
}
export type Decision = "allow" | "deny" | "timeout";
/** Extra fields for an allow: AskUserQuestion / ExitPlanMode need updatedInput,
 *  "allow for this session" / "auto-accept edits" are updatedPermissions. */
export interface Extra {
  updatedInput?: Record<string, any>;
  updatedPermissions?: Record<string, any>[];
  message?: string;
}

let pending: Pending | null = null;
const queue: Pending[] = [];
let n = 0;

export function currentPending(): Pending | null {
  return pending;
}

function promote() {
  if (!pending && queue.length) pending = queue.shift()!;
}

/** Hold a request; resolves with the decision (or "timeout"). */
export function hold(ev: Record<string, any>, timeoutMs: number, onChange: () => void, now = Date.now()): Promise<Decision> {
  return holdFull(ev, timeoutMs, onChange, now).then((r) => r.d);
}

/** hold(), plus the extra fields the tablet attached to its decision. */
export function holdFull(ev: Record<string, any>, timeoutMs: number, onChange: () => void, now = Date.now()): Promise<{ d: Decision; extra?: Extra }> {
  return new Promise((resolve) => {
    const p: Pending = {
      id: `p${++n}`,
      session: String(ev.session_id ?? ""),
      tool: toolName(ev.tool_name),
      toolRaw: String(ev.tool_name ?? ""),
      input: ev.tool_input && typeof ev.tool_input === "object" ? ev.tool_input : {},
      summary: summarizeTool(String(ev.tool_name ?? ""), ev.tool_input),
      expires: now + timeoutMs,
      resolve: () => {},
    };
    const timer = setTimeout(() => finish(p, "timeout"), timeoutMs);
    p.resolve = (d, extra) => {
      clearTimeout(timer);
      resolve({ d, extra });
    };
    queue.push(p);
    promote();
    onChange();
    function finish(x: Pending, d: Decision) {
      decideById(x.id, d);
      onChange();
    }
  });
}

/** Tablet decision (or timeout). Returns false for unknown/stale ids. */
export function decideById(id: string, d: Decision, extra?: Extra): boolean {
  let p: Pending | undefined;
  if (pending?.id === id) {
    p = pending;
    pending = null;
  } else {
    const i = queue.findIndex((q) => q.id === id);
    if (i >= 0) p = queue.splice(i, 1)[0];
  }
  if (!p) return false;
  promote();
  p.resolve(d, extra);
  return true;
}

/** Every held request (the shown one first), for per-session cards. */
export function allPending(): Pending[] {
  return pending ? [pending, ...queue] : [...queue];
}

/** Find a held request by id (the tablet's answer needs its tool input). */
export function findPending(id: string): Pending | undefined {
  return allPending().find((p) => p.id === id);
}

/** Drop held requests for a session that moved on (answered at the Mac). */
export function dropSession(session: string): void {
  for (const q of [pending, ...queue]) if (q && q.session === session) decideById(q.id, "timeout");
}

/** The hook's stdout for a decision (empty = fall back to the normal prompt). */
export function hookResponse(d: Decision, extra?: Extra): string {
  if (d === "timeout") return "";
  const decision: Record<string, any> =
    d === "allow" ? { behavior: "allow" } : { behavior: "deny", message: extra?.message ?? "Denied from the desk tablet." };
  if (d === "allow" && extra?.updatedInput) decision.updatedInput = extra.updatedInput;
  if (d === "allow" && extra?.updatedPermissions?.length) decision.updatedPermissions = extra.updatedPermissions;
  return JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision } });
}

/** Build the decision for a tablet answer. kind:
 *  - permit: allow/deny, optional `always` → session allow rule for the tool
 *  - answer: AskUserQuestion answers, as option indices per question
 *  - plan:   approve (optionally switching to acceptEdits) or keep planning */
export function tabletDecision(p: Pending, args: any): { d: Decision; extra?: Extra } {
  if (Array.isArray(args?.answers) && p.toolRaw === "AskUserQuestion") {
    // the tablet sends option indices per question (its labels are clipped);
    // Claude Code wants { [question text]: label } with multi-select joined by ", "
    const qs: any[] = Array.isArray(p.input.questions) ? p.input.questions : [];
    const answers: Record<string, string> = {};
    qs.forEach((q, i) => {
      const picks: number[] = Array.isArray(args.answers[i]) ? args.answers[i] : [];
      const labels = picks.map((k) => q?.options?.[k]?.label).filter((l): l is string => typeof l === "string");
      if (typeof q?.question === "string" && labels.length) answers[q.question] = labels.join(", ");
    });
    return { d: "allow", extra: { updatedInput: { ...p.input, answers } } };
  }
  if (!args?.allow) {
    const message = p.toolRaw === "ExitPlanMode" ? "Not approved from the desk tablet; keep planning." : undefined;
    return { d: "deny", extra: message ? { message } : undefined };
  }
  const extra: Extra = {};
  // these two tools need their input echoed back on allow
  if (p.toolRaw === "ExitPlanMode" || p.toolRaw === "AskUserQuestion") extra.updatedInput = p.input;
  if (args.mode === "acceptEdits") extra.updatedPermissions = [{ type: "setMode", mode: "acceptEdits", destination: "session" }];
  else if (args.always && p.toolRaw)
    extra.updatedPermissions = [{ type: "addRules", rules: [{ toolName: p.toolRaw }], behavior: "allow", destination: "session" }];
  return { d: "allow", extra };
}
