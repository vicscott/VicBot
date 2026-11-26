import { BOUNDS, LIMITS, ROUTE_THRESHOLD } from "../config";
import { route as decide } from "../router";
import { db, newId } from "../store";
import { FINAL, ROUTES, TRUSTS, type Card, type Contract, type Effort, type Frame, type Mode, type Note, type Quote, type Route, type Scope, type Task, type ThreadRow, type Trust } from "../types";
import { kick } from "../wake/kick";
import { archiveNote } from "../wake/keeper";
import { remember } from "../wake/memory";
import { validateContract, propose } from "./contract";
import { createTask, titleOf } from "./create";
import { conversationOf, decideFrame } from "./frame";
import { developGoal, ideaGoal, isIdea } from "./intent";
import { hostSay, isStatusQuestion, openCard, personSaid, started, statusSummary, taskStatus, withQuote } from "./host";
import { killRun, live } from "./live";
import { reworkBlock } from "./loop";
import { defaultTrust, lowerTrust, selectHarness } from "./policy";
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
  const idea = !opts.route && !opts.effort && !opts.interrupt && isIdea(clean);
  if (decision.decision === "continue" && idea && FINAL.includes(need(decision.taskId).status)) {
    const note = message(decision.taskId, body, "fold", actor);
    const row = personSaid(clean, decision.taskId, quote, { ...decision, noteId: note.id });
    openCard({ taskId: decision.taskId, kind: "idea", title: `Kept your idea in #${decision.taskId}`, body: "It goes into this conversation's next turn. Nothing runs now.", options: [{ id: "work", label: "Work on it now" }, { id: "keep", label: "Just keep it" }], allowText: false });
    return { note, row };
  }
  if (decision.decision === "continue") {
    const note = message(decision.taskId, body, mode, actor);
    return { note, row: personSaid(clean, decision.taskId, quote, { ...decision, noteId: note.id }) };
  }
  let row: ThreadRow | undefined;
  const onCreated = (t: Task) => (row = personSaid(clean, t.id, quote, { ...decision, taskId: t.id, noteId: null }));
  if (idea) return { task: submitIdea(clean, opts, actor, quote, onCreated), row };
  const task = submit(clean, opts, actor, { quote, onCreated });
  announce(task);
  return { task, row };
}

/** An idea gets a short reaction from the quick route, and is kept in memory. Nothing heavy runs. */
function submitIdea(idea: string, opts: IntakeOptions, actor: Actor, quote: Quote | null, onCreated: (t: Task) => void): Task {
  const store = db();
  const task = createTask({ goal: withQuote(ideaGoal(idea), quote), title: titleOf(idea), route: "explore", effort: "quick", web: false, cwd: opts.cwd, mode: opts.mode, meta: { kind: "idea", idea } });
  onCreated(task);
  ledger(task, "task.create", actor, { route: "explore", effort: "quick", idea: true });
  remember(task.id, { key: `idea-${task.id}`, subject: "ideas", text: idea, scope: "long" });
  const h = selectHarness({ route: "explore", effort: "quick", role: "worker" });
  store.event(task.id, null, { kind: "route", route: "explore", effort: "quick", shape: "single", harness: h?.manifest.id ?? "none", confidence: 1, reason: "an idea, not a task: a quick reaction, nothing heavy runs" });
  store.event(task.id, null, { kind: "user", text: idea, via: actor.device });
  store.enqueue(task.id, "start", { initiator: "person" }, `start:${task.id}`);
  hostSay(`Noted your idea as #${task.id}. ${h ? h.manifest.id : "A quick worker"} will react briefly; nothing heavy runs unless you ask.`, task.id, "status");
  kick();
  return task;
}

/** The person takes an idea further: the same conversation moves to a real route with a standard budget. */
export function developIdea(taskId: string, route: Route, actor: Actor): Task {
  const store = db();
  const task = need(taskId);
  if (task.meta.kind !== "idea") throw new Error(`#${taskId} is not an idea`);
  if (!FINAL.includes(task.status) || task.status === "cancelled") throw new Error(`#${taskId} is ${task.status.replace(/_/g, " ")}`);
  const effort: Effort = "standard";
  const idea = task.meta.idea ?? task.title;
  const goal = developGoal(idea, route);
  const add = BOUNDS[effort];
  const updated = store.transition(taskId, ["done", "failed", "blocked"], "queued", {
    route,
    effort,
    role: route,
    goal,
    trust: lowerTrust(task.ceiling, defaultTrust(route)),
    visited: [route],
    contract: propose(goal, route, effort),
    contractTier: "auto",
    web: decide(idea).web,
    reworks: 0,
    meta: { ...task.meta, kind: "idea-developed" },
    budget: { toolCalls: task.budget.toolCalls + add.toolCalls * 3, minutes: task.budget.minutes + add.minutes * 3, cost: task.budget.cost + add.cost * 3 },
  }, `developing the idea on ${route}`);
  if (!updated) throw new Error(`#${taskId} changed; try again`);
  const h = selectHarness({ route, effort, role: "worker", web: updated.web });
  store.event(taskId, null, { kind: "route", route, effort, shape: "single", harness: h?.manifest.id ?? "none", confidence: 1, reason: "you asked to take the idea further" });
  store.event(taskId, null, { kind: "user", text: goal, via: actor.device });
  store.enqueue(taskId, "start", { initiator: "person" }, `develop:${taskId}:${route}`);
  ledger(updated, "idea.develop", actor, { route });
  started(updated, h?.manifest.id ?? "?");
  kick();
  return updated;
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
export function message(taskId: string, text: string, mode: "push" | "interrupt" | "fold", actor: Actor): Note {
  const store = db();
  const task = need(taskId);
  if (task.status === "cancelled") throw new Error(`#${taskId} was cancelled; start a new task instead`);
  const note = store.putNote({ id: newId("n_"), taskId, text: text.slice(0, 8000), mode, status: "queued", device: actor.device, createdAt: Date.now(), readAt: null });
  store.event(taskId, null, { kind: "steer", noteId: note.id, text: note.text, phase: "queued" });
  ledger(task, `note.${mode}`, actor, { noteId: note.id });
  const running = live.has(taskId);
  if (mode === "fold") return note;
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
  if (card.kind === "idea" && opt && ROUTES.includes(opt.id as Route)) {
    const t = card.taskId ? store.task(card.taskId) : null;
    if (!t || t.meta.kind !== "idea" || !FINAL.includes(t.status) || t.status === "cancelled") throw new Error("this idea cannot be taken further now");
  }
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
    case "idea":
      if (!taskId || !opt) break;
      if (opt.id === "work") {
        store.enqueue(taskId, "note", { initiator: "person" });
        kick();
      } else if (ROUTES.includes(opt.id as Route)) developIdea(taskId, opt.id as Route, actor);
      break;
    case "result":
      break;
  }
  return answered;
}
