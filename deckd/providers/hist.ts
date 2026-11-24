// Rolling history for the BOARD sparklines: one sample every 2 s, kept at three
// resolutions of 30 points each.
//
//   1m   the last 30 raw samples (2 s apart)
//   10m  30 means of 10 raw samples (20 s each)
//   1h   30 means of 60 raw samples (2 min each)
//
// The coarse windows end with the bucket still being filled (its running mean),
// so the line moves every push instead of jumping every 20 s / 2 min. Arrays are
// shorter than 30 until enough has been seen; the tablet pads them.

export const HIST_LEN = 30;

class Window {
  done: number[] = [];
  private sum = 0;
  private n = 0;
  constructor(readonly per: number) {}

  push(v: number) {
    this.sum += v;
    this.n++;
    if (this.n < this.per) return;
    this.done.push(this.sum / this.n);
    if (this.done.length > HIST_LEN) this.done.shift();
    this.sum = 0;
    this.n = 0;
  }

  values(): number[] {
    const out = this.n > 0 ? [...this.done, this.sum / this.n] : [...this.done];
    return out.slice(-HIST_LEN).map((v) => Math.round(v));
  }
}

export class History {
  private w = { "1m": new Window(1), "10m": new Window(10), "1h": new Window(60) };

  push(v: number): void {
    if (!Number.isFinite(v)) return;
    for (const w of Object.values(this.w)) w.push(v);
  }

  state(): { "1m": number[]; "10m": number[]; "1h": number[] } {
    return { "1m": this.w["1m"].values(), "10m": this.w["10m"].values(), "1h": this.w["1h"].values() };
  }
}
