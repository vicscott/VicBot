export const ROUTES = ["explore", "build", "operate"] as const;
export type Route = (typeof ROUTES)[number];
export const EFFORTS = ["quick", "standard", "deep"] as const;
export type Effort = (typeof EFFORTS)[number];
export const SHAPES = ["single", "orchestrated", "designated"] as const;
export type Shape = (typeof SHAPES)[number];
export const TRUSTS = ["read", "workspace", "full"] as const;
export type Trust = (typeof TRUSTS)[number];
export type Mode = "interactive" | "unattended";
export type Role = "explore" | "build" | "operate" | "verify" | "chair" | "tune";

export const STATUSES = [
  "needs_route",
  "queued",
  "working",
  "waiting_approval",
  "waiting_input",
  "waiting_child",
  "waiting_timer",
  "verifying",
  "done",
  "blocked",
  "failed",
  "cancelled",
] as const;
export type Status = (typeof STATUSES)[number];
export const FINAL: readonly Status[] = ["done", "blocked", "failed", "cancelled"];

export type Check =
  | { id: string; kind: "cmd"; cmd: string; timeoutSec?: number }
  | { id: string; kind: "test"; cmd: string; timeoutSec?: number }
  | { id: string; kind: "file"; path: string; contains?: string }
  | { id: string; kind: "judge"; rubric: string }
  | { id: string; kind: "human"; ask: string };

export interface Contract {
  acceptance: Check[];
  constraints: string[];
  artifacts: string[];
}

export interface Budget {
  toolCalls: number;
  minutes: number;
  cost: number;
}

export interface Brief {
  goal: string;
  done_when: string;
  constraints: string[];
  artifacts: string[];
  tried: string[];
  open_questions: string[];
}

export const DECISIONS = ["pass", "rework", "fail", "human", "overflow", "handoff"] as const;
export type Decision = (typeof DECISIONS)[number];

export interface PlanItem {
  key: string;
  goal: string;
  route: Route;
  effort: Effort;
  dependsOn: string[];
  artifacts: string[];
}

export interface MemoryWrite {
  key: string;
  text: string;
  scope: "short" | "long";
  subject?: string;
}

export interface Verdict {
  decision: Decision;
  reason: string;
  ask?: string;
  brief?: Brief;
  route?: Route;
  findings?: { title: string; severity: string; evidence: string }[];
  remember?: MemoryWrite[];
  wake?: { afterMinutes: number; note: string };
  plan?: PlanItem[];
  policy?: string;
}

export type VerdictSource = "file" | "tag" | "missing";

export interface Task {
  id: string;
  title: string;
  goal: string;
  contract: Contract;
  contractTier: "auto" | "edited";
  shape: Shape;
  route: Route | null;
  effort: Effort;
  trust: Trust;
  /** The most trust any run under this root may get; raised only by the person. */
  ceiling: Trust;
  mode: Mode;
  role: Role;
  status: Status;
  statusReason: string | null;
  rootId: string;
  parentId: string | null;
  depth: number;
  planKey: string | null;
  dependsOn: string[];
  cwd: string;
  harness: string | null;
  designated: string | null;
  visited: Route[];
  escalated: boolean;
  renewals: number;
  reworks: number;
  loopTrips: number;
  meta: Record<string, string>;
  budget: Budget;
  used: Budget;
  result: string | null;
  tokens: number;
  cacheRead: number;
  inputTokens: number;
  cost: number;
  createdAt: number;
  updatedAt: number;
}

export type RunPurpose = "work" | "continue" | "rework" | "verdict" | "verify" | "chair" | "tune";
export type PromptKind = "bundle" | "delta" | "recovery";

export interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cost: number;
}

export interface Run {
  id: string;
  taskId: string;
  harness: string;
  sessionId: string | null;
  purpose: RunPurpose;
  effort: Effort;
  trust: Trust;
  status: "queued" | "running" | "parked" | "ended";
  outcome: string | null;
  initiator: string;
  toolCalls: number;
  usage: Usage;
  templateRole: Role;
  templateVersion: number;
  templateHash: string;
  promptKind: PromptKind;
  verdict: Verdict | null;
  verdictSource: VerdictSource | null;
  final: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface Session {
  id: string;
  taskId: string;
  harness: string;
  nativeId: string | null;
  cwd: string;
  state: "live" | "lost" | "closed";
  lostReason: string | null;
  createdAt: number;
  usedAt: number;
}

export type VEvent =
  | { kind: "user"; text: string; via?: string }
  | { kind: "route"; route: Route; effort: Effort; shape: Shape; harness: string; confidence: number; reason: string }
  | { kind: "run"; runId: string; phase: "start" | "end"; harness: string; purpose: RunPurpose; promptKind?: PromptKind; templateHash?: string; outcome?: string }
  | { kind: "session"; id: string; state: "live" | "lost"; note?: string }
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool"; id: string; name: string; input: string; phase: "start" | "end"; ok?: boolean; error?: string }
  | { kind: "usage"; input: number; output: number; cacheRead: number; cost: number }
  | { kind: "notice"; text: string }
  | { kind: "error"; text: string }
  | { kind: "limit"; reason: "budget" | "loop" | "time"; text: string }
  | { kind: "verdict"; decision: Decision; reason: string; source: VerdictSource }
  | { kind: "check"; checkId: string; check: Check["kind"]; ok: boolean; detail: string }
  | { kind: "handoff"; phase: "asked" | "accepted" | "failed"; route?: Route; taskId?: string; reason: string }
  | { kind: "steer"; noteId: string; text: string; phase: "queued" | "read" | "withdrawn" }
  | { kind: "status"; from: Status; to: Status; reason?: string }
  | { kind: "context"; promptKind: PromptKind; chars: number; stableChars: number; cut: string[] }
  | { kind: "exit"; code: number | null };

export interface StoredEvent {
  seq: number;
  taskId: string;
  runId: string | null;
  ts: number;
  event: VEvent;
}

export type InboxKind = "start" | "note" | "answer" | "child" | "timer" | "recover" | "rework" | "continue" | "verify";

export interface InboxEvent {
  id: number;
  taskId: string;
  kind: InboxKind;
  payload: Record<string, unknown>;
  dedupe: string | null;
  status: "pending" | "claimed" | "done";
  createdAt: number;
}

export interface CardOption {
  id: string;
  label: string;
  irreversible?: boolean;
}

export interface Card {
  id: string;
  taskId: string | null;
  kind: "route" | "question" | "budget" | "blocked" | "contradiction" | "approval" | "result";
  title: string;
  body: string;
  options: CardOption[];
  allowText: boolean;
  status: "open" | "answered" | "expired";
  answer: { option: string | null; text: string | null; device: string } | null;
  createdAt: number;
  answeredAt: number | null;
}

export interface ThreadRow {
  id: number;
  ts: number;
  author: "person" | "host";
  kind: "say" | "report" | "card" | "status";
  text: string;
  taskId: string | null;
  cardId: string | null;
  pointer: string | null;
  delivery: "sent" | "suppressed";
}

export interface Note {
  id: string;
  taskId: string;
  text: string;
  mode: "push" | "fold" | "interrupt";
  status: "queued" | "read" | "withdrawn";
  device: string;
  createdAt: number;
  readAt: number | null;
}

export interface CheckResult {
  id: number;
  taskId: string;
  runId: string | null;
  checkId: string;
  kind: Check["kind"];
  ok: boolean;
  detail: string;
  attempt: number;
  ts: number;
}

export type Scope = "full" | "standard" | "notify";

export interface Device {
  id: string;
  name: string;
  scope: Scope;
  createdAt: number;
  lastSeen: number | null;
  revoked: boolean;
}

export interface TimerRow {
  id: number;
  taskId: string | null;
  kind: "followup" | "schedule";
  dueAt: number;
  everyMinutes: number | null;
  payload: Record<string, unknown>;
  status: "armed" | "fired" | "cancelled";
}

export interface LedgerRow {
  id: number;
  ts: number;
  taskId: string | null;
  runId: string | null;
  action: string;
  initiator: string;
  device: string | null;
  detail: Record<string, unknown>;
}

export interface TemplateRow {
  role: Role;
  version: number;
  hash: string;
  status: "active" | "candidate" | "retired";
  protocol: string;
  policy: string;
  parent: number | null;
  runs: number;
  passes: number;
  createdAt: number;
  note: string | null;
}

export type BusMessage =
  | { type: "task"; task: Task }
  | { type: "event"; taskId: string; event: StoredEvent }
  | { type: "thread"; row: ThreadRow }
  | { type: "card"; card: Card }
  | { type: "note"; note: Note };
