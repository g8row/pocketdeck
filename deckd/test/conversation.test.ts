// The CLAUDE pane's conversation layout: snapshot fields, questions, plans,
// and the decisions the tablet sends back through the permission gate.
import { beforeEach, describe, expect, test } from "bun:test";
import { __resetSessions, activity, claudeState, onHookEvent, plain } from "../providers/claude.ts";
import { allPending, decideById, findPending, holdFull, hookResponse, tabletDecision } from "../gate.ts";

const QUESTIONS = [
  {
    question: "Which layout should I build?",
    header: "Layout",
    multiSelect: false,
    options: [
      { label: "Conversation", description: "Prompt and reply in large type" },
      { label: "Inbox", description: "Sorted by what needs you" },
    ],
  },
  {
    question: "Which states first?",
    header: "Scope",
    multiSelect: true,
    options: [
      { label: "Permissions", description: "" },
      { label: "Questions", description: "" },
      { label: "Plans", description: "" },
    ],
  },
];

beforeEach(() => __resetSessions());

describe("conversation snapshot", () => {
  test("now card, steps, changed files and turn time", () => {
    const base = { session_id: "a", cwd: "/x/proj" };
    onHookEvent({ ...base, hook_event_name: "UserPromptSubmit", prompt: "fix the usage provider" }, 0);
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Read", tool_use_id: "1", tool_input: { file_path: "/x/usage.ts" } }, 1000);
    onHookEvent({ ...base, hook_event_name: "PostToolUse", tool_name: "Read", tool_use_id: "1" }, 2000);
    onHookEvent({ ...base, hook_event_name: "PreToolUse", tool_name: "Edit", tool_use_id: "2", tool_input: { file_path: "/x/usage.ts" } }, 3000);
    let s = claudeState(15_000).sessions[0]!;
    expect(s.prompt).toBe("fix the usage provider");
    expect(s.now).toEqual({ text: "Editing usage.ts", sub: "Edit · usage.ts" });
    expect(s.run).toBe("12s");
    expect(s.steps).toEqual([{ t: "Read usage.ts", fail: false }]);
    expect(s.changed).toEqual(["usage.ts"]);
    onHookEvent({ ...base, hook_event_name: "Stop" }, 60_000);
    s = claudeState(61_000).sessions[0]!;
    expect(s.now.text).toBe("Finished");
    expect(s.took).toBe("1m");
  });

  test("activity sentences", () => {
    expect(activity("Bash", { description: "run the tests" }, "")).toBe("Run the tests");
    expect(activity("Bash", { command: "ls" }, "ls")).toBe("Running a command");
    expect(activity("Grep", { pattern: "TODO" }, "")).toBe("Searching for TODO");
    expect(activity("mcp__plugin_x_srv__do_it", {}, "")).toBe("Using srv:do_it");
  });

  test("plain() strips markdown but keeps paragraphs and bullets", () => {
    expect(plain("## Done\n\n**Tests** pass in `deskd`.\n\n- one\n- [two](http://x)\n\n\n\nend")).toBe("Done\n\nTests pass in deskd.\n\n• one\n• two\n\nend");
  });

  test("AskUserQuestion shows as a question and needs you", () => {
    onHookEvent({ session_id: "q", cwd: "/x/q", hook_event_name: "PreToolUse", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }, 0);
    const s = claudeState(1).sessions[0]!;
    expect(s.state).toBe("waiting");
    expect(s.question![1]).toMatchObject({ header: "Scope", multi: true });
    expect(s.question![0]!.options[0]).toEqual({ label: "Conversation", desc: "Prompt and reply in large type" });
    onHookEvent({ session_id: "q", hook_event_name: "PostToolUse", tool_name: "AskUserQuestion" }, 2);
    expect(claudeState(3).sessions[0]!.question).toBeNull();
  });

  test("ExitPlanMode keeps the plan text", () => {
    onHookEvent({ session_id: "p", cwd: "/x/p", hook_event_name: "PermissionRequest", tool_name: "ExitPlanMode", tool_input: { plan: "# Plan\n\n1. do it" } }, 0);
    const s = claudeState(1).sessions[0]!;
    expect(s.state).toBe("waiting");
    expect(s.plan).toBe("Plan\n\n1. do it");
  });
});

describe("tablet decisions", () => {
  test("answers map option indices to labels keyed by question text", async () => {
    const done = holdFull({ session_id: "q", tool_name: "AskUserQuestion", tool_input: { questions: QUESTIONS } }, 5000, () => {});
    const p = allPending()[0]!;
    expect(claudeState(Date.now(), p, allPending()).sessions).toEqual([]); // no session yet is fine
    const { d, extra } = tabletDecision(p, { answers: [[0], [0, 2]] });
    decideById(p.id, d, extra);
    const r = await done;
    const out = JSON.parse(hookResponse(r.d, r.extra)).hookSpecificOutput.decision;
    expect(out.behavior).toBe("allow");
    expect(out.updatedInput.questions).toEqual(QUESTIONS);
    expect(out.updatedInput.answers).toEqual({ "Which layout should I build?": "Conversation", "Which states first?": "Permissions, Plans" });
  });

  test("plan approve echoes input and can switch to acceptEdits; keep planning denies", async () => {
    const input = { plan: "do it", planFilePath: "/tmp/p.md" };
    const a = holdFull({ session_id: "p", tool_name: "ExitPlanMode", tool_input: input }, 5000, () => {});
    let p = findPending(allPending()[0]!.id)!;
    let r = tabletDecision(p, { allow: true, mode: "acceptEdits" });
    decideById(p.id, r.d, r.extra);
    let out = JSON.parse(hookResponse((await a).d, (await a).extra)).hookSpecificOutput.decision;
    expect(out).toEqual({ behavior: "allow", updatedInput: input, updatedPermissions: [{ type: "setMode", mode: "acceptEdits", destination: "session" }] });

    const b = holdFull({ session_id: "p", tool_name: "ExitPlanMode", tool_input: input }, 5000, () => {});
    p = allPending()[0]!;
    r = tabletDecision(p, { allow: false });
    decideById(p.id, r.d, r.extra);
    out = JSON.parse(hookResponse((await b).d, (await b).extra)).hookSpecificOutput.decision;
    expect(out.behavior).toBe("deny");
    expect(out.message).toContain("keep planning");
  });

  test("allow for this session adds a tool rule; per-session held card", async () => {
    onHookEvent({ session_id: "b", cwd: "/x/b", hook_event_name: "UserPromptSubmit", prompt: "go" }, Date.now());
    const c = holdFull({ session_id: "b", tool_name: "Bash", tool_input: { command: "rm -rf build/", description: "Clean the build dir" } }, 5000, () => {});
    const p = allPending()[0]!;
    const s = claudeState(Date.now(), p, allPending()).sessions[0]!;
    expect(s.held).toMatchObject({ kind: "permission", command: "rm -rf build/", why: "Clean the build dir" });
    const r = tabletDecision(p, { allow: true, always: true });
    decideById(p.id, r.d, r.extra);
    const out = JSON.parse(hookResponse((await c).d, (await c).extra)).hookSpecificOutput.decision;
    expect(out.updatedPermissions).toEqual([{ type: "addRules", rules: [{ toolName: "Bash" }], behavior: "allow", destination: "session" }]);
    expect(out.updatedInput).toBeUndefined();
  });
});
