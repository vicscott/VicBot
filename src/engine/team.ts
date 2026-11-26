import { digest, firstSentence } from "../digest";
import { db } from "../store";
import type { Budget, Card, Check, Run, Status, Task } from "../types";
import { stripVerdict } from "./verdict";

/**
 * What the bots on one conversation said to each other, and what they share. Both are read from the
 * ledger and the runs, so nothing here costs a model call and the record stays the source of truth.
 */
export interface Say {
  ts: number;
  from: string;
  to: string;
  text: string;
  tone: "plain" | "ok" | "bad" | "ask";
  taskId: string;
}

export interface Part {
  id: string;
  key: string;
  title: string;
  route: string | null;
  harness: string | null;
  status: Status;
  lead: string | null;
}

export interface Board {
  goal: string;
  status: Status;
  route: string | null;
  effort: string;
  owner: string | null;
  bots: string[];
  doneWhen: string[];
  parts: Part[];
  findings: { from: string; taskId: string; text: string }[];
  files: string[];
  open: string[];
  checks: { taskId: string; id: string; ok: boolean; detail: string; attempt: number }[];
  budget: { used: Budget; limit: Budget };
}

export interface Team {
  rootId: string;
  discussion: Say[];
  board: Board;
}

const YOU = "You";
const HOST = "VicBot";
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const clip = (s: string, n = 400) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

function worker(task: Task, harness: string | null): string {
  const on = harness ? ` · ${harness}` : "";
  if (task.planKey) return `Part ${task.planKey.split(":").at(-1)}${on}`;
  return `${cap(task.route ?? "unrouted")} bot${on}`;
}

function speaker(task: Task, run: Run): string {
  if (run.purpose === "verify") return `Reviewer · ${run.harness}`;
  if (run.purpose === "chair") return `Chair · ${run.harness}`;
  return worker(task, run.harness);
}

/** The router's reason without its rule syntax: explore:"research" reads as "research". */
function humanReason(reason: string): string {
  return reason.replace(/\b(?:explore|build|operate):("[^"]+")/g, "$1").replace(/(^|;\s*)(quick|standard|deep):\s*/g, "$1$2 effort: ");
}

/** The point of a final answer in one or two sentences. */
export function pointOf(text: string | null): string {
  const clean = stripVerdict(text ?? "").trim();
  if (!clean) return "";
  const d = digest(clean);
  return d.conclusion ?? d.parts[0]?.lead ?? clip(firstSentence(clean), 300);
}

function checkText(c: Check): string {
  switch (c.kind) {
    case "cmd":
    case "test":
      return `\`${c.cmd}\` succeeds`;
    case "file":
      return `${c.path} exists${c.contains ? ` and contains "${c.contains}"` : ""}`;
    case "judge":
      return `A reviewer agrees: ${c.rubric}`;
    case "human":
      return `You approve: ${c.ask}`;
  }
}

function tree(root: Task): Task[] {
  const out: Task[] = [root];
  for (let i = 0; i < out.length && out.length < 60; i++) out.push(...db().children(out[i]!.id));
  return out;
}

function runSay(task: Task, run: Run, to: string): Say | null {
  const from = speaker(task, run);
  const v = run.verdict;
  const ts = run.endedAt ?? run.startedAt;
  const say = (text: string, tone: Say["tone"] = "plain", target = to): Say => ({ ts, from, to: target, text, tone, taskId: task.id });
  if (run.purpose === "tune") return null;
  if (run.purpose === "verify") return v?.decision === "pass" ? say(`Looks right. ${v.reason}`, "ok", worker(task, task.harness)) : say(`Not yet: ${v?.reason ?? run.outcome ?? "no verdict"}`, "bad", worker(task, task.harness));
  if (run.purpose === "chair") {
    if (v?.plan?.length) return say(`Plan in ${v.plan.length} part${v.plan.length > 1 ? "s" : ""}: ${v.plan.map((p) => `${p.key} (${p.route}${p.dependsOn.length ? `, after ${p.dependsOn.join(", ")}` : ""}): ${clip(p.goal.split("\n")[0]!, 120)}`).join("; ")}`, "plain", "the parts");
    return say(v ? `${v.decision}: ${v.reason}` : `Ended without a plan (${run.outcome ?? "no verdict"})`, v?.decision === "pass" ? "plain" : "bad");
  }
  if (!v) return say(`Ended without a verdict${run.outcome ? ` (${run.outcome})` : ""}.`, "bad");
  switch (v.decision) {
    case "pass":
      return say(`Done. ${pointOf(run.final) || v.reason}`, "ok");
    case "rework":
      return say(`I need another pass: ${v.reason}`, "bad");
    case "fail":
      return say(`I can't do this: ${v.reason}`, "bad");
    case "human":
      return say(`Only you can decide: ${v.ask ?? v.reason}`, "ask", YOU);
    case "overflow":
      return say(`This is bigger than one run: ${v.reason}`, "ask");
    case "handoff":
      return say(`This fits ${v.route ?? "another route"} better: ${v.reason}${v.brief ? ` Brief: ${clip(v.brief.goal, 200)}` : ""}`, "plain");
  }
}

function cardSays(card: Card, task: Task): Say[] {
  const asker = card.kind === "question" || card.kind === "approval" ? worker(task, task.harness) : HOST;
  const out: Say[] = [{ ts: card.createdAt, from: asker, to: YOU, text: card.body && card.kind !== "idea" ? `${card.title}: ${clip(card.body, 240)}` : card.title, tone: "ask", taskId: task.id }];
  if (card.answer && card.answeredAt) {
    const label = card.answer.option ? (card.options.find((o) => o.id === card.answer!.option)?.label ?? card.answer.option) : "";
    out.push({ ts: card.answeredAt, from: YOU, to: asker, text: [label, card.answer.text].filter(Boolean).join(": ") || "answered", tone: "plain", taskId: task.id });
  }
  return out;
}

export function team(id: string): Team {
  const store = db();
  const start = store.task(id);
  if (!start) throw new Error(`no task ${id}`);
  const root = store.task(start.rootId) ?? start;
  const tasks = tree(root);
  const says: Say[] = [];
  const bots = new Set<string>();
  const findings: Board["findings"] = [];
  const open: string[] = [];
  const files = new Set<string>();
  const checks: Board["checks"] = [];
  for (const task of tasks) {
    const to = task.planKey ? `Chair · ${store.task(task.parentId ?? "")?.harness ?? ""}`.replace(/ · $/, "") : HOST;
    let current = worker(task, task.harness);
    let spoke = false;
    for (const { ts, event: ev } of store.events(task.id)) {
      const add = (from: string, target: string, text: string, tone: Say["tone"] = "plain") => says.push({ ts, from, to: target, text, tone, taskId: task.id });
      switch (ev.kind) {
        case "user":
          if (!spoke || task.id === root.id) add(YOU, HOST, clip(task.meta.idea && task.meta.kind === "idea" ? task.meta.idea : ev.text, 500));
          spoke = true;
          break;
        case "route":
          current = worker({ ...task, route: ev.route }, ev.harness === "none" ? null : ev.harness);
          bots.add(current);
          add(HOST, current, `Over to you: ${ev.route} · ${ev.effort}${ev.shape !== "single" ? ` · ${ev.shape}` : ""}. Why: ${humanReason(ev.reason)}`);
          break;
        case "steer":
          if (ev.phase === "queued") add(YOU, current, clip(ev.text, 400));
          break;
        case "check":
          if (ev.check !== "judge") add(`${HOST} checks`, current, `${ev.ok ? "✓" : "✗"} ${ev.checkId}: ${clip(ev.detail, 240)}`, ev.ok ? "ok" : "bad");
          break;
        case "handoff":
          if (ev.phase === "failed") add(HOST, current, `Handoff refused: ${ev.reason}`, "bad");
          else if (ev.phase === "accepted") add(HOST, `${cap(ev.route ?? "")} bot`, `Handed over${ev.taskId ? ` as #${ev.taskId}` : ""}: ${ev.reason}`);
          break;
        case "limit":
          add(HOST, current, `Stopped: ${ev.text}`, "bad");
          break;
        case "notice":
          if (ev.text.startsWith("Escalation:")) add(HOST, "a chair", ev.text.replace(/^Escalation:\s*/, "Escalating: "), "ask");
          break;
      }
    }
    for (const run of store.runs(task.id)) {
      bots.add(speaker(task, run));
      if (run.status !== "ended") continue;
      const s = runSay(task, run, to);
      if (s) says.push(s);
      for (const f of run.verdict?.findings ?? []) findings.push({ from: speaker(task, run), taskId: task.id, text: `${f.title}${f.severity ? ` (${f.severity})` : ""}` });
      for (const q of run.verdict?.brief?.open_questions ?? []) open.push(q);
    }
    for (const card of store.cards({ taskId: task.id })) {
      says.push(...cardSays(card, task));
      if (card.status === "open") open.push(card.title);
    }
    if (task.status === "done" && task.result && task.id !== root.id) {
      const point = pointOf(task.result);
      if (point) findings.push({ from: worker(task, task.harness), taskId: task.id, text: point });
    }
    for (const a of task.contract.artifacts) files.add(a);
    const latest = new Map<string, Board["checks"][number]>();
    for (const c of store.checks(task.id)) latest.set(c.checkId, { taskId: task.id, id: c.checkId, ok: c.ok, detail: clip(c.detail, 200), attempt: c.attempt });
    checks.push(...latest.values());
  }
  if (root.status === "done" && root.result) {
    const point = pointOf(root.result);
    if (point) findings.unshift({ from: worker(root, root.harness), taskId: root.id, text: point });
  }
  if (["waiting_input", "waiting_approval", "needs_route"].includes(root.status) && root.statusReason) open.push(root.statusReason);
  says.sort((a, b) => a.ts - b.ts || Number(b.from === YOU) - Number(a.from === YOU));
  const parts: Part[] = tasks
    .filter((t) => t.parentId)
    .map((t) => ({ id: t.id, key: t.planKey?.split(":").at(-1) ?? "handoff", title: t.title, route: t.route, harness: t.harness, status: t.status, lead: t.status === "done" ? pointOf(t.result) || null : t.statusReason }));
  return {
    rootId: root.id,
    discussion: says,
    board: {
      goal: root.meta.kind === "idea" ? (root.meta.idea ?? root.title) : root.goal,
      status: root.status,
      route: root.route,
      effort: root.effort,
      owner: root.harness,
      bots: [...bots],
      doneWhen: [...root.contract.acceptance.map(checkText), ...root.contract.constraints.map((c) => `Constraint: ${c}`)],
      parts,
      findings,
      files: [...files],
      open: [...new Set(open)],
      checks,
      budget: { used: root.used, limit: root.budget },
    },
  };
}
