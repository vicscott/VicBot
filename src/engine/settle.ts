import { db } from "../store";
import { FINAL, type Status, type Task } from "../types";
import { kick } from "../wake/kick";
import { appendProgress } from "../wake/memory";
import { report } from "./host";

/**
 * Moves a task to a resting status and does everything that follows from it: the host report,
 * the progress line, the parent's wake, and delivery of notes that arrived meanwhile.
 */
export function settle(taskId: string, to: Status, reason?: string, patch: Partial<Task> = {}): Task | null {
  const store = db();
  const task = store.transition(taskId, ["needs_route", "queued", "working", "waiting_approval", "waiting_input", "waiting_child", "waiting_timer", "verifying", "done", "blocked", "failed"], to, patch, reason);
  if (!task) return null;
  appendProgress(task.id, `${to}${reason ? `: ${reason}` : ""}`);
  if (FINAL.includes(to)) {
    report(task);
    if (task.parentId) store.enqueue(task.parentId, "child", { childId: task.id, status: to });
    if (to !== "cancelled" && store.notes(task.id, "queued").length) store.enqueue(task.id, "note", { reason: "notes arrived while finishing" });
    store.ledger({ taskId: task.id, runId: null, action: `task.${to}`, initiator: "engine", device: null, detail: { reason: reason ?? null } });
  }
  kick();
  return task;
}
