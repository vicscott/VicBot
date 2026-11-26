import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { bus } from "./bus";
import { DB_PATH } from "./config";
import type {
  Card,
  CheckResult,
  Device,
  InboxEvent,
  InboxKind,
  LedgerRow,
  Note,
  Run,
  Session,
  Status,
  StoredEvent,
  Task,
  TemplateRow,
  ThreadRow,
  TimerRow,
  VEvent,
} from "./types";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, root_id TEXT NOT NULL, parent_id TEXT, updated_at INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS tasks_parent ON tasks(parent_id);
CREATE TABLE IF NOT EXISTS runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS runs_task ON runs(task_id);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, harness TEXT NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS sessions_task ON sessions(task_id, harness);
CREATE TABLE IF NOT EXISTS jobs (task_id TEXT PRIMARY KEY, worker TEXT NOT NULL, lease_until INTEGER NOT NULL, cwd TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS inbox (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, dedupe TEXT, status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL);
CREATE UNIQUE INDEX IF NOT EXISTS inbox_dedupe ON inbox(dedupe) WHERE dedupe IS NOT NULL;
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(status, task_id);
CREATE TABLE IF NOT EXISTS timers (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT, kind TEXT NOT NULL, due_at INTEGER NOT NULL, every_minutes INTEGER, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'armed');
CREATE TABLE IF NOT EXISTS thread (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, author TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, task_id TEXT, card_id TEXT, pointer TEXT, delivery TEXT NOT NULL, quote TEXT, frame TEXT);
CREATE TABLE IF NOT EXISTS cards (id TEXT PRIMARY KEY, task_id TEXT, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT, ts INTEGER NOT NULL, data TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS events_task ON events(task_id, seq);
CREATE TABLE IF NOT EXISTS ledger (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, task_id TEXT, run_id TEXT, action TEXT NOT NULL, initiator TEXT NOT NULL, device TEXT, detail TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS checks (id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL, run_id TEXT, check_id TEXT NOT NULL, kind TEXT NOT NULL, ok INTEGER NOT NULL, detail TEXT NOT NULL, attempt INTEGER NOT NULL, ts INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, token_hash TEXT NOT NULL UNIQUE, data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pair_codes (code_hash TEXT PRIMARY KEY, scope TEXT NOT NULL, expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS idempotency (id TEXT PRIMARY KEY, ts INTEGER NOT NULL, response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS templates (role TEXT NOT NULL, version INTEGER NOT NULL, status TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY (role, version));
`;

export function newId(prefix = ""): string {
  return prefix + crypto.randomUUID().replace(/-/g, "").slice(0, 10);
}

type Row = Record<string, unknown>;
const parse = <T>(row: Row | null | undefined): T | null => (row ? (JSON.parse(row.data as string) as T) : null);

function toThread(r: Row): ThreadRow {
  return {
    id: r.id as number,
    ts: r.ts as number,
    author: r.author as ThreadRow["author"],
    kind: r.kind as ThreadRow["kind"],
    text: r.text as string,
    taskId: (r.task_id as string | null) ?? null,
    cardId: (r.card_id as string | null) ?? null,
    pointer: (r.pointer as string | null) ?? null,
    delivery: r.delivery as ThreadRow["delivery"],
    quote: r.quote ? (JSON.parse(r.quote as string) as ThreadRow["quote"]) : null,
    frame: r.frame ? (JSON.parse(r.frame as string) as ThreadRow["frame"]) : null,
  };
}

export class Store {
  readonly db: Database;

  constructor(path = DB_PATH) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true, strict: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Additive migrations for databases created by earlier versions. */
  private migrate(): void {
    const cols = new Set((this.db.query("PRAGMA table_info(thread)").all() as Row[]).map((c) => c.name as string));
    for (const col of ["quote", "frame"]) if (!cols.has(col)) this.db.exec(`ALTER TABLE thread ADD COLUMN ${col} TEXT`);
    if (!cols.has("frame")) this.attachOrphans();
  }

  /** Before conversations, a message that started a task was stored without its task. Attach it once. */
  private attachOrphans(): void {
    const orphans = this.db.query("SELECT id, text FROM thread WHERE author = 'person' AND task_id IS NULL").all() as Row[];
    for (const o of orphans) {
      const next = this.db.query("SELECT task_id FROM thread WHERE id > ? AND id <= ? AND task_id IS NOT NULL ORDER BY id LIMIT 1").get(o.id as number, (o.id as number) + 3) as Row | null;
      const task = next ? this.task(next.task_id as string) : null;
      const text = (o.text as string).trim();
      if (task && !task.parentId && (task.goal === text || text.endsWith(task.goal))) this.db.query("UPDATE thread SET task_id = ?, pointer = ? WHERE id = ?").run(task.id, `task:${task.id}`, o.id as number);
    }
  }

  tx<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── tasks ──────────────────────────────────────────────────────────────

  putTask(task: Task): Task {
    task.updatedAt = Date.now();
    this.db
      .query("INSERT INTO tasks (id, status, root_id, parent_id, updated_at, data) VALUES ($id, $status, $root, $parent, $ts, $data) ON CONFLICT(id) DO UPDATE SET status = $status, updated_at = $ts, data = $data")
      .run({ id: task.id, status: task.status, root: task.rootId, parent: task.parentId, ts: task.updatedAt, data: JSON.stringify(task) });
    bus.emit({ type: "task", task });
    return task;
  }

  task(id: string): Task | null {
    return parse<Task>(this.db.query("SELECT data FROM tasks WHERE id = ?").get(id) as Row | null);
  }

  tasks(limit = 300): Task[] {
    return (this.db.query("SELECT data FROM tasks ORDER BY updated_at DESC LIMIT ?").all(limit) as Row[]).map((r) => parse<Task>(r)!);
  }

  children(parentId: string): Task[] {
    return (this.db.query("SELECT data FROM tasks WHERE parent_id = ? ORDER BY rowid").all(parentId) as Row[]).map((r) => parse<Task>(r)!);
  }

  tasksIn(statuses: Status[]): Task[] {
    const marks = statuses.map(() => "?").join(",");
    return (this.db.query(`SELECT data FROM tasks WHERE status IN (${marks})`).all(...statuses) as Row[]).map((r) => parse<Task>(r)!);
  }

  /**
   * Compare-and-set: the patch applies only if the task is in one of `from`.
   * Returns the updated task, or null when another writer won.
   */
  transition(id: string, from: Status[] | "any", to: Status, patch: Partial<Task> = {}, reason?: string): Task | null {
    const result = this.tx(() => {
      const task = this.task(id);
      if (!task || (from !== "any" && !from.includes(task.status))) return null;
      const prev = task.status;
      Object.assign(task, patch, { status: to, statusReason: reason ?? patch.statusReason ?? (prev === to ? task.statusReason : null) });
      this.putTask(task);
      return { task, prev };
    });
    if (!result) return null;
    if (result.prev !== to) this.event(id, null, { kind: "status", from: result.prev, to, reason });
    return result.task;
  }

  patchTask(id: string, patch: Partial<Task>): Task | null {
    return this.tx(() => {
      const task = this.task(id);
      if (!task) return null;
      Object.assign(task, patch);
      return this.putTask(task);
    });
  }

  // ── runs and sessions ──────────────────────────────────────────────────

  putRun(run: Run): Run {
    this.db
      .query("INSERT INTO runs (id, task_id, status, data) VALUES ($id, $task, $status, $data) ON CONFLICT(id) DO UPDATE SET status = $status, data = $data")
      .run({ id: run.id, task: run.taskId, status: run.status, data: JSON.stringify(run) });
    return run;
  }

  run(id: string): Run | null {
    return parse<Run>(this.db.query("SELECT data FROM runs WHERE id = ?").get(id) as Row | null);
  }

  runs(taskId: string): Run[] {
    return (this.db.query("SELECT data FROM runs WHERE task_id = ? ORDER BY rowid").all(taskId) as Row[]).map((r) => parse<Run>(r)!);
  }

  runsWhere(status: Run["status"]): Run[] {
    return (this.db.query("SELECT data FROM runs WHERE status = ?").all(status) as Row[]).map((r) => parse<Run>(r)!);
  }

  putSession(session: Session): Session {
    this.db
      .query("INSERT INTO sessions (id, task_id, harness, data) VALUES ($id, $task, $harness, $data) ON CONFLICT(id) DO UPDATE SET data = $data")
      .run({ id: session.id, task: session.taskId, harness: session.harness, data: JSON.stringify(session) });
    return session;
  }

  session(taskId: string, harness: string): Session | null {
    return parse<Session>(this.db.query("SELECT data FROM sessions WHERE task_id = ? AND harness = ? ORDER BY rowid DESC LIMIT 1").get(taskId, harness) as Row | null);
  }

  sessions(taskId: string): Session[] {
    return (this.db.query("SELECT data FROM sessions WHERE task_id = ? ORDER BY rowid").all(taskId) as Row[]).map((r) => parse<Session>(r)!);
  }

  // ── jobs: one active job per task, claimed by compare-and-set ──────────

  claimJob(taskId: string, worker: string, leaseMs: number, cwd: string): boolean {
    return this.tx(() => {
      const now = Date.now();
      this.db.query("DELETE FROM jobs WHERE lease_until < ?").run(now);
      const busy = this.db.query("SELECT 1 FROM jobs WHERE task_id = ? OR cwd = ?").get(taskId, cwd);
      if (busy) return false;
      this.db.query("INSERT INTO jobs (task_id, worker, lease_until, cwd) VALUES (?, ?, ?, ?)").run(taskId, worker, now + leaseMs, cwd);
      return true;
    });
  }

  renewJob(taskId: string, leaseMs: number): void {
    this.db.query("UPDATE jobs SET lease_until = ? WHERE task_id = ?").run(Date.now() + leaseMs, taskId);
  }

  releaseJob(taskId: string): void {
    this.db.query("DELETE FROM jobs WHERE task_id = ?").run(taskId);
  }

  activeJobs(): string[] {
    return (this.db.query("SELECT task_id FROM jobs WHERE lease_until >= ?").all(Date.now()) as Row[]).map((r) => r.task_id as string);
  }

  clearJobs(): void {
    this.db.exec("DELETE FROM jobs");
  }

  // ── inbox ──────────────────────────────────────────────────────────────

  /** Returns the new id, or null when the dedupe key was already seen. */
  enqueue(taskId: string, kind: InboxKind, payload: Record<string, unknown> = {}, dedupe?: string): number | null {
    const res = this.db
      .query("INSERT OR IGNORE INTO inbox (task_id, kind, payload, dedupe, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(taskId, kind, JSON.stringify(payload), dedupe ?? null, Date.now());
    return res.changes ? Number(res.lastInsertRowid) : null;
  }

  pendingTasks(): string[] {
    return (this.db.query("SELECT task_id, MIN(id) AS first FROM inbox WHERE status = 'pending' GROUP BY task_id ORDER BY first").all() as Row[]).map((r) => r.task_id as string);
  }

  /** Claims every pending event for a task as one batch. */
  claimInbox(taskId: string): InboxEvent[] {
    return this.tx(() => {
      const rows = this.db.query("SELECT * FROM inbox WHERE task_id = ? AND status = 'pending' ORDER BY id").all(taskId) as Row[];
      this.db.query("UPDATE inbox SET status = 'claimed' WHERE task_id = ? AND status = 'pending'").run(taskId);
      return rows.map(toInbox);
    });
  }

  finishInbox(ids: number[]): void {
    for (const id of ids) this.db.query("UPDATE inbox SET status = 'done' WHERE id = ?").run(id);
  }

  requeueClaimed(): number {
    return this.db.query("UPDATE inbox SET status = 'pending' WHERE status = 'claimed'").run().changes;
  }

  inbox(taskId: string): InboxEvent[] {
    return (this.db.query("SELECT * FROM inbox WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map(toInbox);
  }

  // ── timers ─────────────────────────────────────────────────────────────

  addTimer(t: Omit<TimerRow, "id" | "status">): number {
    const res = this.db
      .query("INSERT INTO timers (task_id, kind, due_at, every_minutes, payload) VALUES (?, ?, ?, ?, ?)")
      .run(t.taskId, t.kind, t.dueAt, t.everyMinutes, JSON.stringify(t.payload));
    return Number(res.lastInsertRowid);
  }

  dueTimers(now = Date.now()): TimerRow[] {
    return (this.db.query("SELECT * FROM timers WHERE status = 'armed' AND due_at <= ? ORDER BY due_at").all(now) as Row[]).map(toTimer);
  }

  timers(): TimerRow[] {
    return (this.db.query("SELECT * FROM timers WHERE status = 'armed' ORDER BY due_at").all() as Row[]).map(toTimer);
  }

  /** Fires a timer once: compare-and-set armed → fired, or re-arms a schedule. */
  fireTimer(t: TimerRow): boolean {
    if (t.everyMinutes) {
      return this.db.query("UPDATE timers SET due_at = ? WHERE id = ? AND due_at = ? AND status = 'armed'").run(Date.now() + t.everyMinutes * 60_000, t.id, t.dueAt).changes === 1;
    }
    return this.db.query("UPDATE timers SET status = 'fired' WHERE id = ? AND status = 'armed'").run(t.id).changes === 1;
  }

  cancelTimers(taskId: string): void {
    this.db.query("UPDATE timers SET status = 'cancelled' WHERE task_id = ? AND status = 'armed'").run(taskId);
  }

  // ── thread (the host's outbox) ─────────────────────────────────────────

  addThread(row: Omit<ThreadRow, "id" | "ts">): ThreadRow {
    const ts = Date.now();
    const res = this.db
      .query("INSERT INTO thread (ts, author, kind, text, task_id, card_id, pointer, delivery, quote, frame) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(ts, row.author, row.kind, row.text, row.taskId, row.cardId, row.pointer, row.delivery, row.quote ? JSON.stringify(row.quote) : null, row.frame ? JSON.stringify(row.frame) : null);
    const full: ThreadRow = { ...row, quote: row.quote ?? null, frame: row.frame ?? null, id: Number(res.lastInsertRowid), ts };
    bus.emit({ type: "thread", row: full });
    return full;
  }

  /** Moves a person's message to another conversation (the person corrected the framing). */
  reframeRow(id: number, taskId: string, frame: ThreadRow["frame"]): ThreadRow | null {
    this.db.query("UPDATE thread SET task_id = ?, pointer = ?, frame = ? WHERE id = ?").run(taskId, `task:${taskId}`, frame ? JSON.stringify(frame) : null, id);
    const row = this.threadRow(id);
    if (row) bus.emit({ type: "thread", row });
    return row;
  }

  threadRow(id: number): ThreadRow | null {
    const r = this.db.query("SELECT * FROM thread WHERE id = ?").get(id) as Row | null;
    return r ? toThread(r) : null;
  }

  /** The newest rows about any of these tasks, newest last. */
  threadFor(taskIds: string[], limit = 50): ThreadRow[] {
    if (!taskIds.length) return [];
    const marks = taskIds.map(() => "?").join(", ");
    return (this.db.query(`SELECT * FROM thread WHERE task_id IN (${marks}) ORDER BY id DESC LIMIT ?`).all(...taskIds, limit) as Row[]).reverse().map(toThread);
  }

  thread(after = 0, limit = 200): ThreadRow[] {
    const rows = this.db.query("SELECT * FROM thread WHERE id > ? ORDER BY id DESC LIMIT ?").all(after, limit) as Row[];
    return rows.reverse().map(toThread);
  }

  // ── cards: first answer wins ───────────────────────────────────────────

  putCard(card: Card): Card {
    this.db
      .query("INSERT INTO cards (id, task_id, status, data) VALUES ($id, $task, $status, $data) ON CONFLICT(id) DO UPDATE SET status = $status, data = $data")
      .run({ id: card.id, task: card.taskId, status: card.status, data: JSON.stringify(card) });
    bus.emit({ type: "card", card });
    return card;
  }

  card(id: string): Card | null {
    return parse<Card>(this.db.query("SELECT data FROM cards WHERE id = ?").get(id) as Row | null);
  }

  cards(opts: { taskId?: string; open?: boolean } = {}): Card[] {
    const where: string[] = [];
    const args: string[] = [];
    if (opts.taskId) (where.push("task_id = ?"), args.push(opts.taskId));
    if (opts.open) where.push("status = 'open'");
    const sql = `SELECT data FROM cards ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY rowid DESC LIMIT 200`;
    return (this.db.query(sql).all(...args) as Row[]).map((r) => parse<Card>(r)!);
  }

  answerCard(id: string, answer: NonNullable<Card["answer"]>): Card | null {
    return this.tx(() => {
      const card = this.card(id);
      if (!card || card.status !== "open") return null;
      card.status = "answered";
      card.answer = answer;
      card.answeredAt = Date.now();
      return this.putCard(card);
    });
  }

  expireCards(taskId: string, kind?: Card["kind"]): void {
    for (const card of this.cards({ taskId, open: true })) {
      if (kind && card.kind !== kind) continue;
      card.status = "expired";
      this.putCard(card);
    }
  }

  // ── notes: messages queued to a running task ───────────────────────────

  putNote(note: Note): Note {
    this.db
      .query("INSERT INTO notes (id, task_id, status, data) VALUES ($id, $task, $status, $data) ON CONFLICT(id) DO UPDATE SET status = $status, data = $data")
      .run({ id: note.id, task: note.taskId, status: note.status, data: JSON.stringify(note) });
    bus.emit({ type: "note", note });
    return note;
  }

  note(id: string): Note | null {
    return parse<Note>(this.db.query("SELECT data FROM notes WHERE id = ?").get(id) as Row | null);
  }

  notes(taskId: string, status?: Note["status"]): Note[] {
    const rows = status
      ? this.db.query("SELECT data FROM notes WHERE task_id = ? AND status = ? ORDER BY rowid").all(taskId, status)
      : this.db.query("SELECT data FROM notes WHERE task_id = ? ORDER BY rowid").all(taskId);
    return (rows as Row[]).map((r) => parse<Note>(r)!);
  }

  /** Compare-and-set on a note's status, so a withdraw and a delivery cannot both win. */
  moveNote(id: string, from: Note["status"], to: Note["status"]): Note | null {
    return this.tx(() => {
      const note = this.note(id);
      if (!note || note.status !== from) return null;
      note.status = to;
      if (to === "read") note.readAt = Date.now();
      return this.putNote(note);
    });
  }

  // ── transcript, ledger, checks ─────────────────────────────────────────

  event(taskId: string, runId: string | null, event: VEvent): StoredEvent {
    const ts = Date.now();
    const res = this.db.query("INSERT INTO events (task_id, run_id, ts, data) VALUES (?, ?, ?, ?)").run(taskId, runId, ts, JSON.stringify(event));
    const stored: StoredEvent = { seq: Number(res.lastInsertRowid), taskId, runId, ts, event };
    bus.emit({ type: "event", taskId, event: stored });
    return stored;
  }

  events(taskId: string, after = 0): StoredEvent[] {
    return (this.db.query("SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq").all(taskId, after) as Row[]).map((r) => ({
      seq: r.seq as number,
      taskId: r.task_id as string,
      runId: (r.run_id as string | null) ?? null,
      ts: r.ts as number,
      event: JSON.parse(r.data as string) as VEvent,
    }));
  }

  ledger(row: Omit<LedgerRow, "id" | "ts">): void {
    this.db
      .query("INSERT INTO ledger (ts, task_id, run_id, action, initiator, device, detail) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(Date.now(), row.taskId, row.runId, row.action, row.initiator, row.device, JSON.stringify(row.detail));
  }

  ledgerRows(taskId?: string, limit = 200): LedgerRow[] {
    const rows = taskId
      ? this.db.query("SELECT * FROM ledger WHERE task_id = ? ORDER BY id DESC LIMIT ?").all(taskId, limit)
      : this.db.query("SELECT * FROM ledger ORDER BY id DESC LIMIT ?").all(limit);
    return (rows as Row[]).map((r) => ({
      id: r.id as number,
      ts: r.ts as number,
      taskId: (r.task_id as string | null) ?? null,
      runId: (r.run_id as string | null) ?? null,
      action: r.action as string,
      initiator: r.initiator as string,
      device: (r.device as string | null) ?? null,
      detail: JSON.parse(r.detail as string) as Record<string, unknown>,
    }));
  }

  addCheck(c: Omit<CheckResult, "id" | "ts">): CheckResult {
    const ts = Date.now();
    const res = this.db
      .query("INSERT INTO checks (task_id, run_id, check_id, kind, ok, detail, attempt, ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(c.taskId, c.runId, c.checkId, c.kind, c.ok ? 1 : 0, c.detail, c.attempt, ts);
    return { ...c, id: Number(res.lastInsertRowid), ts };
  }

  checks(taskId: string): CheckResult[] {
    return (this.db.query("SELECT * FROM checks WHERE task_id = ? ORDER BY id").all(taskId) as Row[]).map((r) => ({
      id: r.id as number,
      taskId: r.task_id as string,
      runId: (r.run_id as string | null) ?? null,
      checkId: r.check_id as string,
      kind: r.kind as CheckResult["kind"],
      ok: r.ok === 1,
      detail: r.detail as string,
      attempt: r.attempt as number,
      ts: r.ts as number,
    }));
  }

  // ── devices and pairing ────────────────────────────────────────────────

  addDevice(device: Device, tokenHash: string): void {
    this.db.query("INSERT INTO devices (id, token_hash, data) VALUES (?, ?, ?)").run(device.id, tokenHash, JSON.stringify(device));
  }

  deviceByToken(tokenHash: string): Device | null {
    return parse<Device>(this.db.query("SELECT data FROM devices WHERE token_hash = ?").get(tokenHash) as Row | null);
  }

  devices(): Device[] {
    return (this.db.query("SELECT data FROM devices ORDER BY rowid").all() as Row[]).map((r) => parse<Device>(r)!);
  }

  updateDevice(device: Device): void {
    this.db.query("UPDATE devices SET data = ? WHERE id = ?").run(JSON.stringify(device), device.id);
  }

  addPairCode(codeHash: string, scope: string, expiresAt: number): void {
    this.db.query("INSERT INTO pair_codes (code_hash, scope, expires_at) VALUES (?, ?, ?)").run(codeHash, scope, expiresAt);
  }

  /** Single use: the compare-and-set on `used` means only one device can redeem a code. */
  redeemPairCode(codeHash: string): string | null {
    return this.tx(() => {
      const row = this.db.query("SELECT scope, expires_at FROM pair_codes WHERE code_hash = ? AND used = 0").get(codeHash) as Row | null;
      if (!row || (row.expires_at as number) < Date.now()) return null;
      this.db.query("UPDATE pair_codes SET used = 1 WHERE code_hash = ?").run(codeHash);
      return row.scope as string;
    });
  }

  idempotent(id: string): unknown | undefined {
    const row = this.db.query("SELECT response FROM idempotency WHERE id = ?").get(id) as Row | null;
    return row ? JSON.parse(row.response as string) : undefined;
  }

  remember(id: string, response: unknown): void {
    this.db.query("INSERT OR REPLACE INTO idempotency (id, ts, response) VALUES (?, ?, ?)").run(id, Date.now(), JSON.stringify(response ?? null));
  }

  // ── templates ──────────────────────────────────────────────────────────

  putTemplate(t: TemplateRow): void {
    this.db
      .query("INSERT INTO templates (role, version, status, data) VALUES ($role, $version, $status, $data) ON CONFLICT(role, version) DO UPDATE SET status = $status, data = $data")
      .run({ role: t.role, version: t.version, status: t.status, data: JSON.stringify(t) });
  }

  templates(role?: string): TemplateRow[] {
    const rows = role
      ? this.db.query("SELECT data FROM templates WHERE role = ? ORDER BY version").all(role)
      : this.db.query("SELECT data FROM templates ORDER BY role, version").all();
    return (rows as Row[]).map((r) => parse<TemplateRow>(r)!);
  }
}

function toInbox(r: Row): InboxEvent {
  return {
    id: r.id as number,
    taskId: r.task_id as string,
    kind: r.kind as InboxKind,
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
    dedupe: (r.dedupe as string | null) ?? null,
    status: r.status as InboxEvent["status"],
    createdAt: r.created_at as number,
  };
}

function toTimer(r: Row): TimerRow {
  return {
    id: r.id as number,
    taskId: (r.task_id as string | null) ?? null,
    kind: r.kind as TimerRow["kind"],
    dueAt: r.due_at as number,
    everyMinutes: (r.every_minutes as number | null) ?? null,
    payload: JSON.parse(r.payload as string) as Record<string, unknown>,
    status: r.status as TimerRow["status"],
  };
}

let current: Store | null = null;

/** The process-wide store. Tests call `useStore(new Store(":memory:"))`. */
export function db(): Store {
  current ??= new Store();
  return current;
}

export function useStore(store: Store): Store {
  current = store;
  return store;
}
