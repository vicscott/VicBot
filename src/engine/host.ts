import { db, newId } from "../store";
import { FINAL, type Card, type Frame, type Quote, type Task, type ThreadRow } from "../types";
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

export function personSaid(text: string, taskId: string | null, quote: Quote | null = null, frame: Frame | null = null): ThreadRow {
  return write({ author: "person", kind: "say", text, taskId, cardId: null, pointer: taskId ? `task:${taskId}` : null, delivery: "sent", quote, frame });
}

/** The text a worker sees for a message that quotes another one. */
export function withQuote(text: string, quote: Quote | null): string {
  if (!quote) return text;
  const who = quote.author === "person" ? "the person's earlier message" : "VicBot's earlier reply";
  return `> Quoting ${who}${quote.taskId ? ` in #${quote.taskId}` : ""}:\n${quote.text.split("\n").map((l) => `> ${l}`).join("\n")}\n\n${text}`;
}

export function started(task: Task, harness: string): ThreadRow | null {
  if (!task.route) return null;
  return hostSay(`Started #${task.id}: ${task.route} · ${task.effort}${task.shape !== "single" ? ` · ${task.shape}` : ""} → ${harness}. I'll report when it's done.`, task.id, "status");
}

/** One task's state, for a status question asked inside its conversation. */
export function taskStatus(task: Task): string {
  const kids = db().children(task.id);
  const last = lastStep(task.id);
  const lines = [`#${task.id} is ${task.status.replace(/_/g, " ")}${task.harness ? ` on ${task.harness}` : ""}${task.statusReason ? ` (${task.statusReason})` : ""}.`];
  if (last) lines.push(`Last step: ${last}`);
  lines.push(`Used ${task.used.toolCalls}/${task.budget.toolCalls} tool calls, ${task.used.minutes.toFixed(1)}/${task.budget.minutes} min.`);
  if (kids.length) lines.push(`Parts: ${kids.map((k) => `#${k.id} ${k.status.replace(/_/g, " ")}`).join(", ")}`);
  return lines.join("\n");
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

/** Cuts at a paragraph or line break when one is close, so markdown is not split mid-block. */
function short(text: string | null, n = 700): string {
  const t = stripVerdict(text ?? "").replace(/\n{3,}/g, "\n\n").trim();
  if (t.length <= n) return t;
  const cut = Math.max(t.lastIndexOf("\n\n", n), t.lastIndexOf("\n", n));
  return (cut > n * 0.5 ? t.slice(0, cut) : t.slice(0, n - 1)).trimEnd() + "…";
}

/** Start quiet: only a root task's done, blocked or failed reaches the person; children stay in the record. */
export function report(task: Task): void {
  if (!FINAL.includes(task.status) || task.status === "cancelled") return;
  const line = `#${task.id} ${task.title}`;
  if (task.parentId) return void hostQuiet(`${line}: ${task.status}`, task.id);
  if (task.status === "done" && task.meta.kind === "idea") {
    hostSay(`Idea: ${line}\n${short(task.result) || "(no reply)"}`, task.id, "report");
    openCard({ taskId: task.id, kind: "idea", title: "Take this idea further?", body: "Nothing heavy runs unless you pick one. The idea is kept in memory either way.", options: [{ id: "explore", label: "Explore it" }, { id: "build", label: "Build it" }, { id: "keep", label: "Just keep it" }], allowText: false });
    return;
  }
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
