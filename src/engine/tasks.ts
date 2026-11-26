import { BOUNDS, LIMITS, ROUTE_THRESHOLD } from "../config";
import { route as decide } from "../router";
import { db, newId } from "../store";
import { FINAL, ROUTES, TRUSTS, type Card, type Contract, type Effort, type Frame, type Mode, type Note, type Quote, type Route, type Scope, type Task, type ThreadRow, type Trust } from "../types";
import { kick } from "../wake/kick";
import { archiveNote } from "../wake/keeper";
import { validateContract, propose } from "./contract";
import { createTask, titleOf } from "./create";
import { conversationOf, decideFrame } from "./frame";
import { hostSay, isStatusQuestion, openCard, personSaid, started, statusSummary, taskStatus, withQuote } from "./host";
import { killRun, live } from "./live";
import { reworkBlock } from "./loop";
import { defaultTrust, selectHarness } from "./policy";
import { settle } from "./settle";

export interface Actor {
  device: string;
  scope: Scope;
}

export interface IntakeOptions {
  /** An explicit target: the message goes to this task, no framing. */
  taskId?: string;
  /** The conversation the person is looking at; framing leans towards it. */
  context?: string;
  /** The person chose to start a new conversation; framing is skipped. */
  fresh?: boolean;
  /** An earlier thread row being quoted, optionally just a selected part of it. */
  quote?: { rowId: number; text?: string };
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
export function submit(text: string, opts: IntakeOptions, actor: Actor, extra: { quote?: Quote | null; onCreated?: (task: Task) => void } = {}): Task {
  const d = decide(text);
  const quoted = extra.quote?.taskId ? conversationOf(extra.quote.taskId) : null;
  const route = opts.route ?? (d.confidence >= ROUTE_THRESHOLD ? d.route : null) ?? quoted?.route ?? null;
  const effort = opts.effort ?? (quoted && !d.route ? quoted.effort : d.effort);
  const web = d.web || (!d.route && !!quoted?.web);
  const ask = d.text.trim() || text;
  const task = createTask({ goal: withQuote(ask, extra.quote ?? null), title: titleOf(ask), route, effort, shape: d.shape, designated: d.designated, web, cwd: opts.cwd, mode: opts.mode });
  extra.onCreated?.(task);
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
  const h = selectHarness({ route, effort, role: d.shape === "orchestrated" ? "chair" : "worker", designated: d.designated, web });
  const inherited = !opts.route && route !== d.route && quoted;
  db().event(task.id, null, { kind: "route", route, effort, shape: d.shape, harness: h?.manifest.id ?? "none", confidence: opts.route ? 1 : inherited ? 1 : d.confidence, reason: opts.route ? "chosen by you" : inherited ? `same route as quoted #${quoted.id}` : d.reason });
  db().event(task.id, null, { kind: "user", text: task.goal, via: actor.device });
  db().enqueue(task.id, "start", { initiator: "person" }, `start:${task.id}`);
  kick();
  return task;
}

const squash = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/** Quotes come from the store, not the client: a selected part must actually appear in that message. */
export function resolveQuote(q: { rowId: number; text?: string }): Quote {
  const store = db();
  const row = store.threadRow(Number(q.rowId));
  if (!row || row.delivery === "suppressed") throw new Error("that message is not in the thread");
  const own = row.kind === "report" ? row.text.slice(row.text.indexOf("\n") + 1) : row.text;
  const part = (q.text ?? "").trim();
  if (part && squash(part)) {
    const sources = [row.text, row.taskId ? (store.task(row.taskId)?.result ?? "") : ""];
    if (!sources.some((s) => squash(s).includes(squash(part)))) throw new Error("the quoted text is not in that message");
  }
  const text = (part && squash(part) ? part : own).trim();
  return { rowId: row.id, author: row.author, taskId: row.taskId, text: text.length > LIMITS.quoteChars ? `${text.slice(0, LIMITS.quoteChars - 1)}…` : text };
}

export interface IntakeResult {
  task?: Task;
  note?: Note;
  row?: ThreadRow;
}

/**
 * Everything the person says goes through here, and it always returns at once. A status question is
 * answered from the store. Anything else is framed: it continues a conversation (a note to its task)
 * or starts a new one (a new task with its own sidebar entry).
 */
export function intake(text: string, opts: IntakeOptions, actor: Actor): IntakeResult {
  const clean = text.trim();
  if (!clean) throw new Error("empty message");
  const quote = opts.quote ? resolveQuote(opts.quote) : null;
  const body = withQuote(clean, quote);
  const mode = opts.interrupt ? "interrupt" : "push";
  if (opts.taskId) {
    const note = message(opts.taskId, body, mode, actor);
    const row = personSaid(clean, opts.taskId, quote, { decision: "continue", taskId: opts.taskId, reason: "explicit", confidence: 1, alt: null, noteId: note.id });
    return { note, row };
  }
  if (!quote && isStatusQuestion(clean)) {
    const here = opts.context && !opts.fresh ? conversationOf(opts.context) : null;
    const row = personSaid(clean, here?.id ?? null);
    hostSay(here ? taskStatus(here) : statusSummary(), here?.id ?? null);
    return { row };
  }
  const decision = decideFrame({ text: clean, quoteTask: quote?.taskId, context: opts.fresh ? undefined : opts.context, fresh: opts.fresh, configured: !!(opts.route || opts.effort) });
  ledger(decision.taskId ? db().task(decision.taskId) : null, "frame", actor, { ...decision });
  if (decision.decision === "ack") return { row: personSaid(clean, decision.taskId, quote, { ...decision, noteId: null }) };
  if (decision.decision === "continue") {
    const note = message(decision.taskId, body, mode, actor);
    return { note, row: personSaid(clean, decision.taskId, quote, { ...decision, noteId: note.id }) };
  }
  let row: ThreadRow | undefined;
  const task = submit(clean, opts, actor, { quote, onCreated: (t) => (row = personSaid(clean, t.id, quote, { ...decision, taskId: t.id, noteId: null })) });
  announce(task);
  return { task, row };
}

function announce(task: Task): void {
  const h = db().events(task.id).find((e) => e.event.kind === "route")?.event;
  started(task, h?.kind === "route" ? h.harness : "?");
}

/**
 * The person moves a message to another conversation: "new" splits it into a new task, a task id merges
 * it into that conversation. The first placement is undone where it still can be: a queued note is
 * withdrawn, and a task the message started is stopped and hidden.
 */
export function reframe(rowId: number, to: string, actor: Actor): IntakeResult {
  const store = db();
  const row = store.threadRow(rowId);
  if (!row || row.author !== "person" || !row.frame) throw new Error("that message cannot be moved");
  const from: Frame = row.frame;
  const target = to === "new" ? null : conversationOf(to);
  if (to !== "new" && (!target || target.status === "cancelled" || target.meta.mergedInto)) throw new Error(`#${to} cannot take messages`);
  if (target && target.id === from.taskId) throw new Error("the message is already there");
  if (!target && from.decision === "new") throw new Error("the message already started its own task");
  if (from.decision === "new") {
    const made = store.task(from.taskId);
    if (made && !FINAL.includes(made.status)) cancel(made.id, actor);
    const now = store.task(from.taskId);
    if (now) store.putTask({ ...now, meta: { ...now.meta, mergedInto: target!.id } });
  } else if (from.noteId && store.note(from.noteId)?.status === "queued") {
    withdraw(from.noteId, actor);
  }
  ledger(target ?? store.task(from.taskId), "reframe", actor, { rowId, from: from.taskId, to });
  const body = withQuote(row.text, row.quote ?? null);
  if (target) {
    const note = message(target.id, body, "push", actor);
    const moved = store.reframeRow(rowId, target.id, { decision: "continue", taskId: target.id, reason: "merged", confidence: 1, alt: null, noteId: note.id })!;
    return { note, row: moved };
  }
  let moved: ThreadRow | undefined;
  const task = submit(row.text, {}, actor, { quote: row.quote ?? null, onCreated: (t) => (moved = store.reframeRow(rowId, t.id, { decision: "new", taskId: t.id, reason: "split", confidence: 1, alt: null, noteId: null })!) });
  announce(task);
  return { task, row: moved };
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
