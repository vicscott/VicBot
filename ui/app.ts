import { stepOf, thought, type Step } from "../src/progress";
import { markdown } from "./markdown";
import type { BusMessage, Card, CheckResult, Device, Effort, FrameReason, Note, Quote, Route, Run, Session, StoredEvent, Task, ThreadRow, VEvent } from "../src/types";

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
  headTitle: $("head-title"),
  headSub: $("head-sub"),
  headDetails: $<HTMLButtonElement>("head-details"),
  quote: $("quote"),
  quoteWho: $("quote-who"),
  quoteText: $("quote-text"),
  quoteClear: $<HTMLButtonElement>("quote-clear"),
};

const FINAL = ["done", "blocked", "failed", "cancelled"];
const state = {
  tasks: new Map<string, Task>(),
  cards: new Map<string, Card>(),
  rows: new Map<number, ThreadRow>(),
  lastThread: 0,
  /** The open conversation (a root task id); null is the initial window. */
  view: null as string | null,
  /** Host messages per conversation that arrived while it was not open; "" is the initial window. */
  unread: new Map<string, number>(),
  touched: new Map<string, number>(),
  flash: null as string | null,
  quote: null as Quote | null,
  filter: "all" as "active" | "all" | "done",
  selected: null as string | null,
  detail: null as Detail | null,
  tab: "timeline",
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
  root.append(markdown(text, (id) => void select(id)));
  return root;
}

function toast(text: string): void {
  const li = h("li", "host status");
  li.append(h("span", "error", text));
  els.thread.append(li);
  els.thread.scrollTop = els.thread.scrollHeight;
}

// ── conversations ────────────────────────────────────────────────────────
// A conversation is a root task with everything said about it. The initial window holds what belongs to none.

const rootId = (taskId: string) => state.tasks.get(taskId)?.rootId ?? taskId;
const convOf = (row: ThreadRow): string | null => (row.taskId ? rootId(row.taskId) : null);
const visible = (t: Task) => !t.meta?.mergedInto;

function lastTouched(id: string): number {
  return Math.max(state.tasks.get(id)?.updatedAt ?? 0, state.touched.get(id) ?? 0);
}

function openConversation(id: string | null, opts: { flash?: boolean; keepDetail?: boolean } = {}): void {
  state.view = id;
  if (id) state.unread.delete(id);
  const q = new URLSearchParams(location.search);
  q.delete("task");
  if (id) q.set("c", id);
  else q.delete("c");
  history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
  if (!opts.keepDetail && state.detail && rootId(state.detail.task.id) !== id) void select(null);
  if (opts.flash && id) {
    state.flash = id;
    setTimeout(() => {
      if (state.flash === id) state.flash = null;
      renderList();
    }, 1600);
  }
  renderList();
  renderHead();
  renderThread();
  updateComposer();
  if (state.quote) setQuote(state.quote);
  els.input.focus();
}

// ── sidebar ──────────────────────────────────────────────────────────────

function renderList(): void {
  const all = [...state.tasks.values()].filter(visible);
  const shown = all.filter((t) => (state.filter === "all" ? true : state.filter === "done" ? FINAL.includes(t.status) : !FINAL.includes(t.status) || Date.now() - lastTouched(t.id) < 30 * 60_000 || t.id === state.view));
  const roots = shown.filter((t) => !t.parentId || !state.tasks.has(t.parentId)).sort((a, b) => lastTouched(b.id) - lastTouched(a.id));
  const fresh = h("li", `new-conv ${state.view === null ? "sel" : ""}`);
  fresh.append(h("span", "plus", "＋"), h("span", "t", "New conversation"));
  const hostUnread = state.unread.get("") ?? 0;
  if (hostUnread) fresh.append(h("span", "unread", String(hostUnread)));
  fresh.onclick = () => openConversation(null);
  const items: HTMLElement[] = [fresh];
  const add = (t: Task, depth: number) => {
    const conv = depth === 0;
    const li = h("li", `${conv && t.id === state.view ? "sel" : ""} ${depth ? "child" : ""} ${state.flash === t.id ? "flash" : ""} ${!depth && state.detail?.task.id === t.id ? "" : ""}`);
    li.onclick = () => {
      if (conv) openConversation(t.id);
      else {
        openConversation(rootId(t.id), { keepDetail: true });
        void select(t.id);
      }
    };
    const sub = h("div", "sub");
    if (t.route) sub.append(h("span", `badge r-${t.route}`, t.route));
    sub.append(h("span", "", t.status.replace(/_/g, " ")));
    if (t.harness) sub.append(h("span", "", t.harness));
    if (t.shape !== "single") sub.append(h("span", "", t.shape));
    const when = h("span", "when", ago(lastTouched(t.id)));
    const unread = conv ? (state.unread.get(t.id) ?? 0) : 0;
    li.append(h("span", `dot ${t.status}`), h("span", "t", t.title), unread ? h("span", "unread", String(unread)) : when, sub);
    const last = !FINAL.includes(t.status) ? activity.get(rootId(t.id))?.steps.at(-1) : undefined;
    if (last && conv) li.append(h("span", "now", last.text));
    items.push(li);
    for (const c of all.filter((x) => x.parentId === t.id).sort((a, b) => a.createdAt - b.createdAt)) if (depth < 3) add(c, depth + 1);
  };
  for (const t of roots) add(t, 0);
  if (items.length === 1) items.push(h("li", "sub empty", state.filter === "active" ? "Nothing running." : "No conversations yet."));
  els.list.replaceChildren(...items);
}

function renderHarnesses(): void {
  if (!state.meta) return;
  els.harness.replaceChildren(
    ...state.meta.harnesses.map((x) => {
      const el = h("span", `h ${x.available ? "" : "off"}`, x.id);
      const routes = Object.entries(state.meta!.mapping).filter(([, v]) => v === x.id).map(([key]) => key);
      el.title = `${x.version ?? ""}${x.problem ? ` — ${x.problem}` : ""}\nserves: ${routes.join(", ") || "fallback only"}${x.capabilities?.web ? "\nweb search" : ""}`;
      return el;
    }),
  );
  els.devicesBtn.hidden = state.meta.you.scope !== "full";
  els.profileBtn.hidden = state.meta.you.scope !== "full";
}

function renderHead(): void {
  const t = state.view ? state.tasks.get(state.view) : null;
  els.headTitle.textContent = t ? t.title : "New conversation";
  els.headSub.textContent = t
    ? `#${t.id} · ${t.status.replace(/_/g, " ")}${t.harness ? ` · ${t.harness}` : ""}`
    : "Talk any time. VicBot puts each message in the right conversation: a follow-up continues one, a new topic starts its own.";
  els.headDetails.hidden = !t;
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

const onTask = (id: string) => {
  if (state.tasks.has(id) && rootId(id) !== state.view) openConversation(rootId(id));
  void select(id);
};

/** The selected text inside a message, if the person selected part of it. */
function selectionIn(node: HTMLElement): string {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  return node.contains(range.commonAncestorContainer) ? sel.toString().trim() : "";
}

function quoteAction(row: ThreadRow, li: HTMLElement): HTMLElement {
  const bar = h("div", "m-actions");
  const b = h("button", "small ghost", "Quote");
  b.title = "Quote this message. Select part of it first to quote only that part.";
  b.onmousedown = (e) => e.preventDefault();
  b.onclick = (e) => {
    e.stopPropagation();
    const part = selectionIn(li);
    setQuote({ rowId: row.id, author: row.author, taskId: row.taskId, text: part || plain(row) });
    window.getSelection()?.removeAllRanges();
  };
  bar.append(b);
  return bar;
}

/** A row's text as the person reads it: a report without its "Done: #id title" line. */
function plain(row: ThreadRow): string {
  return row.kind === "report" ? row.text.slice(row.text.indexOf("\n") + 1) : row.text;
}

function quoteBlock(q: Quote): HTMLElement {
  const box = h("blockquote", "q");
  const who = q.author === "person" ? "You" : "VicBot";
  box.append(h("span", "q-who", `${who}${q.taskId ? ` · #${q.taskId}` : ""}`), h("span", "q-text", q.text));
  box.onclick = (e) => {
    e.stopPropagation();
    jumpTo(q.rowId, q.taskId);
  };
  return box;
}

function jumpTo(rowId: number, taskId: string | null): void {
  const row = state.rows.get(rowId);
  const conv = row ? convOf(row) : taskId ? rootId(taskId) : null;
  if (conv !== state.view) openConversation(conv);
  const node = els.thread.querySelector<HTMLElement>(`[data-row="${rowId}"]`);
  if (!node) return;
  node.scrollIntoView({ block: "center", behavior: "smooth" });
  node.classList.add("hl");
  setTimeout(() => node.classList.remove("hl"), 1500);
}

const FRAME_TEXT: Partial<Record<FrameReason, string>> = {
  followup: "Continued here: it reads as a follow-up to the last conversation",
  similar: "Continued here: same topic",
  quote: "Continued here: you quoted this conversation",
  mention: "Continued here: you mentioned it",
  "asked-new": "New conversation, as you asked",
  stopped: "New conversation: the one you were in was stopped",
  split: "Split into its own conversation",
  merged: "Moved here",
};

function frameChip(row: ThreadRow): HTMLElement | null {
  const f = row.frame;
  if (!f) return null;
  const alt = f.alt && state.tasks.get(f.alt);
  const text = FRAME_TEXT[f.reason] ?? (f.reason === "new" && alt ? `New conversation. Related to #${f.alt} ${alt.title}?` : null);
  if (!text) return null;
  const chip = h("div", "frame");
  chip.append(h("span", "", `↪ ${text}`));
  const move = (to: string, label: string) => {
    const b = h("button", "small ghost", label);
    b.onclick = async (e) => {
      e.stopPropagation();
      try {
        const r = await send<{ row?: ThreadRow }>({ type: "reframe", rowId: row.id, to });
        if (r.row) {
          state.rows.set(r.row.id, r.row);
          openConversation(convOf(r.row), { flash: true });
        }
      } catch (err) {
        toast((err as Error).message);
      }
    };
    chip.append(b);
  };
  if (f.decision !== "new") move("new", "Make it a new task");
  if (alt && f.alt !== f.taskId) move(f.alt!, `Move to #${f.alt}`);
  return chip;
}

function threadNode(row: ThreadRow): HTMLElement | null {
  if (row.delivery === "suppressed") return null;
  if (row.kind === "card" && row.cardId) {
    const li = h("li", "host");
    li.dataset.cardRow = row.cardId;
    li.dataset.row = String(row.id);
    const card = state.cards.get(row.cardId);
    li.append(card ? cardNode(card) : h("div", "card", row.text));
    return li;
  }
  if (row.author === "person") {
    const li = h("li", "person");
    li.dataset.row = String(row.id);
    if (row.quote) li.append(quoteBlock(row.quote));
    li.append(h("div", "p-text", row.text));
    li.append(quoteAction(row, li));
    const chip = frameChip(row);
    if (!chip) return li;
    const wrap = h("li", "person-wrap");
    wrap.dataset.row = String(row.id);
    li.removeAttribute("data-row");
    const bubble = h("div", "person");
    bubble.append(...li.childNodes);
    wrap.append(bubble, chip);
    return wrap;
  }
  const kind = row.kind === "report" ? `report ${/^Done/.test(row.text) ? "done" : /^Blocked/.test(row.text) ? "blocked" : "failed"}` : row.kind;
  const li = h("li", `host ${kind}`);
  li.dataset.row = String(row.id);
  if (row.kind !== "report") {
    const body = h("div", "h-text");
    body.append(markdown(row.text, onTask));
    li.append(body, h("span", "ts", clock(row.ts)), quoteAction(row, li));
    return li;
  }
  const nl = row.text.indexOf("\n");
  const head = h("div", "r-head");
  const first = nl < 0 ? row.text : row.text.slice(0, nl);
  const inside = !!row.taskId && convOf(row) === state.view;
  head.append(inside ? h("span", "r-state", first.split(":")[0]!) : linked(first), h("span", "ts", clock(row.ts)));
  const body = h("div", "r-body");
  const summary = nl < 0 ? "" : row.text.slice(nl + 1);
  body.append(markdown(summary, onTask));
  li.append(head, body);
  const full = row.taskId ? state.tasks.get(row.taskId)?.result : null;
  const fullText = full ? full.replace(/<verdict>[\s\S]*?<\/verdict>/g, "").trim() : "";
  const bar = quoteAction(row, li);
  if (fullText && fullText.length > summary.replace(/…$/, "").length + 20) {
    const toggle = h("button", "small ghost r-more", "Show full answer");
    let open = false;
    toggle.onclick = () => {
      open = !open;
      body.replaceChildren(markdown(open ? fullText : summary, onTask));
      toggle.textContent = open ? "Show less" : "Show full answer";
      if (!open) li.scrollIntoView({ block: "nearest" });
    };
    bar.prepend(toggle);
  }
  li.append(bar);
  return li;
}

/** Where the progress card goes: after the newest message that started a turn. */
function turnStart(rows: ThreadRow[]): ThreadRow | null {
  for (let i = rows.length - 1; i >= 0; i--) if (rows[i]!.author === "person" && rows[i]!.frame?.decision !== "ack") return rows[i]!;
  return null;
}

function viewRows(): ThreadRow[] {
  return [...state.rows.values()].filter((r) => r.delivery !== "suppressed" && convOf(r) === state.view).sort((a, b) => a.id - b.id);
}

function renderThread(): void {
  const rows = viewRows();
  const nodes: HTMLElement[] = [];
  const t = state.view ? state.tasks.get(state.view) : null;
  if (t && !rows.some((r) => r.author === "person")) {
    const li = h("li", "person");
    li.append(h("div", "p-text", t.goal));
    nodes.push(li);
  }
  const turn = turnStart(rows);
  const a = t ? ensureActivity(t) : null;
  const at = turn ? rows.findIndex((r) => r.id === turn.id) : -1;
  const next = at >= 0 ? rows[at + 1] : undefined;
  const anchor = next && next.author === "host" && next.kind === "status" && /^Started #/.test(next.text) ? next.id : turn?.id;
  for (const row of rows) {
    const n = threadNode(row);
    if (n) nodes.push(n);
    if (a && anchor !== undefined && row.id === anchor) nodes.push(a.el);
  }
  if (a && !turn) nodes.splice(Math.min(1, nodes.length), 0, a.el);
  if (!state.view && !nodes.length) nodes.push(h("li", "host status", "Hi. Tell me what to take off your plate. Quick things go to pi, exploratory work to codex, heavy work to omp. Follow-ups go back to their conversation; you can keep talking while they run."));
  els.thread.replaceChildren(...nodes);
  if (a) {
    a.turnAt = turn?.ts ?? 0;
    renderActivity(a);
  }
  els.thread.scrollTop = els.thread.scrollHeight;
}

function addThread(row: ThreadRow): void {
  const known = state.rows.has(row.id);
  state.rows.set(row.id, row);
  state.lastThread = Math.max(state.lastThread, row.id);
  const conv = convOf(row);
  if (conv) state.touched.set(conv, Math.max(state.touched.get(conv) ?? 0, row.ts));
  if (known) return renderThread();
  if (conv !== state.view) {
    if (row.author === "host" && row.delivery !== "suppressed" && (row.kind === "report" || row.kind === "card" || row.kind === "say")) state.unread.set(conv ?? "", (state.unread.get(conv ?? "") ?? 0) + 1);
    renderListSoon();
    return;
  }
  const stick = els.thread.scrollHeight - els.thread.scrollTop - els.thread.clientHeight < 120;
  if (row.author === "person" && row.frame?.decision !== "ack") return renderThread();
  if (row.author === "host" && row.kind === "status" && /^Started #/.test(row.text)) return renderThread();
  const node = threadNode(row);
  if (!node) return;
  els.thread.append(node);
  if (stick) els.thread.scrollTop = els.thread.scrollHeight;
  renderListSoon();
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
  steps: (Step & { child: boolean; ts: number })[];
  thinking: string;
  lastAt: number;
  /** When the current turn started; only its steps are shown. */
  turnAt: number;
  loaded: boolean;
}

const activity = new Map<string, Activity>();
const SHOWN_STEPS = 4;

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

function ensureActivity(t: Task): Activity {
  let a = activity.get(t.id);
  if (!a) {
    a = { taskId: t.id, el: h("li", "activity"), steps: [], thinking: "", lastAt: t.updatedAt, turnAt: 0, loaded: false };
    activity.set(t.id, a);
    void loadActivity(a);
  }
  return a;
}

/** Adds one event to its conversation's progress. Child tasks report into their root's card. */
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
  else a.steps.push({ ...step, child, ts: se.ts });
  if (a.steps.length > 300) a.steps.splice(0, a.steps.length - 300);
}

function renderActivity(a: Activity): void {
  const t = state.tasks.get(a.taskId);
  if (!t) return;
  const final = FINAL.includes(t.status);
  const steps = a.steps.filter((s) => s.ts >= a.turnAt);
  if ((final && !steps.length && a.loaded) || t.status === "needs_route" || (t.status === "waiting_input" && !steps.length)) {
    a.el.className = "activity none";
    a.el.replaceChildren();
    return;
  }
  a.el.className = `activity ${final ? `ended ${t.status}` : "live"}`;
  const head = h("div", "a-head");
  head.append(h("span", `dot ${t.status}`));
  const who = [t.harness, t.route && `${t.route} · ${t.effort}`, webOn(t) && "web search on"].filter(Boolean).join(" · ");
  const since = a.turnAt || t.createdAt;
  if (final) {
    const verb = t.status === "done" ? "Finished" : t.status === "cancelled" ? "Stopped" : t.status === "blocked" ? "Blocked" : "Failed";
    head.append(h("span", "a-phase", `${verb} in ${dur(Math.max(t.updatedAt, a.lastAt) - since)}`), h("span", "a-who", `${who} · ${steps.filter((s) => s.key).length} tool calls`));
  } else {
    head.append(h("span", "a-phase", PHASE[t.status] ?? t.status.replace(/_/g, " ")), h("span", "a-who", who), h("span", "a-clock", dur(Date.now() - since)));
  }
  head.onclick = () => select(t.id);
  const nodes: HTMLElement[] = [head];
  if (!final) {
    const list = h("ol", "a-steps");
    const hidden = steps.length - SHOWN_STEPS;
    if (hidden > 0) {
      const more = h("li", "a-more", `+${hidden} earlier step${hidden > 1 ? "s" : ""}`);
      more.onclick = () => select(t.id);
      list.append(more);
    }
    for (const s of steps.slice(-SHOWN_STEPS)) {
      const li = h("li", `a-step ${s.tone}`);
      li.append(h("span", "a-ic"), document.createTextNode(`${s.child ? "↳ " : ""}${s.text}`));
      list.append(li);
    }
    const quiet = Date.now() - a.lastAt;
    if (t.status === "working" || t.status === "verifying") {
      const now = h("li", "a-now");
      now.textContent = a.thinking ? a.thinking : quiet > 45_000 ? `Quiet for ${dur(quiet)}; the run is still alive` : steps.length ? "Thinking…" : "Starting up…";
      list.append(now);
    }
    if (list.childElementCount) nodes.push(list);
    const row = h("div", "a-actions");
    const open = h("button", "small ghost", "Details");
    open.onclick = () => select(t.id);
    const stop = h("button", "small ghost danger", "Stop");
    stop.onclick = () => stopTask(t);
    row.append(open, stop);
    nodes.push(row);
  }
  a.el.replaceChildren(...nodes);
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
    renderListSoon();
  } catch {}
}

// ── composer ─────────────────────────────────────────────────────────────

function setQuote(q: Quote | null): void {
  state.quote = q;
  els.quote.hidden = !q;
  if (q) {
    const where = q.taskId && rootId(q.taskId) !== state.view ? ` · #${rootId(q.taskId)} (your message goes to that conversation)` : "";
    els.quoteWho.textContent = `Quoting ${q.author === "person" ? "yourself" : "VicBot"}${where}`;
    els.quoteText.textContent = q.text.length > 280 ? `${q.text.slice(0, 279)}…` : q.text;
  }
  preview();
  els.input.focus();
}

function updateComposer(): void {
  const t = state.view ? state.tasks.get(state.view) : null;
  els.form.classList.toggle("to-task", !!t);
  els.target.textContent = t ? `In #${t.id} · ${t.title}` : "New conversation";
  els.targetClear.hidden = !t;
  for (const el of [els.routeSeg, els.effortSeg, els.cwd]) el.hidden = !!t;
  els.interruptWrap.hidden = !t || !["working", "verifying"].includes(t.status);
  if (!t) els.interrupt.checked = false;
  els.input.placeholder = t
    ? ["working", "verifying"].includes(t.status)
      ? "It is working; your message reaches it on its next turn. Tick the box to stop the current run and redirect."
      : "Follow up here. It continues this task with what it already knows."
    : "Ask, delegate, or say “status”…  Enter sends · Shift+Enter for a new line";
  preview();
}

function setTarget(id: string | null): void {
  openConversation(id ? rootId(id) : null, { keepDetail: true });
}

function seg(root: HTMLElement, attr: "route" | "effort", on: (v: string) => void): void {
  root.onclick = (e) => {
    const b = (e.target as HTMLElement).closest("button");
    if (!b) return;
    for (const x of root.querySelectorAll("button")) x.classList.toggle("on", x === b);
    on(b.dataset[attr] ?? "");
  };
}

interface Preview {
  route: Route | null;
  effort: Effort;
  designated: string | null;
  confidence: number;
  frame: { decision: string; taskId: string; reason: string } | null;
}

let previewTimer: Timer | undefined;
function preview(): void {
  clearTimeout(previewTimer);
  const text = els.input.value.trim();
  if (!text) return void (els.guess.textContent = "");
  previewTimer = setTimeout(async () => {
    try {
      const d = await api<Preview>("/v1/events", { type: "preview", text, context: state.view ?? undefined, route: (!state.view && state.route) || undefined, effort: (!state.view && state.effort) || undefined, quote: state.quote ? { rowId: state.quote.rowId } : undefined });
      const f = d.frame;
      if (f && f.decision !== "new") {
        if (f.taskId === state.view) return void (els.guess.textContent = f.decision === "ack" ? "→ noted, no new run" : "");
        const t = state.tasks.get(f.taskId);
        return void (els.guess.textContent = `→ continues #${f.taskId}${t ? ` ${t.title.slice(0, 40)}` : ""}`);
      }
      const route = state.route || d.route;
      const effort = state.effort || d.effort;
      const harness = route ? state.meta?.mapping[`${route}/${effort}`] : null;
      const lead = state.view ? "→ new conversation · " : "→ ";
      els.guess.textContent = route ? `${lead}${route} · ${effort}${d.designated ? ` · @${d.designated}` : harness ? ` · ${harness}` : ""}${state.route ? "" : ` (${Math.round(d.confidence * 100)}%)`}` : `${lead}will ask you`;
    } catch {}
  }, 250);
}

async function submit(): Promise<void> {
  const text = els.input.value.trim();
  if (!text) return;
  const quote = state.quote;
  els.input.value = "";
  els.guess.textContent = "";
  const q = quote ? { rowId: quote.rowId, text: quote.text } : undefined;
  try {
    const r = state.view
      ? await send<{ row?: ThreadRow }>({ type: "say", text, context: state.view, interrupt: els.interrupt.checked, quote: q })
      : await send<{ row?: ThreadRow }>({ type: "say", text, route: state.route || undefined, effort: state.effort || undefined, cwd: els.cwd.value.trim() || undefined, quote: q });
    els.interrupt.checked = false;
    setQuote(null);
    if (r.row) {
      addThread(r.row);
      const conv = convOf(r.row);
      if (conv !== state.view) openConversation(conv, { flash: true });
    }
  } catch (err) {
    els.input.value = text;
    toast((err as Error).message);
  }
}

// ── detail ───────────────────────────────────────────────────────────────

async function select(id: string | null): Promise<void> {
  state.selected = id;
  const q = new URLSearchParams(location.search);
  if (id) q.set("task", id);
  else q.delete("task");
  history.replaceState(null, "", `${location.pathname}${q.size ? `?${q}` : ""}`);
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
      if (state.view === m.task.id) {
        renderHead();
        updateComposer();
      }
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
  if (e.key === "Escape" && state.quote) setQuote(null);
  else if (e.key === "Escape" && state.view) openConversation(null);
};
els.input.oninput = preview;
els.targetClear.onclick = () => openConversation(null);
els.quoteClear.onclick = () => setQuote(null);
els.headDetails.onclick = () => state.view && select(state.view);
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
    state.rows.clear();
    activity.clear();
    for (const row of thread) {
      state.rows.set(row.id, row);
      state.lastThread = Math.max(state.lastThread, row.id);
      const conv = convOf(row);
      if (conv) state.touched.set(conv, Math.max(state.touched.get(conv) ?? 0, row.ts));
    }
    renderHarnesses();
    const params = new URLSearchParams(location.search);
    const linkedTask = /^#(t[0-9a-f]{10})$/.exec(location.hash)?.[1] ?? params.get("task");
    const conv = params.get("c") ?? (linkedTask ? rootId(linkedTask) : null);
    openConversation(conv && state.tasks.has(conv) ? conv : null);
    connect();
    if (linkedTask) await select(linkedTask);
  } catch (err) {
    toast((err as Error).message);
  }
}

void boot();
