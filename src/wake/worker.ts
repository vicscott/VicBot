import { LIMITS } from "../config";
import { LEASE_MS } from "../engine/execute";
import { wake } from "../engine/loop";
import { db } from "../store";
import { setKicker } from "./kick";

const WORKER = `w-${process.pid}`;
const running = new Set<string>();
let timer: Timer | null = null;
let scheduled = false;
let stopped = false;

/** Claims runnable tasks up to the concurrency limit. A task with a job, or whose cwd has one, waits. */
export function tick(): void {
  scheduled = false;
  if (stopped) return;
  const store = db();
  for (const taskId of store.pendingTasks()) {
    if (running.size >= LIMITS.concurrency) return;
    if (running.has(taskId)) continue;
    const task = store.task(taskId);
    if (!task) {
      store.finishInbox(store.claimInbox(taskId).map((e) => e.id));
      continue;
    }
    if (!store.claimJob(taskId, WORKER, LEASE_MS, task.cwd)) continue;
    const batch = store.claimInbox(taskId);
    if (!batch.length) {
      store.releaseJob(taskId);
      continue;
    }
    running.add(taskId);
    void wake(taskId, batch)
      .catch((err: Error) => {
        console.error(`task ${taskId}:`, err);
        store.event(taskId, null, { kind: "error", text: `engine error: ${err.message}` });
        store.transition(taskId, ["working", "verifying", "queued"], "failed", {}, `engine error: ${err.message}`);
      })
      .finally(() => {
        store.finishInbox(batch.map((e) => e.id));
        store.releaseJob(taskId);
        running.delete(taskId);
        kickSoon();
      });
  }
}

function kickSoon(): void {
  if (scheduled || stopped) return;
  scheduled = true;
  queueMicrotask(tick);
}

/**
 * Boot settles what the last process left behind: its jobs are gone, its running runs ended as orphans,
 * and tasks that were mid-run get a recover event so they continue from the recovery block.
 */
export function settleOrphans(): number {
  const store = db();
  store.clearJobs();
  store.requeueClaimed();
  for (const run of store.runsWhere("running")) store.putRun({ ...run, status: "ended", outcome: "orphaned", endedAt: Date.now() });
  const stuck = store.tasksIn(["working", "verifying"]);
  const boot = Date.now();
  for (const t of stuck) {
    store.transition(t.id, ["working", "verifying"], "queued", {}, "recovering after a restart");
    store.enqueue(t.id, "recover", {}, `recover:${t.id}:${boot}`);
  }
  return stuck.length;
}

export function startWorker(): void {
  stopped = false;
  setKicker(kickSoon);
  timer ??= setInterval(tick, 1000);
  kickSoon();
}

export function stopWorker(): void {
  stopped = true;
  if (timer) clearInterval(timer);
  timer = null;
}

export function busy(): number {
  return running.size;
}

/** For tests: resolves when nothing is running or pending. */
export async function idle(timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    tick();
    if (!running.size && !db().pendingTasks().length) return;
    await Bun.sleep(20);
  }
  throw new Error("worker did not go idle");
}
