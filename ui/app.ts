import { stepOf, thought, type Step } from "../src/progress";
import type { BusMessage, Card, CheckResult, Device, Effort, Note, Route, Run, Session, StoredEvent, Task, ThreadRow, VEvent } from "../src/types";

interface Detail {
  task: Task;
  runs: Run[];
  events: StoredEvent[];
  checks: CheckResult[];
  notes: Note[];
  cards: Card[];
  sessions: Session[];
  children: Task[];
  parent: Task | null;
}

interface Meta {
  you: { device: string; scope: string };
  harnesses: { id: string; available: boolean; version: string | null; problem: string | null; capabilities: { web: boolean } }[];
  mapping: Record<string, string | null>;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const els = {
  list: $<HTMLUListElement>("task-list"),
  filters: $("filters"),
  harness: $("harness-status"),
  conn: $("conn"),
  thread: $<HTMLOListElement>("thread"),
  form: $<HTMLFormElement>("composer"),
  input: $<HTMLTextAreaElement>("input"),
  target: $("target"),
  targetClear: $<HTMLButtonElement>("target-clear"),
  interruptWrap: $("interrupt-wrap"),
  interrupt: $<HTMLInputElement>("interrupt"),
  routeSeg: $("route-seg"),
  effortSeg: $("effort-seg"),
  guess: $("guess"),
  cwd: $<HTMLInputElement>("cwd"),
  detail: $("detail"),
  dDot: $("d-dot"),
  dTitle: $("d-title"),
  dMeta: $("d-meta"),
  dBanners: $("d-banners"),
  dCards: $("d-cards"),
  dClose: $<HTMLButtonElement>("d-close"),
  dMessage: $<HTMLButtonElement>("d-message"),
  dTrust: $<HTMLButtonElement>("d-trust"),
  dStop: $<HTMLButtonElement>("d-stop"),
  tabs: $("tabs"),
  pane: $("pane"),
  pair: $<HTMLDialogElement>("pair"),
  pairCode: $<HTMLInputElement>("pair-code"),
  pairName: $<HTMLInputElement>("pair-name"),
  pairError: $("pair-error"),
  pairGo: $<HTMLButtonElement>("pair-go"),
  devicesBtn: $<HTMLButtonElement>("devices-btn"),
  devices: $<HTMLDialogElement>("devices"),
  deviceList: $<HTMLUListElement>("device-list"),
  codeScope: $<HTMLSelectElement>("code-scope"),
  newCode: $<HTMLButtonElement>("new-code"),
  codeOut: $("code-out"),
  profileBtn: $<HTMLButtonElement>("profile-btn"),
  profile: $<HTMLDialogElement>("profile"),
  profileText: $<HTMLTextAreaElement>("profile-text"),
  profileSave: $<HTMLButtonElement>("profile-save"),
  profileMsg: $("profile-msg"),
};

const FINAL = ["done", "blocked", "failed", "cancelled"];
const state = {
  tasks: new Map<string, Task>(),
  cards: new Map<string, Card>(),
  threadIds: new Set<number>(),
  lastThread: 0,
  filter: "active" as "active" | "all" | "done",
  selected: null as string | null,
  detail: null as Detail | null,
  tab: "timeline",
  target: null as string | null,
  route: "" as "" | Route,
  effort: "" as "" | Effort,
  meta: null as Meta | null,
};

// ── plumbing ─────────────────────────────────────────────────────────────

const token = () => localStorage.getItem("vicbot.token");

async function api<T>(path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  const t = token();
  if (t) headers.authorization = `Bearer ${t}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(path, { method: body === undefined ? "GET" : "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (res.status === 401) {
    showPair();
    throw new Error("pair this device first");
  }
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const send = <T>(payload: Record<string, unknown>) => api<T>("/v1/events", { id: crypto.randomUUID(), ...payload });

function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls = "", text?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text !== undefined) el.textContent = text;
  return el;
}

function ago(ts: number): string {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

const clock = (ts: number) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : "–");

/** Text with `#t…` task pointers turned into links. Everything stays text nodes. */
function linked(text: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  for (const part of text.split(/(#t[0-9a-f]{10})/)) {
    if (/^#t[0-9a-f]{10}$/.test(part)) {
      const a = h("a", "ptr", part);
      a.onclick = () => select(part.slice(1));
      frag.append(a);
    } else frag.append(document.createTextNode(part));
  }
  return frag;
}

function rich(text: string, cls = "ev-text"): HTMLElement {
  const root = h("li", cls);
  text.split(/```[\w-]*\n?/).forEach((part, i) => {
    if (i % 2) return void root.append(h("pre", "", part.replace(/\n$/, "")));
    part.split(/(`[^`\n]+`)/).forEach((seg) => root.append(seg.startsWith("`") && seg.length > 2 ? h("code", "", seg.slice(1, -1)) : document.createTextNode(seg)));
  });
  return root;
}

function toast(text: string): void {
  const li = h("li", "host status");
  li.append(h("span", "error", text));
  els.thread.append(li);
  els.thread.scrollTop = els.thread.scrollHeight;
}

// ── sidebar ──────────────────────────────────────────────────────────────

function renderList(): void {
  const all = [...state.tasks.values()];
  const shown = all.filter((t) => (state.filter === "all" ? true : state.filter === "done" ? FINAL.includes(t.status) : !FINAL.includes(t.status) || Date.now() - t.updatedAt < 10 * 60_000));
  const roots = shown.filter((t) => !t.parentId || !state.tasks.has(t.parentId)).sort((a, b) => b.updatedAt - a.updatedAt);
  const items: HTMLElement[] = [];
  const add = (t: Task, depth: number) => {
    const li = h("li", `${t.id === state.selected ? "sel" : ""} ${depth ? "child" : ""}`);
    li.onclick = () => select(t.id);
    const sub = h("div", "sub");
    if (t.route) sub.append(h("span", `badge r-${t.route}`, t.route));
    sub.append(h("span", "", t.status.replace(/_/g, " ")));
    if (t.harness) sub.append(h("span", "", t.harness));
    if (t.shape !== "single") sub.append(h("span", "", t.shape));
    li.append(h("span", `dot ${t.status}`), h("span", "t", t.title), h("span", "when", ago(t.updatedAt)), sub);
    const last = !FINAL.includes(t.status) ? activity.get(t.id)?.steps.at(-1) : undefined;
    if (last) li.append(h("span", "now", last.text));
    items.push(li);
    for (const c of all.filter((x) => x.parentId === t.id).sort((a, b) => a.createdAt - b.createdAt)) if (depth < 3) add(c, depth + 1);
  };
  for (const t of roots) add(t, 0);
  if (!items.length) items.push(h("li", "sub", state.filter === "active" ? "Nothing running." : "No tasks yet."));
  els.list.replaceChildren(...items);
}

function renderHarnesses(): void {
  if (!state.meta) return;
  els.harness.replaceChildren(
    ...state.meta.harnesses.map((x) => {
      const el = h("span", `h ${x.available ? "" : "off"}`, x.id);
      const routes = Object.entries(state.meta!.mapping).filter(([, v]) => v === x.id).map(([key]) => key);
      el.title = `${x.version ?? ""}${x.problem ? ` — ${x.problem}` : ""}\nserves: ${routes.join(", ") || "fallback only"}`;
      return el;
    }),
  );
  els.devicesBtn.hidden = state.meta.you.scope !== "full";
  els.profileBtn.hidden = state.meta.you.scope !== "full";
}

// ── thread ───────────────────────────────────────────────────────────────

function cardNode(card: Card): HTMLElement {
  const box = h("div", `card ${card.status}`);
  box.dataset.card = card.id;
  box.append(h("div", "ct", card.title));
  if (card.body && card.kind !== "contradiction") box.append(h("div", "cb", card.body));
  else if (card.body) box.append(h("div", "cb", card.body.split("\n").slice(0, -1).join("\n")));
  if (card.status !== "open") {
    const a = card.answer;
    box.append(h("div", "ans", card.status === "expired" ? "No longer needed." : `Answered${a?.option ? `: ${card.options.find((o) => o.id === a.option)?.label ?? a.option}` : ""}${a?.text ? ` — “${a.text}”` : ""} (${a?.device ?? "?"})`));
    return box;
  }
  const row = h("div", "co");
  let input: HTMLInputElement | null = null;
  if (card.allowText) {
    input = h("input");
    input.placeholder = "Your answer…";
    input.onkeydown = (e) => e.key === "Enter" && (e.preventDefault(), answer(card, null, input!.value));
    row.append(input);
  }
  for (const o of card.options) {
    const b = h("button", `small ${o.irreversible ? "irr" : ""}`, o.label);
    b.onclick = () => answer(card, o.id, input?.value ?? "");
    row.append(b);
  }
  if (card.allowText && !card.options.length) {
    const b = h("button", "small primary", "Answer");
    b.onclick = () => answer(card, null, input!.value);
    row.append(b);
  }
  box.append(row);
  return box;
}

async function answer(card: Card, option: string | null, text: string): Promise<void> {
  try {
    const c = await send<Card>({ type: "answer", cardId: card.id, option, text });
    upsertCard(c);
  } catch (err) {
    toast((err as Error).message);
  }
}

function threadNode(row: ThreadRow): HTMLElement | null {
  if (row.delivery === "suppressed") return null;
  if (row.kind === "card" && row.cardId) {
    const li = h("li", "host");
    li.dataset.cardRow = row.cardId;
    const card = state.cards.get(row.cardId);
    li.append(card ? cardNode(card) : h("div", "card", row.text));
    return li;
  }
  if (row.author === "person") {
    const li = h("li", "person");
    if (row.taskId) {
      const to = h("span", "to");
      to.append(linked(`to #${row.taskId}`));
      li.append(to);
    }
    li.append(document.createTextNode(row.text));
    return li;
  }
  const kind = row.kind === "report" ? `report ${/^Done/.test(row.text) ? "done" : /^Blocked/.test(row.text) ? "blocked" : "failed"}` : row.kind;
  const li = h("li", `host ${kind}`);
  li.append(linked(row.text), h("span", "ts", clock(row.ts)));
  return li;
}

function addThread(row: ThreadRow): void {
  if (state.threadIds.has(row.id)) return;
  state.threadIds.add(row.id);
  state.lastThread = Math.max(state.lastThread, row.id);
  const node = threadNode(row);
  if (!node) return;
  const stick = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 80;
  els.thread.append(node);
  anchorActivity(row, node);
  if (stick) els.thread.scrollTop = els.thread.scrollHeight;
}

function upsertCard(card: Card): void {
  state.cards.set(card.id, card);
  for (const li of els.thread.querySelectorAll<HTMLElement>(`[data-card-row="${card.id}"]`)) li.replaceChildren(cardNode(card));
  if (state.detail && card.taskId === state.detail.task.id) {
    const i = state.detail.cards.findIndex((c) => c.id === card.id);
    if (i >= 0) state.detail.cards[i] = card;
    else state.detail.cards.unshift(card);
    renderDetailCards();
  }
}

// ── live progress ────────────────────────────────────────────────────────

interface Activity {
  taskId: string;
  el: HTMLElement;
  steps: (Step & { child: boolean })[];
  thinking: string;
  lastAt: number;
  loaded: boolean;
}

const activity = new Map<string, Activity>();
const SHOWN_STEPS = 4;

const rootId = (taskId: string) => state.tasks.get(taskId)?.rootId ?? taskId;

function dur(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function webOn(t: Task): boolean {
  return !!t.web && !!state.meta?.harnesses.find((x) => x.id === t.harness)?.capabilities?.web;
}

const PHASE: Partial<Record<Task["status"], string>> = {
  queued: "Queued",
  working: "Working",
  verifying: "Checking the result",
  waiting_input: "Waiting for you",
  waiting_approval: "Waiting for your approval",
  waiting_child: "Waiting on its parts",
  waiting_timer: "Scheduled",
  needs_route: "Waiting for a route",
};

/** Adds one event to the task's progress. Child tasks report into their root's card. */
function track(taskId: string, se: StoredEvent): void {
  const a = activity.get(rootId(taskId));
  if (!a) return;
  a.lastAt = se.ts;
  if (se.event.kind === "thinking") {
    a.thinking = thought(se.event.text);
    return;
  }
  const step = stepOf(se.event, se.runId);
  if (!step) return;
  if (se.event.kind === "tool" || se.event.kind === "run") a.thinking = "";
  const child = taskId !== a.taskId;
  const i = step.key ? a.steps.findIndex((x) => x.key === step.key) : -1;
  if (i >= 0) a.steps[i] = { ...a.steps[i]!, tone: step.tone };
  else a.steps.push({ ...step, child });
  if (a.steps.length > 200) a.steps.splice(0, a.steps.length - 200);
}

function renderActivity(a: Activity): void {
  const t = state.tasks.get(a.taskId);
  if (!t) return;
  const final = FINAL.includes(t.status);
  a.el.className = `activity ${final ? `ended ${t.status}` : "live"}`;
  const head = h("div", "a-head");
  head.append(h("span", `dot ${t.status}`));
  const who = [t.harness, t.route && `${t.route} · ${t.effort}`, webOn(t) && "web search on"].filter(Boolean).join(" · ");
  if (final) {
    const verb = t.status === "done" ? "Finished" : t.status === "cancelled" ? "Stopped" : t.status === "blocked" ? "Blocked" : "Failed";
    head.append(h("span", "a-phase", `${verb} in ${dur(t.used.minutes * 60_000 || t.updatedAt - t.createdAt)}`), h("span", "a-who", `${who} · ${t.used.toolCalls} tool calls`));
  } else {
    head.append(h("span", "a-phase", PHASE[t.status] ?? t.status.replace(/_/g, " ")), h("span", "a-who", who), h("span", "a-clock", dur(Date.now() - t.createdAt)));
  }
  head.onclick = () => select(t.id);
  const nodes: HTMLElement[] = [head];
  if (!final) {
    const list = h("ol", "a-steps");
    const hidden = a.steps.length - SHOWN_STEPS;
    if (hidden > 0) {
      const more = h("li", "a-more", `+${hidden} earlier step${hidden > 1 ? "s" : ""}`);
      more.onclick = () => select(t.id);
      list.append(more);
    }
    for (const s of a.steps.slice(-SHOWN_STEPS)) {
      const li = h("li", `a-step ${s.tone}`);
      li.append(h("span", "a-ic"), document.createTextNode(`${s.child ? "↳ " : ""}${s.text}`));
      list.append(li);
    }
    const quiet = Date.now() - a.lastAt;
    if (t.status === "working" || t.status === "verifying") {
      const now = h("li", "a-now");
      now.textContent = a.thinking ? a.thinking : quiet > 45_000 ? `Quiet for ${dur(quiet)}; the run is still alive` : a.steps.length ? "Thinking…" : "Starting up…";
      list.append(now);
    }
    if (list.childElementCount) nodes.push(list);
    const row = h("div", "a-actions");
    const open = h("button", "small ghost", "Details");
    open.onclick = () => select(t.id);
    const msg = h("button", "small ghost", "Message");
    msg.onclick = () => setTarget(t.id);
    const stop = h("button", "small ghost danger", "Stop");
    stop.onclick = () => stopTask(t);
    row.append(open, msg, stop);
    nodes.push(row);
  }
  a.el.replaceChildren(...nodes);
}

function renderActivities(): void {
  for (const a of activity.values()) renderActivity(a);
}

/** The progress card sits under the first host line about a root task. */
function anchorActivity(row: ThreadRow, node: HTMLElement): void {
  if (row.author !== "host" || !row.taskId || activity.has(row.taskId)) return;
  const t = state.tasks.get(row.taskId);
  if (!t || t.parentId) return;
  const el = h("li", "activity");
  node.after(el);
  const a: Activity = { taskId: t.id, el, steps: [], thinking: "", lastAt: t.updatedAt, loaded: false };
  activity.set(t.id, a);
  renderActivity(a);
  if (!FINAL.includes(t.status)) void loadActivity(a);
}

async function loadActivity(a: Activity): Promise<void> {
  try {
    const d = await api<Detail>(`/v1/tasks/${a.taskId}`);
    const live = a.steps;
    a.steps = [];
    for (const e of d.events) track(a.taskId, e);
    for (const s of live) if (!a.steps.some((x) => x.key && x.key === s.key)) a.steps.push(s);
    a.loaded = true;
    renderActivity(a);
  } catch {}
}

// ── composer ─────────────────────────────────────────────────────────────

function setTarget(id: string | null): void {
  state.target = id;
  const t = id ? state.tasks.get(id) : null;
  els.form.classList.toggle("to-task", !!t);
  els.target.textContent = t ? `Message to #${t.id} · ${t.title}` : "New task";
  els.targetClear.hidden = !t;
  els.interruptWrap.hidden = !t || !["working", "verifying"].includes(t.status);
  if (!t) els.interrupt.checked = false;
  els.input.placeholder = t ? "Queued for its next turn. Tick the box to stop the current run and redirect." : "Ask, delegate, or say “status”…  Enter sends · Shift+Enter for a new line";
  els.input.focus();
}

function seg(root: HTMLElement, attr: "route" | "effort", on: (v: string) => void): void {
  root.onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    for (const x of root.querySelectorAll("button")) x.classList.toggle("on", x === b);
    on(b.dataset[attr] ?? "");
  };
}

let previewTimer: Timer | undefined;
function preview(): void {
  clearTimeout(previewTimer);
  const text = els.input.value.trim();
  if (!text || state.target) return void (els.guess.textContent = "");
  previewTimer = setTimeout(async () => {
    try {
      const d = await api<{ route: Route | null; effort: Effort; shape: string; designated: string | null; confidence: number }>("/v1/events", { type: "preview", text });
      const route = state.route || d.route;
      const effort = state.effort || d.effort;
      const harness = route ? state.meta?.mapping[`${route}/${effort}`] : null;
      els.guess.textContent = route ? `→ ${route} · ${effort}${d.designated ? ` · @${d.designated}` : harness ? ` · ${harness}` : ""}${state.route ? "" : ` (${Math.round(d.confidence * 100)}%)`}` : "→ will ask you";
    } catch {}
  }, 250);
}

async function submit(): Promise<void> {
  const text = els.input.value.trim();
  if (!text) return;
  els.input.value = "";
  els.guess.textContent = "";
  try {
    if (state.target) await send({ type: "say", text, taskId: state.target, interrupt: els.interrupt.checked });
    else await send({ type: "say", text, route: state.route || undefined, effort: state.effort || undefined, cwd: els.cwd.value.trim() || undefined });
    els.interrupt.checked = false;
  } catch (err) {
    els.input.value = text;
    toast((err as Error).message);
  }
}

// ── detail ───────────────────────────────────────────────────────────────

async function select(id: string | null): Promise<void> {
  state.selected = id;
  history.replaceState(null, "", id ? `#${id}` : location.pathname);
  renderList();
  if (!id) {
    state.detail = null;
    els.detail.hidden = true;
    document.body.classList.remove("with-detail");
    return;
  }
  try {
    state.detail = await api<Detail>(`/v1/tasks/${id}`);
  } catch (err) {
    return toast((err as Error).message);
  }
  els.detail.hidden = false;
  document.body.classList.add("with-detail");
  renderDetail();
}

function renderDetail(): void {
  const d = state.detail;
  if (!d) return;
  const t = d.task;
  els.dDot.className = `dot ${t.status}`;
  els.dTitle.textContent = `#${t.id} ${t.title}`;
  const meta: (string | Node)[] = [t.status.replace(/_/g, " ")];
  if (t.route) meta.push(`${t.route} · ${t.effort} · ${t.shape}`);
  if (t.harness) meta.push(`on ${t.harness}`);
  meta.push(`trust ${t.trust}`);
  meta.push(`${t.used.toolCalls}/${t.budget.toolCalls} calls · ${t.used.minutes.toFixed(1)}/${t.budget.minutes} min`);
  if (t.inputTokens) meta.push(`${k(t.tokens)} tokens · ${pct(t.cacheRead, t.inputTokens)} cache hit`);
  if (t.cost) meta.push(`$${t.cost.toFixed(3)}`);
  meta.push(t.cwd);
  if (d.parent) {
    const a = h("a", "", `↑ #${d.parent.id}`);
    a.onclick = () => select(d.parent!.id);
    meta.push(a);
  }
  els.dMeta.replaceChildren(...meta.map((m) => (typeof m === "string" ? h("span", "", m) : m)));
  const banners: HTMLElement[] = [];
  const lost = [...d.events].reverse().find((e) => e.event.kind === "session");
  if (lost?.event.kind === "session" && lost.event.state === "lost") banners.push(h("div", "banner lost", `Session restarted: ${lost.event.note ?? "the previous session was lost"}. The task continued from its recovery block, so earlier tool output is not in context.`));
  if (t.status === "blocked" || t.status === "failed") banners.push(h("div", `banner ${t.status}`, `${t.status}: ${t.statusReason ?? ""}`));
  else if (t.statusReason && !FINAL.includes(t.status)) banners.push(h("div", "banner", t.statusReason));
  if (t.result && (t.status === "done" || t.status === "waiting_input")) banners.push(h("div", "banner result", t.result));
  els.dBanners.replaceChildren(...banners);
  els.dStop.hidden = FINAL.includes(t.status);
  els.dTrust.hidden = t.trust === "full" || FINAL.includes(t.status) && t.status !== "done";
  renderDetailCards();
  for (const b of els.tabs.querySelectorAll("button")) b.classList.toggle("on", b.dataset.tab === state.tab);
  renderPane();
}

function renderDetailCards(): void {
  const open = state.detail?.cards.filter((c) => c.status === "open") ?? [];
  els.dCards.replaceChildren(...open.map(cardNode));
}

const toolRows = new Map<string, HTMLElement>();

function eventNode(se: StoredEvent): HTMLElement | null {
  const ev: VEvent = se.event;
  switch (ev.kind) {
    case "user":
      return h("li", "ev-user", ev.text);
    case "route":
      return h("li", "ev-meta", `Routed to ${ev.route} · ${ev.effort} · ${ev.shape} → ${ev.harness} (${Math.round(ev.confidence * 100)}%: ${ev.reason})`);
    case "run":
      return h("li", "ev-run", ev.phase === "start" ? `${ev.purpose} run on ${ev.harness} · ${ev.promptKind ?? ""} · template ${ev.templateHash ?? ""}` : `${ev.purpose} run ended: ${ev.outcome ?? ""}`);
    case "text":
      return rich(ev.text.replace(/<verdict>[\s\S]*?<\/verdict>/g, "").trim() || "(verdict filed)");
    case "thinking": {
      const li = h("li", "ev-thinking");
      const det = h("details");
      det.append(h("summary", "", "thinking"), h("p", "", ev.text));
      li.append(det);
      return li;
    }
    case "tool": {
      const key = `${se.runId}:${ev.id}`;
      const existing = toolRows.get(key);
      if (ev.phase === "end" && existing) {
        existing.className = `ev-tool ${ev.ok === false ? "err" : "ok"}`;
        if (ev.error) existing.title = ev.error;
        return null;
      }
      const li = h("li", `ev-tool ${ev.phase === "end" ? (ev.ok === false ? "err" : "ok") : "pending"}`);
      li.append(h("span", "s"), h("span", "n", ev.name), h("span", "d", ev.input));
      toolRows.set(key, li);
      return li;
    }
    case "notice":
      return h("li", "ev-notice", ev.text);
    case "error":
      return h("li", "ev-error", ev.text);
    case "limit":
      return h("li", "ev-error", `Limit (${ev.reason}): ${ev.text}`);
    case "verdict": {
      const li = h("li", "ev-verdict");
      li.append(h("b", "", ev.decision), document.createTextNode(` ${ev.reason}${ev.source !== "file" ? `  · from ${ev.source}` : ""}`));
      return li;
    }
    case "check":
      return h("li", `ev-check ${ev.ok ? "ok" : "bad"}`, `${ev.ok ? "✓" : "✗"} check ${ev.checkId} (${ev.check}): ${ev.detail}`);
    case "handoff": {
      const li = h("li", "ev-meta");
      li.append(linked(`Handoff ${ev.phase}${ev.route ? ` → ${ev.route}` : ""}${ev.taskId ? ` #${ev.taskId}` : ""}: ${ev.reason}`));
      return li;
    }
    case "steer":
      return h("li", "ev-meta", `Note ${ev.phase}: ${ev.text.slice(0, 160)}`);
    case "status":
      return h("li", "ev-meta", `${ev.from.replace(/_/g, " ")} → ${ev.to.replace(/_/g, " ")}${ev.reason ? `: ${ev.reason}` : ""}`);
    case "context":
      return h("li", "ev-meta", `Context: ${ev.promptKind}, ${k(ev.chars)} chars (stable prefix ${k(ev.stableChars)})${ev.cut.length ? `, cut: ${ev.cut.join(", ")}` : ""}`);
    case "session":
      return ev.state === "lost" ? h("li", "ev-notice", `Session lost: ${ev.note ?? ""}`) : null;
    case "usage":
    case "exit":
      return null;
  }
}

function renderPane(): void {
  const d = state.detail;
  if (!d) return;
  const t = d.task;
  switch (state.tab) {
    case "timeline": {
      toolRows.clear();
      const ol = h("ol");
      ol.id = "timeline";
      for (const e of d.events) {
        const n = eventNode(e);
        if (n) ol.append(n);
      }
      els.pane.replaceChildren(ol);
      els.pane.scrollTop = els.pane.scrollHeight;
      return;
    }
    case "runs": {
      const table = h("table", "grid");
      const head = h("tr");
      for (const c of ["run", "harness", "purpose", "prompt", "template", "outcome", "calls", "tokens in", "cache hit", "time"]) head.append(h("th", "", c));
      table.append(head);
      for (const r of d.runs) {
        const tr = h("tr");
        const secs = r.endedAt ? Math.round((r.endedAt - r.startedAt) / 1000) : null;
        for (const v of [r.id, r.harness, r.purpose, r.promptKind, `${r.templateRole} v${r.templateVersion} ${r.templateHash}`, r.outcome ?? "running", String(r.toolCalls), k(r.usage.input), pct(r.usage.cacheRead, r.usage.input), secs === null ? "…" : `${secs}s`]) tr.append(h("td", "", v));
        table.append(tr);
      }
      const sessions = h("p", "hint", d.sessions.map((s) => `session ${s.id} on ${s.harness}: ${s.state}${s.lostReason ? ` (${s.lostReason})` : ""}`).join(" · ") || "No sessions yet.");
      els.pane.replaceChildren(d.runs.length ? table : h("p", "hint", "No runs yet."), sessions);
      return;
    }
    case "checks": {
      const list = h("ul");
      for (const c of t.contract.acceptance) list.append(h("li", "", `${c.id} · ${c.kind}: ${"cmd" in c ? c.cmd : "path" in c ? c.path : "rubric" in c ? c.rubric : c.ask}`));
      if (t.contract.artifacts.length) list.append(h("li", "hint", `Artifacts: ${t.contract.artifacts.join(", ")}`));
      const table = h("table", "grid");
      const head = h("tr");
      for (const c of ["check", "kind", "attempt", "result", "detail"]) head.append(h("th", "", c));
      table.append(head);
      for (const c of d.checks) {
        const tr = h("tr");
        tr.append(h("td", "", c.checkId), h("td", "", c.kind), h("td", "", String(c.attempt)), h("td", c.ok ? "ok-t" : "bad-t", c.ok ? "pass" : "fail"), h("td", "", c.detail.slice(0, 400)));
        table.append(tr);
      }
      els.pane.replaceChildren(h("p", "hint", t.contract.acceptance.length ? "Done when:" : "No checks: a pass verdict is enough."), list, d.checks.length ? table : h("p", "hint", "No results yet."));
      return;
    }
    case "contract": {
      const area = h("textarea", "json");
      area.value = JSON.stringify(t.contract, null, 2);
      area.spellcheck = false;
      const save = h("button", "small primary", "Save contract");
      const msg = h("p", "hint", `Tier: ${t.contractTier}. Checks: cmd {cmd}, test {cmd}, file {path, contains?}, judge {rubric}, human {ask}. Applies from the next run.`);
      save.onclick = async () => {
        try {
          const updated = await send<Task>({ type: "contract", taskId: t.id, contract: JSON.parse(area.value) });
          state.tasks.set(updated.id, updated);
          d.task = updated;
          msg.textContent = "Saved.";
        } catch (err) {
          msg.textContent = (err as Error).message;
          msg.className = "error";
        }
      };
      els.pane.replaceChildren(area, h("div", "row"), save, msg);
      return;
    }
    case "notes": {
      const list = h("ul");
      for (const n of [...d.notes].reverse()) {
        const li = h("li", "note-row");
        li.append(h("span", "s", `${n.status}${n.mode === "interrupt" ? " ⚡" : ""}`), h("span", "x", n.text));
        if (n.status === "queued") {
          const b = h("button", "small", "Withdraw");
          b.onclick = async () => {
            try {
              await send({ type: "withdraw", noteId: n.id });
            } catch (err) {
              toast((err as Error).message);
            }
          };
          li.append(b);
        }
        list.append(li);
      }
      els.pane.replaceChildren(h("p", "hint", "Messages to this task. Queued notes reach it on its next turn; you can withdraw them until then."), d.notes.length ? list : h("p", "hint", "No notes."));
      return;
    }
  }
}

// ── live updates ─────────────────────────────────────────────────────────

let listTimer: Timer | undefined;
const renderListSoon = () => {
  clearTimeout(listTimer);
  listTimer = setTimeout(renderList, 80);
};

function onMessage(m: BusMessage): void {
  switch (m.type) {
    case "task":
      state.tasks.set(m.task.id, m.task);
      renderListSoon();
      renderActivitySoon(m.task.rootId);
      if (state.detail?.task.id === m.task.id) {
        state.detail.task = m.task;
        renderDetail();
      }
      if (state.detail && m.task.parentId === state.detail.task.id && !state.detail.children.some((c) => c.id === m.task.id)) state.detail.children.push(m.task);
      if (state.target === m.task.id) setTarget(m.task.id);
      return;
    case "event":
      track(m.taskId, m.event);
      renderActivitySoon(rootId(m.taskId));
      if (m.event.event.kind === "tool" && m.event.event.phase === "start") renderListSoon();
      if (state.detail?.task.id !== m.taskId) return;
      state.detail.events.push(m.event);
      if (m.event.event.kind === "run" || m.event.event.kind === "check") void refreshDetail();
      if (state.tab === "timeline") {
        const ol = document.getElementById("timeline");
        const n = eventNode(m.event);
        if (ol && n) {
          const stick = els.pane.scrollHeight - els.pane.scrollTop - els.pane.clientHeight < 80;
          ol.append(n);
          if (stick) els.pane.scrollTop = els.pane.scrollHeight;
        }
      }
      return;
    case "thread":
      addThread(m.row);
      return;
    case "card":
      upsertCard(m.card);
      return;
    case "note":
      if (state.detail?.task.id === m.note.taskId) {
        const i = state.detail.notes.findIndex((n) => n.id === m.note.id);
        if (i >= 0) state.detail.notes[i] = m.note;
        else state.detail.notes.push(m.note);
        if (state.tab === "notes") renderPane();
      }
      return;
  }
}

const dirty = new Set<string>();
let activityTimer: Timer | undefined;
function renderActivitySoon(id: string): void {
  if (!activity.has(id)) return;
  dirty.add(id);
  if (activityTimer) return;
  activityTimer = setTimeout(() => {
    activityTimer = undefined;
    const stick = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 80;
    for (const x of dirty) {
      const a = activity.get(x);
      if (a) renderActivity(a);
    }
    dirty.clear();
    if (stick) els.thread.scrollTop = els.thread.scrollHeight;
  }, 120);
}

let refreshing: Timer | undefined;
function refreshDetail(): Promise<void> {
  clearTimeout(refreshing);
  return new Promise((resolve) => {
    refreshing = setTimeout(async () => {
      if (!state.selected) return resolve();
      try {
        const fresh = await api<Detail>(`/v1/tasks/${state.selected}`);
        if (state.selected === fresh.task.id) {
          state.detail = fresh;
          if (state.tab !== "timeline" && state.tab !== "contract") renderPane();
          renderDetailCards();
        }
      } catch {}
      resolve();
    }, 300);
  });
}

let source: EventSource | null = null;
function connect(): void {
  source?.close();
  const t = token();
  source = new EventSource(`/v1/stream?cursor=${state.lastThread}${t ? `&token=${encodeURIComponent(t)}` : ""}`);
  source.onopen = () => els.conn.classList.add("on");
  source.onmessage = (e) => onMessage(JSON.parse(e.data as string) as BusMessage);
  source.onerror = () => {
    els.conn.classList.remove("on");
    source?.close();
    setTimeout(connect, 2000);
  };
}

// ── pairing and devices ──────────────────────────────────────────────────

function showPair(): void {
  if (!els.pair.open) els.pair.showModal();
}

els.pairGo.onclick = async (e) => {
  e.preventDefault();
  try {
    const r = await api<{ token: string }>("/v1/devices/pair", { code: els.pairCode.value, name: els.pairName.value || navigator.platform });
    localStorage.setItem("vicbot.token", r.token);
    els.pair.close();
    await boot();
  } catch (err) {
    els.pairError.textContent = (err as Error).message;
  }
};

async function renderDevices(): Promise<void> {
  const list = await api<Device[]>("/v1/devices");
  els.deviceList.replaceChildren(
    ...list.map((d) => {
      const li = h("li");
      li.append(h("span", "", `${d.name} · ${d.scope}${d.revoked ? " · revoked" : ""} · seen ${d.lastSeen ? ago(d.lastSeen) : "never"}`));
      if (!d.revoked) {
        const b = h("button", "small danger", "Revoke");
        b.onclick = async () => {
          await api(`/v1/devices/${d.id}/revoke`, {});
          await renderDevices();
        };
        li.append(b);
      }
      return li;
    }),
  );
  if (!list.length) els.deviceList.replaceChildren(h("li", "hint", "No paired devices. This browser is trusted because it is on this machine."));
}

els.devicesBtn.onclick = async () => {
  els.codeOut.textContent = "";
  els.devices.showModal();
  await renderDevices();
};
els.newCode.onclick = async () => {
  const r = await api<{ code: string; expiresAt: number }>("/v1/devices/code", { scope: els.codeScope.value });
  els.codeOut.textContent = `${r.code} (until ${clock(r.expiresAt)})`;
};

els.profileBtn.onclick = async () => {
  els.profileMsg.textContent = "";
  els.profile.showModal();
  try {
    els.profileText.value = (await api<{ text: string }>("/v1/profile")).text;
  } catch (err) {
    els.profileMsg.textContent = (err as Error).message;
  }
};
els.profileSave.onclick = async () => {
  try {
    await send({ type: "profile", text: els.profileText.value });
    els.profileMsg.textContent = "Saved. New runs get it.";
  } catch (err) {
    els.profileMsg.textContent = (err as Error).message;
  }
};

// ── wiring ───────────────────────────────────────────────────────────────

els.form.onsubmit = (e) => {
  e.preventDefault();
  void submit();
};
els.input.onkeydown = (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void submit();
  }
  if (e.key === "Escape" && state.target) setTarget(null);
};
els.input.oninput = preview;
els.targetClear.onclick = () => setTarget(null);
seg(els.routeSeg, "route", (v) => ((state.route = v as Route | ""), preview()));
seg(els.effortSeg, "effort", (v) => ((state.effort = v as Effort | ""), preview()));
els.filters.onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b) return;
  state.filter = b.dataset.filter as typeof state.filter;
  for (const x of els.filters.querySelectorAll("button")) x.classList.toggle("on", x === b);
  renderList();
};
els.tabs.onclick = (e) => {
  const b = (e.target as HTMLElement).closest("button");
  if (!b?.dataset.tab) return;
  state.tab = b.dataset.tab;
  for (const x of els.tabs.querySelectorAll("button")) x.classList.toggle("on", x === b);
  renderPane();
};
els.dClose.onclick = () => select(null);
els.dMessage.onclick = () => state.detail && setTarget(state.detail.task.id);
async function stopTask(t: Task): Promise<void> {
  if (!confirm(`Stop #${t.id}? Its current run is killed and the task is cancelled.`)) return;
  try {
    await send({ type: "cancel", taskId: t.id });
  } catch (err) {
    toast((err as Error).message);
  }
}
els.dStop.onclick = () => state.detail && stopTask(state.detail.task);
els.dTrust.onclick = async () => {
  const t = state.detail?.task;
  if (!t) return;
  const next = t.trust === "read" ? "workspace" : "full";
  const warn = next === "full" ? "\n\nFull trust removes the sandbox: the agent can change anything your account can." : "";
  const when = ["working", "verifying"].includes(t.status) ? "\n\nThe current run keeps its trust; the new trust applies from the next run." : "";
  if (!confirm(`Raise #${t.id} from ${t.trust} to ${next} trust?${warn}${when}`)) return;
  try {
    await send({ type: "trust", taskId: t.id, trust: next });
  } catch (err) {
    toast((err as Error).message);
  }
};
setInterval(renderListSoon, 30_000);
setInterval(() => {
  for (const a of activity.values()) if (!FINAL.includes(state.tasks.get(a.taskId)?.status ?? "done")) renderActivity(a);
}, 1000);

async function boot(): Promise<void> {
  try {
    const [meta, tasks, thread, cards] = await Promise.all([api<Meta>("/v1/meta"), api<Task[]>("/v1/tasks"), api<ThreadRow[]>("/v1/thread"), api<Card[]>("/v1/cards")]);
    state.meta = meta;
    for (const t of tasks) state.tasks.set(t.id, t);
    for (const c of cards) state.cards.set(c.id, c);
    els.thread.replaceChildren();
    state.threadIds.clear();
    activity.clear();
    for (const row of thread) addThread(row);
    if (!thread.length) els.thread.append(h("li", "host status", "Hi. Tell me what to take off your plate. Quick things go to pi, exploratory work to codex, heavy work to omp. You can keep talking while they run."));
    renderHarnesses();
    renderList();
    connect();
    const linkedTask = /^#(t[0-9a-f]{10})$/.exec(location.hash)?.[1] ?? new URLSearchParams(location.search).get("task");
    if (linkedTask) await select(linkedTask);
    els.input.focus();
  } catch (err) {
    toast((err as Error).message);
  }
}

void boot();
