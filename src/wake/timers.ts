import { TIMERS } from "../config";
import { db } from "../store";
import { kick } from "./kick";
import { runKeeper } from "./keeper";

let timer: Timer | null = null;

/** Timers only enqueue events; nothing runs inside the tick except the mechanical keeper. */
export function timerTick(now = Date.now()): number {
  const store = db();
  let fired = 0;
  for (const t of store.dueTimers(now)) {
    if (!store.fireTimer(t)) continue;
    fired += 1;
    if (t.payload.job === "keeper") {
      try {
        runKeeper();
      } catch (err) {
        console.error("keeper:", err);
      }
    } else if (t.taskId) {
      store.transition(t.taskId, ["waiting_timer", "done"], "queued", {}, "follow-up timer fired");
      store.enqueue(t.taskId, "timer", t.payload, `timer:${t.id}:${t.dueAt}`);
    }
  }
  if (fired) kick();
  return fired;
}

export function startTimers(): void {
  const store = db();
  if (!store.timers().some((t) => t.payload.job === "keeper")) {
    store.addTimer({ taskId: null, kind: "schedule", dueAt: Date.now() + 60_000, everyMinutes: TIMERS.keeperEveryMinutes, payload: { job: "keeper" } });
  }
  timer ??= setInterval(() => timerTick(), TIMERS.tickMs);
}

export function stopTimers(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
