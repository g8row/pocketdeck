// Focus timer. Lives in deskd (not the tablet) so it survives hot reloads and
// can tell the Mac when time is up. Pure state machine + a tick().

export type FocusMode = "idle" | "running" | "paused" | "done";

export interface Focus {
  mode: FocusMode;
  total: number; // seconds
  remaining: number; // seconds
  endsAt: number; // epoch ms while running
  rounds: number; // completed today
  dayKey: string;
}

const day = (t: number) => new Date(t).toDateString();

export function newFocus(minutes = 25, now = Date.now()): Focus {
  return { mode: "idle", total: minutes * 60, remaining: minutes * 60, endsAt: 0, rounds: 0, dayKey: day(now) };
}

export function focusAction(f: Focus, id: string, args: any, defaultMin: number, now = Date.now()): Focus {
  const x = { ...f };
  switch (id) {
    case "focus.toggle":
      if (x.mode === "running") {
        x.remaining = Math.max(0, Math.round((x.endsAt - now) / 1000));
        x.mode = "paused";
      } else {
        if (x.mode === "done" || x.remaining <= 0) x.remaining = x.total;
        x.mode = "running";
        x.endsAt = now + x.remaining * 1000;
      }
      break;
    case "focus.start": {
      const min = Math.max(1, Math.min(180, Number(args?.min) || defaultMin));
      x.total = x.remaining = min * 60;
      x.mode = "running";
      x.endsAt = now + x.remaining * 1000;
      break;
    }
    case "focus.add":
      x.total += 300;
      if (x.mode === "running") x.endsAt += 300_000;
      else x.remaining += 300;
      if (x.mode === "done") {
        x.mode = "paused";
        x.remaining = 300;
      }
      break;
    case "focus.reset":
      return { ...newFocus(defaultMin, now), rounds: x.rounds, dayKey: x.dayKey };
  }
  return x;
}

/** Advance; returns [state, justFinished]. */
export function focusTick(f: Focus, now = Date.now()): [Focus, boolean] {
  let x = f;
  if (x.dayKey !== day(now)) x = { ...x, rounds: 0, dayKey: day(now) };
  if (x.mode !== "running") return [x, false];
  const remaining = Math.max(0, Math.ceil((x.endsAt - now) / 1000));
  if (remaining > 0) return [remaining === x.remaining ? x : { ...x, remaining }, false];
  return [{ ...x, remaining: 0, mode: "done", rounds: x.rounds + 1 }, true];
}

export function focusState(f: Focus) {
  const m = Math.floor(f.remaining / 60);
  const s = f.remaining % 60;
  return {
    mode: f.mode,
    left: `${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`,
    progress: f.total > 0 ? 1 - f.remaining / f.total : 0,
    total: Math.round(f.total / 60),
    rounds: f.rounds,
  };
}
