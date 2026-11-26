import { db, newId } from "../store";
import { FINAL, type Card, type Task, type ThreadRow } from "../types";
import { stepOf } from "../progress";
import { told } from "../wake/memory";
import { stripVerdict } from "./verdict";

/**
 * The host is the only writer of the thread. It renders templates, never calls a model for a report,
 * and never sets task state. Every summary carries a pointer to its task.
 */
function write(row: Omit<ThreadRow, "id" | "ts">): ThreadRow {
  return db().addThread(row);
}

export function personSaid(text: string, taskId: string | null): ThreadRow {
  return write({ author: "person", kind: "say", text, taskId, cardId: null, pointer: taskId ? `task:${taskId}` : null, delivery: "sent" });
}

export function hostSay(text: string, taskId: string | null = null, kind: ThreadRow["kind"] = "say"): ThreadRow {
  if (taskId) told(taskId, text);
  return write({ author: "host", kind, text, taskId, cardId: null, pointer: taskId ? `task:${taskId}` : null, delivery: "sent" });
}

/** Suppressed rows keep the record of a decision to stay quiet without notifying anyone. */
export function hostQuiet(text: string, taskId: string): ThreadRow {
  return write({ author: "host", kind: "status", text, taskId, cardId: null, pointer: `task:${taskId}`, delivery: "suppressed" });
}

export function openCard(c: Pick<Card, "taskId" | "kind" | "title" | "body" | "options" | "allowText">): Card {
  const store = db();
  const card = store.putCard({ ...c, id: newId("c_"), status: "open", answer: null, createdAt: Date.now(), answeredAt: null });
  write({ author: "host", kind: "card", text: c.title, taskId: c.taskId, cardId: card.id, pointer: c.taskId ? `task:${c.taskId}` : null, delivery: "sent" });
  return card;
}

function short(text: string | null, n = 420): string {
  const t = stripVerdict(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

/** Start quiet: only a root task's done, blocked or failed reaches the person; children stay in the record. */
export function report(task: Task): void {
  if (!FINAL.includes(task.status) || task.status === "cancelled") return;
  const line = `#${task.id} ${task.title}`;
  if (task.parentId) return void hostQuiet(`${line}: ${task.status}`, task.id);
  if (task.status === "done") hostSay(`Done: ${line}\n${short(task.result) || "(no text answer; see the task for files and checks)"}`, task.id, "report");
  else if (task.status === "blocked") hostSay(`Blocked: ${line}\n${task.statusReason ?? ""}`, task.id, "report");
  else hostSay(`Failed: ${line}\n${task.statusReason ?? ""}`, task.id, "report");
}

const STATUS_Q = /^\s*(status|what'?s (running|going on|happening)|progress|any updates?|进度|状态|怎么样了)\s*\??\s*$/i;

export function isStatusQuestion(text: string): boolean {
  return STATUS_Q.test(text);
}

/** Answered from the store, so the person gets a reply even while every worker is busy. */
export function statusSummary(): string {
  const tasks = db().tasks(100).filter((t) => !t.parentId);
  const active = tasks.filter((t) => !FINAL.includes(t.status));
  const open = db().cards({ open: true }).length;
  if (!active.length) return `Nothing is running.${open ? ` ${open} card(s) wait for you.` : ""}`;
  const lines = active.slice(0, 8).map((t) => {
    const last = lastStep(t.id);
    return `- #${t.id} ${t.title} — ${t.status.replace(/_/g, " ")}${t.harness ? ` on ${t.harness}` : ""}${t.statusReason ? ` (${t.statusReason})` : ""}${last ? `\n  last: ${last}` : ""}`;
  });
  return `${active.length} task(s) active:\n${lines.join("\n")}${open ? `\n${open} card(s) wait for you.` : ""}`;
}

function lastStep(taskId: string): string | null {
  const events = db().events(taskId);
  for (let i = events.length - 1; i >= 0 && i >= events.length - 40; i--) {
    const step = stepOf(events[i]!.event, events[i]!.runId);
    if (step) return step.text;
  }
  return null;
}
