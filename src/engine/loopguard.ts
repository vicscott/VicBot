import { LIMITS } from "../config";
import type { VEvent } from "../types";

export interface Trip {
  reason: string;
}

/** Structural fingerprints over a run's tool calls: the same call, the same error, a run of failures. */
export class LoopGuard {
  private calls = new Map<string, number>();
  private errors = new Map<string, number>();
  private failing = 0;
  trips = 0;

  observe(ev: VEvent): Trip | null {
    if (ev.kind !== "tool") return null;
    if (ev.phase === "start") {
      const key = `${ev.name}\u0000${ev.input}`;
      const n = (this.calls.get(key) ?? 0) + 1;
      this.calls.set(key, n);
      if (n >= LIMITS.sameCall) return this.trip(`the same call ${n}×: ${ev.name} ${ev.input.slice(0, 80)}`);
      return null;
    }
    if (ev.ok === false) {
      this.failing += 1;
      const key = (ev.error ?? "").slice(0, 200);
      const n = (this.errors.get(key) ?? 0) + 1;
      this.errors.set(key, n);
      if (key && n >= LIMITS.sameError) return this.trip(`the same error ${n}×: ${key.slice(0, 80)}`);
      if (this.failing >= LIMITS.failingSteps) return this.trip(`${this.failing} failing steps in a row`);
    } else this.failing = 0;
    return null;
  }

  private trip(reason: string): Trip {
    this.trips += 1;
    this.calls.clear();
    this.errors.clear();
    this.failing = 0;
    return { reason };
  }
}
