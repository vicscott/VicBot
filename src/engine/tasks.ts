import { BOUNDS, ROUTE_THRESHOLD } from "../config";
import { route as decide } from "../router";
import { db, newId } from "../store";
import { FINAL, ROUTES, TRUSTS, type Card, type Contract, type Effort, type Mode, type Note, type Route, type Scope, type Task, type Trust } from "../types";
import { kick } from "../wake/kick";
import { archiveNote } from "../wake/keeper";
import { validateContract, propose } from "./contract";
import { createTask } from "./create";
import { hostSay, isStatusQuestion, openCard, personSaid, statusSummary } from "./host";
import { killRun, live } from "./live";
import { reworkBlock } from "./loop";
import { defaultTrust, selectHarness } from "./policy";
import { settle } from "./settle";

export interface Actor {
  device: string;
  scope: Scope;
}

export interface IntakeOptions {
  taskId?: string;
  route?: Route;
  effort?: Effort;
  cwd?: string;
  mode?: Mode;
  interrupt?: boolean;
}

function need(id: string): Task {
  const task = db().task(id);
  if (!task) throw new Error(`no task ${id}`);
  return task;
}

function ledger(task: Task | null, action: string, actor: Actor, detail: Record<string, unknown> = {}): void {
  db().ledger({ taskId: task?.id ?? null, runId: null, action, initiator: "person", device: actor.device, detail });
}

/** Creates and routes a task. Below the router threshold it waits in needs_route with a card. */
export function submit(text: string, opts: IntakeOptions, actor: Actor): Task {
  const d = decide(text);
  const route = opts.route ?? (d.confidence >= ROUTE_THRESHOLD ? d.route : null);
  const effort = opts.effort ?? d.effort;
  const task = createTask({ goal: d.text.trim() || text, route, effort, shape: d.shape, designated: d.designated, web: d.web, cwd: opts.cwd, mode: opts.mode });
  ledger(task, "task.create", actor, { route, effort, shape: d.shape, confidence: d.confidence });
  if (!route) {
    openCard({
      taskId: task.id,
      kind: "route",
      title: `Where should #${task.id} go?`,
      body: `${task.title}\n\nRouter: ${d.reason}`,
      options: ROUTES.map((r) => ({ id: r, label: r })),
      allowText: false,
    });
    return task;
  }
  const h = selectHarness({ route, effort, role: d.shape === "orchestrated" ? "chair" : "worker", designated: d.designated, web: d.web });
  db().event(task.id, null, { kind: "route", route, effort, shape: d.shape, harness: h?.manifest.id ?? "none", confidence: opts.route ? 1 : d.confidence, reason: opts.route ? "chosen by you" : d.reason });
  db().event(task.id, null, { kind: "user", text: task.goal, via: actor.device });
  db().enqueue(task.id, "start", { initiator: "person" }, `start:${task.id}`);
  kick();
  return task;
}

/**
 * Everything the person says goes through here, and it always returns at once: a status question is
 * answered from the store, a message to a task becomes a note, anything else becomes a task.
 */
export function intake(text: string, opts: IntakeOptions, actor: Actor): { task?: Task; note?: Note } {
  const clean = text.trim();
  if (!clean) throw new Error("empty message");
  personSaid(clean, opts.taskId ?? null);
  if (opts.taskId) return { note: message(opts.taskId, clean, opts.interrupt ? "interrupt" : "push", actor) };
  if (isStatusQuestion(clean)) {
    hostSay(statusSummary());
    return {};
  }
  const task = submit(clean, opts, actor);
  if (task.route) {
    const h = db().events(task.id).find((e) => e.event.kind === "route")?.event;
    const via = h?.kind === "route" ? h.harness : "?";
    hostSay(`Started #${task.id}: ${task.route} · ${task.effort}${task.shape !== "single" ? ` · ${task.shape}` : ""} → ${via}. I'll report when it's done.`, task.id, "status");
  }
  return { task };
}

/**
 * A message to a task. Push (default) queues it for the next turn; interrupt stops the current run
 * and continues at once with the message. Nothing is ever rejected because a run is busy.
 */
export function message(taskId: string, text: string, mode: "push" | "interrupt", actor: Actor): Note {
  const store = db();
  const task = need(taskId);
  if (task.status === "cancelled") throw new Error(`#${taskId} was cancelled; start a new task instead`);
  const note = store.putNote({ id: newId("n_"), taskId, text: text.slice(0, 8000), mode, status: "queued", device: actor.device, createdAt: Date.now(), readAt: null });
  store.event(taskId, null, { kind: "steer", noteId: note.id, text: note.text, phase: "queued" });
  ledger(task, `note.${mode}`, actor, { noteId: note.id });
  const running = live.has(taskId);
  if (running && mode === "interrupt") {
    killRun(taskId);
    store.enqueue(taskId, "note", { noteId: note.id, initiator: "person" });
  } else if (!running && task.status !== "waiting_child" && task.status !== "verifying" && task.status !== "needs_route") {
    store.enqueue(taskId, "note", { noteId: note.id, initiator: "person" });
  }
  kick();
  return note;
}

export function withdraw(noteId: string, actor: Actor): Note {
  const store = db();
  const note = store.moveNote(noteId, "queued", "withdrawn");
  if (!note) throw new Error("that note was already delivered or withdrawn");
  store.event(note.taskId, null, { kind: "steer", noteId, text: note.text, phase: "withdrawn" });
  ledger(store.task(note.taskId), "note.withdraw", actor, { noteId });
  return note;
}

export function cancel(taskId: string, actor: Actor): Task {
  const store = db();
  const task = need(taskId);
  for (const kid of store.children(taskId)) if (!FINAL.includes(kid.status)) cancel(kid.id, actor);
  killRun(taskId);
  store.cancelTimers(taskId);
  store.expireCards(taskId);
  for (const n of store.notes(taskId, "queued")) store.moveNote(n.id, "queued", "withdrawn");
  ledger(task, "task.cancel", actor);
  return settle(taskId, "cancelled", `stopped by you (${actor.device})`) ?? need(taskId);
}

export function assignRoute(taskId: string, route: Route, actor: Actor): Task {
  const store = db();
  const task = need(taskId);
  if (!ROUTES.includes(route)) throw new Error(`unknown route ${route}`);
  if (task.status !== "needs_route") throw new Error(`#${taskId} is already routed`);
  const contract = task.contractTier === "auto" ? propose(task.goal, route, task.effort) : task.contract;
  const trust = defaultTrust(route);
  const updated = store.transition(taskId, ["needs_route"], "queued", { route, trust, role: route, visited: [route], contract }, `routed to ${route} by you`);
  if (!updated) throw new Error("someone else routed it first");
  store.expireCards(taskId, "route");
  const h = selectHarness({ route, effort: task.effort, role: "worker", designated: task.designated, web: task.web });
  store.event(taskId, null, { kind: "route", route, effort: task.effort, shape: task.shape, harness: h?.manifest.id ?? "none", confidence: 1, reason: "chosen by you" });
  store.event(taskId, null, { kind: "user", text: task.goal, via: actor.device });
  store.enqueue(taskId, "start", { initiator: "person" }, `start:${taskId}`);
  ledger(updated, "task.route", actor, { route });
  kick();
  return updated;
}

export function editContract(taskId: string, raw: unknown, actor: Actor): Task {
  const store = db();
  const task = need(taskId);
  if (FINAL.includes(task.status) && task.status !== "done") throw new Error(`#${taskId} is ${task.status}`);
  const contract: Contract = validateContract(raw);
  ledger(task, "task.contract", actor, { checks: contract.acceptance.length, artifacts: contract.artifacts.length });
  store.event(taskId, null, { kind: "notice", text: `Contract edited: ${contract.acceptance.length} check(s), ${contract.artifacts.length} artifact(s), ${contract.constraints.length} constraint(s).` });
  return store.patchTask(taskId, { contract, contractTier: "edited" })!;
}

/** Raising trust is the person's decision only. Full trust needs a full-scope device. */
export function grantTrust(taskId: string, trust: Trust, actor: Actor): Task {
  const store = db();
  const task = need(taskId);
  if (!TRUSTS.includes(trust)) throw new Error(`unknown trust ${trust}`);
  if (trust === "full" && actor.scope !== "full") throw new Error("full trust can only be granted from a full-scope device");
  const root = store.task(task.rootId) ?? task;
  if (TRUSTS.indexOf(trust) > TRUSTS.indexOf(root.ceiling)) store.patchTask(root.id, { ceiling: trust });
  ledger(task, "task.trust", actor, { from: task.trust, to: trust });
  store.event(taskId, null, { kind: "notice", text: `Trust set to ${trust} by you; it applies from the next run.` });
  return store.patchTask(taskId, { trust, ceiling: TRUSTS.indexOf(trust) > TRUSTS.indexOf(task.ceiling) ? trust : task.ceiling })!;
}

/** First answer wins, from any device. Irreversible options need a full-scope device. */
export function answerCard(cardId: string, option: string | null, text: string | null, actor: Actor): Card {
  const store = db();
  const card = store.card(cardId);
  if (!card) throw new Error("no such card");
  if (card.status !== "open") throw new Error("this card was already answered");
  const opt = option ? card.options.find((o) => o.id === option) : null;
  if (option && !opt) throw new Error(`unknown option ${option}`);
  if (!opt && !(card.allowText && text?.trim())) throw new Error("pick an option or write an answer");
  if (opt?.irreversible && actor.scope !== "full") throw new Error("this option needs a full-scope device");
  if (actor.scope === "notify" && card.kind !== "question" && card.kind !== "approval") throw new Error("a notify device can only answer questions");
  const answered = store.answerCard(cardId, { option: opt?.id ?? null, text: text?.trim() || null, device: actor.device });
  if (!answered) throw new Error("this card was already answered");
  ledger(card.taskId ? store.task(card.taskId) : null, "card.answer", actor, { cardId, kind: card.kind, option: opt?.id ?? null });
  const taskId = card.taskId;
  switch (card.kind) {
    case "route":
      if (taskId && opt) assignRoute(taskId, opt.id as Route, actor);
      break;
    case "question":
      if (taskId) {
        store.enqueue(taskId, "answer", { cardId, ask: card.body, text: text ?? opt?.label ?? "", initiator: "person" }, `answer:${cardId}`);
        kick();
      }
      break;
    case "approval":
      if (!taskId) break;
      if (opt?.id === "approve") settle(taskId, "done", `approved by you${text ? `: ${text}` : ""}`);
      else {
        const task = need(taskId);
        store.addCheck({ taskId, runId: null, checkId: "person", kind: "human", ok: false, detail: text ?? "sent back", attempt: 1 });
        store.transition(taskId, ["waiting_input"], "queued", { reworks: task.reworks + 1 }, "sent back by you");
        store.enqueue(taskId, "rework", { block: reworkBlock(task, [{ id: "person", detail: text ?? "the person sent it back" }], task.result ?? ""), initiator: "person" });
        kick();
      }
      break;
    case "budget":
      if (taskId && opt?.id === "extend") {
        const task = need(taskId);
        const root = store.task(task.rootId) ?? task;
        const add = BOUNDS[task.effort];
        store.patchTask(root.id, { budget: { toolCalls: root.budget.toolCalls + add.toolCalls, minutes: root.budget.minutes + add.minutes, cost: root.budget.cost + add.cost } });
        store.transition(taskId, ["blocked"], "queued", { loopTrips: 0 }, "budget extended by you");
        store.enqueue(taskId, "continue", { nudge: "", initiator: "person" });
        store.putNote({ id: newId("n_"), taskId, text: "Your budget was extended. Continue where you stopped.", mode: "push", status: "queued", device: actor.device, createdAt: Date.now(), readAt: null });
        kick();
      }
      break;
    case "blocked":
      if (!taskId) break;
      if (opt?.id === "close") settle(taskId, "cancelled", "closed by you");
      else {
        store.transition(taskId, ["blocked", "failed"], "queued", { loopTrips: 0 }, "retry asked by you");
        store.putNote({ id: newId("n_"), taskId, text: text?.trim() || "Try again, taking the reason you were blocked into account.", mode: "push", status: "queued", device: actor.device, createdAt: Date.now(), readAt: null });
        store.enqueue(taskId, "note", { initiator: "person" });
        kick();
      }
      break;
    case "contradiction":
      if (opt) for (const key of JSON.parse(card.body.split("\n").at(-1) ?? "[]") as string[]) if (key !== opt.id) archiveNote(key);
      break;
    case "result":
      break;
  }
  return answered;
}
