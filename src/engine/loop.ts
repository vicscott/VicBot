import { LIMITS } from "../config";
import { buildBundle } from "../context/bundle";
import { project } from "../context/project";
import { db, newId } from "../store";
import { pick, propose as proposeTemplate, score } from "../templates";
import { STATUSES, type Brief, type Check, type InboxEvent, type Note, type Role, type Run, type RunPurpose, type Status, type Task, type Verdict } from "../types";
import { kick } from "../wake/kick";
import { remember } from "../wake/memory";
import { changedArtifacts, takeBaseline, type Baseline } from "./baseline";
import { charge, remaining, reserve } from "./budget";
import { execute } from "./execute";
import { briefText, handoff } from "./handoff";
import { hostQuiet, hostSay, openCard } from "./host";
import { interrupted } from "./live";
import { coordinate, createChildren } from "./plan";
import { policyFor, selectHarness } from "./policy";
import { sessionDir, strictResume } from "./session";
import { settle } from "./settle";
import { clearVerdict, readVerdict, stripVerdict } from "./verdict";
import { verify } from "./verify";

const OPEN: Status[] = STATUSES.filter((s) => s !== "cancelled");

interface TurnCtx {
  notes: Note[];
  extra: { name: string; text: string; source?: string }[];
  initiator: string;
  origin?: RunPurpose;
  priorFinal?: string | null;
  baseline?: Baseline | null;
}

const ASK: Record<RunPurpose, string> = {
  work: "Do the task above in the working root. When you are finished, file the verdict as the protocol says.",
  continue: "Continue this task, taking the messages and answers above into account. Then file a new verdict.",
  rework: "Fix only what failed, as the rework block above describes. Keep what passed. Then file a new verdict.",
  verdict: "Do not redo the work. File the verdict for the work you just did, exactly as the protocol says.",
  verify: "Review the work above against the check. File a pass verdict when it meets the check, or fail with the facts when it does not.",
  chair: `Split this task into at most ${LIMITS.planChildren} parts with dependencies, and file a pass verdict whose "plan" lists them.`,
  tune: 'Propose the revised policy text, and file it in the verdict\'s "policy" field.',
};

function rootOf(task: Task): Task {
  return task.rootId === task.id ? task : (db().task(task.rootId) ?? task);
}

function lastWorkRun(taskId: string): Run | undefined {
  return db()
    .runs(taskId)
    .filter((r) => r.purpose === "work" || r.purpose === "continue" || r.purpose === "rework")
    .at(-1);
}

function scoreLast(task: Task, ok: boolean): void {
  const run = lastWorkRun(task.id);
  if (run && !task.escalated) score(run.templateRole, run.templateVersion, ok);
}

function short(text: string, n = 600): string {
  return text.length > n ? text.slice(0, n - 1) + "…" : text;
}

/** One job: a batch of inbox events for one task. Decides the purpose of the next turn and runs it. */
export async function wake(taskId: string, batch: InboxEvent[]): Promise<void> {
  const store = db();
  let task = store.task(taskId);
  if (!task || task.status === "cancelled") return;
  if (batch.some((e) => e.kind === "child")) {
    coordinate(task);
    task = store.task(taskId)!;
  }
  if (batch.some((e) => e.kind === "verify")) return finish(task, null, task.result ?? "");
  const work = batch.filter((e) => e.kind !== "child");
  if (!work.length || !task.route || task.status === "waiting_child") return;
  const start = work.find((e) => e.kind === "start");
  const rework = work.find((e) => e.kind === "rework");
  const ctx: TurnCtx = { notes: [], extra: [], initiator: "engine" };
  for (const e of work) {
    if (typeof e.payload.initiator === "string") ctx.initiator = e.payload.initiator;
    if (e.kind === "answer") ctx.extra.push({ name: `answer-${e.id}`, text: `Answer to "${String(e.payload.ask ?? "your question")}":\n${String(e.payload.text ?? e.payload.option ?? "")}`, source: "person" });
    if (e.kind === "timer") ctx.extra.push({ name: `timer-${e.id}`, text: `## Follow-up\nA timer you set has fired: ${String(e.payload.note ?? "follow up")}` });
    if (e.kind === "continue" && e.payload.nudge) ctx.extra.push({ name: "nudge", text: `## Loop guard\nYou repeated yourself: ${String(e.payload.nudge)}. Change approach, or file a verdict that says why you are stuck.` });
    if (e.kind === "recover") ctx.extra.push({ name: "recover", text: "## Restart\nVicBot restarted while this task was running. Check the working root for what was already done before you continue." });
  }
  if (rework) ctx.extra.push({ name: "rework", text: String(rework.payload.block ?? ""), source: "checks" });
  let purpose: RunPurpose;
  if (start && (start.payload.chair || (task.shape === "orchestrated" && !store.children(task.id).some((k) => k.planKey)))) {
    purpose = "chair";
    if (start.payload.evidence) ctx.extra.push({ name: "evidence", text: String(start.payload.evidence), source: "engine" });
  } else if (start) purpose = task.role === "tune" ? "tune" : "work";
  else if (rework) purpose = "rework";
  else purpose = "continue";
  for (const n of store.notes(task.id, "queued")) {
    const read = store.moveNote(n.id, "queued", "read");
    if (!read) continue;
    ctx.notes.push(read);
    store.event(task.id, null, { kind: "steer", noteId: n.id, text: n.text, phase: "read" });
  }
  if (purpose === "continue" && !ctx.notes.length && !ctx.extra.length) return;
  await turn(task, purpose, ctx);
}

async function turn(task: Task, purpose: RunPurpose, ctx: TurnCtx): Promise<void> {
  const store = db();
  const origin = ctx.origin ?? purpose;
  const role: Role = origin === "chair" ? "chair" : task.role;
  const serveRole = origin === "chair" ? "chair" : role === "tune" ? "tune" : "worker";
  const h = selectHarness({ route: task.route!, effort: task.effort, role: serveRole, designated: task.designated, web: task.web });
  if (!h) {
    const why = task.designated ? `@${task.designated} is not installed or not available` : `no available harness serves ${task.route}/${task.effort}`;
    store.transition(task.id, OPEN, "needs_route", {}, why);
    hostSay(`#${task.id} is waiting: ${why}. Install one, or pick another route.`, task.id);
    return;
  }
  const harnessId = h.manifest.id;
  const root = rootOf(task);
  const res = reserve(root, task.effort);
  if (!res) return blockOnBudget(task, "the task's budget is used up");
  const trust = origin === "chair" || role === "tune" ? "read" : task.trust;
  const web = !!task.web && h.manifest.capabilities.web;
  if (task.web && !web && purpose === "work") store.event(task.id, null, { kind: "notice", text: `This task needs current facts, but ${harnessId} has no web search. The answer will rely on what the model already knows.` });
  const policy = policyFor(task.effort, trust, res, web);
  const continuing = purpose === "continue" || purpose === "rework" || purpose === "verdict";
  const plan = strictResume(task, h, continuing);
  if (plan.kind === "recovery") store.event(task.id, null, { kind: "session", id: plan.session.id, state: "lost", note: plan.note });
  const template = pick(role);
  const bundle = buildBundle({
    task,
    template,
    kind: plan.kind,
    ask: ASK[purpose],
    notes: ctx.notes,
    extra: ctx.extra,
    lastResult: task.result ?? lastWorkRun(task.id)?.final ?? null,
    remaining: remaining(root),
  });
  const proj = project(bundle, h.manifest);
  const run: Run = store.putRun({
    id: newId("r_"),
    taskId: task.id,
    harness: harnessId,
    sessionId: plan.session.id,
    purpose,
    effort: task.effort,
    trust,
    status: "running",
    outcome: null,
    initiator: ctx.initiator,
    toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cost: 0 },
    templateRole: role,
    templateVersion: template.version,
    templateHash: template.hash,
    promptKind: plan.kind,
    verdict: null,
    verdictSource: null,
    final: null,
    startedAt: Date.now(),
    endedAt: null,
  });
  if (!store.transition(task.id, OPEN, "working", { harness: harnessId }, `${purpose} on ${harnessId}`)) return;
  store.event(task.id, run.id, { kind: "run", runId: run.id, phase: "start", harness: harnessId, purpose, promptKind: plan.kind, templateHash: template.hash });
  store.event(task.id, run.id, { kind: "context", promptKind: plan.kind, chars: (proj.system?.length ?? 0) + proj.prompt.length, stableChars: proj.stableChars, cut: bundle.cut });
  if (purpose === "work" && trust !== "read" && !h.manifest.capabilities.sandbox.length) {
    store.event(task.id, run.id, { kind: "notice", text: `${harnessId} has no sandbox: ${trust} trust is enforced by its tool list and working root only.` });
  }
  store.ledger({ taskId: task.id, runId: run.id, action: "run.start", initiator: ctx.initiator, device: null, detail: { harness: harnessId, purpose, trust, templateHash: template.hash, promptKind: plan.kind } });
  const baseline = ctx.baseline ?? (purpose === "work" || purpose === "continue" || purpose === "rework" ? takeBaseline(task) : null);
  clearVerdict(task.cwd);
  const started = Date.now();
  const ex = await execute(task, h, run, { runId: run.id, cwd: task.cwd, system: proj.system, prompt: proj.prompt, policy, resume: plan.resume, sessionDir: sessionDir(task, harnessId) }, policy, plan.session);

  const fresh = store.task(task.id)!;
  const rootNow = rootOf(fresh);
  store.patchTask(rootNow.id, { used: charge(rootNow, { toolCalls: ex.toolCalls, minutes: ex.minutes, cost: ex.usage.cost }) });
  const after = store.patchTask(task.id, {
    tokens: fresh.tokens + ex.usage.input + ex.usage.output,
    inputTokens: fresh.inputTokens + ex.usage.input,
    cacheRead: fresh.cacheRead + ex.usage.cacheRead,
    cost: fresh.cost + ex.usage.cost,
  })!;
  const endRun = (outcome: string, verdict: Verdict | null = null, source: Run["verdictSource"] = null) => {
    Object.assign(run, { status: "ended", outcome, toolCalls: ex.toolCalls, usage: ex.usage, final: ex.final, endedAt: Date.now(), verdict, verdictSource: source });
    store.putRun(run);
    store.event(task.id, run.id, { kind: "run", runId: run.id, phase: "end", harness: harnessId, purpose, outcome });
    store.ledger({ taskId: task.id, runId: run.id, action: "run.end", initiator: ctx.initiator, device: null, detail: { outcome, toolCalls: ex.toolCalls, input: ex.usage.input, cacheRead: ex.usage.cacheRead, cost: ex.usage.cost } });
  };

  if (interrupted.delete(task.id) || after.status === "cancelled") return endRun(after.status === "cancelled" ? "cancelled" : "interrupted");
  if (ex.spawnError) {
    endRun("spawn-error");
    settle(task.id, "failed", `could not start ${harnessId}: ${ex.spawnError}`);
    return;
  }
  if (ex.limit) {
    endRun(ex.limit.reason);
    store.event(task.id, run.id, { kind: "limit", reason: ex.limit.reason, text: ex.limit.text });
    return blockOnBudget(after, ex.limit.text);
  }
  if (ex.trip) {
    endRun("loop");
    store.event(task.id, run.id, { kind: "limit", reason: "loop", text: ex.trip });
    const trips = after.loopTrips + 1;
    store.patchTask(task.id, { loopTrips: trips });
    if (trips < 2) {
      store.transition(task.id, OPEN, "queued", {}, `loop guard: ${ex.trip}`);
      store.enqueue(task.id, "continue", { nudge: ex.trip });
      kick();
      return;
    }
    return escalate(store.task(task.id)!, `the loop guard tripped twice (${ex.trip})`);
  }
  const read = readVerdict(task.cwd, started, ex.final);
  if (!read.verdict && purpose !== "verdict") {
    endRun("no-verdict");
    store.event(task.id, run.id, { kind: "notice", text: `No verdict (${read.note}). Asking once for it.` });
    return turn(store.task(task.id)!, "verdict", { notes: [], extra: [], initiator: "engine", origin, priorFinal: ex.final, baseline });
  }
  const verdict: Verdict = read.verdict ?? { decision: "fail", reason: "no verdict after one follow-up turn" };
  endRun(verdict.decision, verdict, read.source);
  store.event(task.id, run.id, { kind: "verdict", decision: verdict.decision, reason: verdict.reason, source: read.source });
  if (read.source !== "file") store.ledger({ taskId: task.id, runId: run.id, action: "verdict.fallback", initiator: "engine", device: null, detail: { source: read.source, note: read.note ?? null } });
  for (const m of verdict.remember ?? []) remember(task.id, m);
  const text = stripVerdict((purpose === "verdict" && ctx.priorFinal ? ctx.priorFinal : ex.final) ?? "");
  await gate(store.task(task.id)!, run, verdict, origin, baseline, text);
}

async function gate(task: Task, run: Run, v: Verdict, origin: RunPurpose, baseline: Baseline | null, final: string): Promise<void> {
  const store = db();
  if (origin === "chair") {
    if (v.decision === "pass" && v.plan) {
      const bad = createChildren(task, v.plan);
      if (bad) settle(task.id, "blocked", `the chair's plan was invalid: ${bad}`);
      return;
    }
    if (v.decision === "human") return waitInput(task, v.ask ?? v.reason, final);
    settle(task.id, "blocked", `the chair filed no plan: ${v.reason}`);
    return;
  }
  if (origin === "tune") {
    const target = task.meta.tuneRole as Role | undefined;
    if (v.decision !== "pass" || !v.policy || !target) return void settle(task.id, "failed", v.policy ? v.reason : `no policy in the verdict: ${v.reason}`);
    try {
      const row = proposeTemplate(target, v.policy, v.reason);
      settle(task.id, "done", `candidate ${target} v${row.version} on trial`, { result: `Candidate ${target} v${row.version} (${row.hash}) is on trial.` });
    } catch (err) {
      settle(task.id, "failed", `candidate refused: ${(err as Error).message}`);
    }
    return;
  }
  switch (v.decision) {
    case "pass": {
      if (baseline && task.contract.artifacts.length && !changedArtifacts(task, baseline).length) {
        const detail = `a pass was filed, but none of ${task.contract.artifacts.join(", ")} changed`;
        recordCheck(task, run, "artifacts", "file", false, detail);
        return reworkOrEscalate(task, [{ id: "artifacts", detail }], final);
      }
      if (store.notes(task.id, "queued").length) {
        store.transition(task.id, OPEN, "queued", { result: final }, "new messages arrived during the run");
        store.enqueue(task.id, "note", {});
        kick();
        return;
      }
      if (v.wake) {
        store.addTimer({ taskId: task.id, kind: "followup", dueAt: Date.now() + v.wake.afterMinutes * 60_000, everyMinutes: null, payload: { note: v.wake.note } });
        store.transition(task.id, OPEN, "waiting_timer", { result: final }, `follow-up in ${v.wake.afterMinutes} min: ${v.wake.note}`);
        hostQuiet(`#${task.id} will check back in ${v.wake.afterMinutes} min`, task.id);
        return;
      }
      return finish(task, run, final);
    }
    case "rework":
      recordCheck(task, run, "self", "judge", false, v.reason);
      return reworkOrEscalate(task, [{ id: "self", detail: v.reason }], final);
    case "fail":
      scoreLast(task, false);
      settle(task.id, "failed", v.reason, { result: final || task.result });
      return;
    case "human":
      return waitInput(task, v.ask ?? v.reason, final);
    case "overflow":
      return escalate(task, `overflow: ${v.reason}`, v.brief);
    case "handoff":
      return handoff(task, v);
  }
}

/** Verification, then done. Deterministic checks, then a review on another harness, then the person. */
export async function finish(task: Task, run: Run | null, result: string): Promise<void> {
  const store = db();
  if (!store.transition(task.id, OPEN, "verifying", { result })) return;
  const { outcomes, human } = await verify(store.task(task.id)!, (check) => review(task, check, result));
  const now = store.task(task.id)!;
  if (now.status === "cancelled") return;
  for (const o of outcomes) recordCheck(task, run, o.check.id, o.check.kind, o.ok, o.detail);
  const failed = outcomes.filter((o) => !o.ok);
  if (failed.length) return reworkOrEscalate(now, failed.map((o) => ({ id: o.check.id, detail: o.detail })), result);
  if (human.length) {
    openCard({
      taskId: task.id,
      kind: "approval",
      title: `#${task.id} needs your check`,
      body: `${human.map((c) => `- ${c.ask}`).join("\n")}\n\n${short(result)}`,
      options: [
        { id: "approve", label: "Approve" },
        { id: "reject", label: "Send back" },
      ],
      allowText: true,
    });
    store.transition(task.id, ["verifying"], "waiting_input", {}, "waiting for your check");
    return;
  }
  scoreLast(now, true);
  settle(task.id, "done", outcomes.length ? `${outcomes.length} check(s) passed` : undefined, { result });
}

function recordCheck(task: Task, run: Run | null, checkId: string, kind: Check["kind"], ok: boolean, detail: string): void {
  const store = db();
  const attempt = store.checks(task.id).filter((c) => c.checkId === checkId).length + 1;
  store.addCheck({ taskId: task.id, runId: run?.id ?? null, checkId, kind, ok, detail: detail.slice(0, 4000), attempt });
  store.event(task.id, run?.id ?? null, { kind: "check", checkId, check: kind, ok, detail: short(detail, 400) });
}

export function reworkBlock(task: Task, failures: { id: string; detail: string }[], previous: string): string {
  const failed = failures.map((f) => `- ${f.id}: ${f.detail}`).join("\n").slice(0, LIMITS.reworkFailureChars);
  const passed = task.contract.acceptance.map((c) => c.id).filter((id) => !failures.some((f) => f.id === id));
  return [
    `## Rework ${task.reworks + 1}`,
    `1. Goal: ${task.goal.slice(0, 400)}`,
    `2. What failed:\n${failed}`,
    `3. Your previous answer began:\n${previous.slice(0, LIMITS.reworkAnswerChars) || "(no text)"}`,
    `4. What passed: ${passed.length ? passed.join(", ") : "nothing else was checked"}`,
    "5. Do now: fix only what failed, keep what passed, and file a new verdict.",
  ].join("\n");
}

/** One rework per check; a check that fails a second time escalates instead. */
function reworkOrEscalate(task: Task, failures: { id: string; detail: string }[], final: string): void {
  const store = db();
  scoreLast(task, false);
  const history = store.checks(task.id);
  const repeated = failures.find((f) => history.filter((c) => c.checkId === f.id && !c.ok).length > LIMITS.reworksPerCheck);
  if (repeated) return escalate(task, `check "${repeated.id}" failed twice: ${repeated.detail.slice(0, 300)}`);
  const block = reworkBlock(task, failures, final);
  store.transition(task.id, OPEN, "queued", { reworks: task.reworks + 1, result: final }, `rework: ${failures.map((f) => f.id).join(", ")}`);
  store.enqueue(task.id, "rework", { block });
  kick();
}

/** Escalation happens on evidence only, once, and never for a designated task. */
export function escalate(task: Task, reason: string, brief?: Brief): void {
  const store = db();
  store.event(task.id, null, { kind: "notice", text: `Escalation: ${reason}` });
  const blocked = (why: string) => {
    settle(task.id, "blocked", why);
    openCard({ taskId: task.id, kind: "blocked", title: `#${task.id} is blocked`, body: why, options: [{ id: "retry", label: "Try again" }, { id: "close", label: "Close it" }], allowText: true });
  };
  if (task.shape === "designated") return blocked(`designated to @${task.designated}, so no automatic escalation. ${reason}`);
  if (task.escalated || task.shape === "orchestrated" || task.depth >= 2) return blocked(`already escalated once. ${reason}`);
  store.ledger({ taskId: task.id, runId: null, action: "task.escalate", initiator: "engine", device: null, detail: { reason } });
  store.transition(task.id, OPEN, "queued", { escalated: true, shape: "orchestrated" }, `escalated: ${reason}`);
  store.enqueue(task.id, "start", { chair: true, evidence: `${reason}${brief ? `\n\n${briefText(brief)}` : ""}` }, `escalate:${task.id}`);
  kick();
}

/** A spent budget blocks with a card. It never escalates: a bigger shape would spend more. */
function blockOnBudget(task: Task, why: string): void {
  settle(task.id, "blocked", `budget: ${why}`);
  openCard({
    taskId: task.id,
    kind: "budget",
    title: `#${task.id} stopped at its budget`,
    body: `${why}. Extending adds one more effort-sized budget to the task and continues it.`,
    options: [
      { id: "extend", label: "Extend and continue" },
      { id: "stop", label: "Leave it" },
    ],
    allowText: false,
  });
}

function waitInput(task: Task, ask: string, final?: string): void {
  const store = db();
  openCard({ taskId: task.id, kind: "question", title: `#${task.id} asks: ${short(ask, 140)}`, body: ask, options: [], allowText: true });
  store.transition(task.id, OPEN, "waiting_input", final ? { result: final } : {}, short(ask, 200));
}

/** The independent review: another harness when one is installed, read trust, a fresh session. */
async function review(task: Task, check: Extract<Check, { kind: "judge" }>, result: string): Promise<{ ok: boolean; detail: string }> {
  const store = db();
  const current = store.task(task.id) ?? task;
  const worker = current.harness;
  const h = selectHarness({ route: current.route ?? "explore", effort: current.effort, role: "verify", exclude: worker ? [worker] : [], web: current.web });
  if (!h) return { ok: true, detail: "no reviewer harness is available; the review was skipped" };
  const res = reserve(rootOf(current), "standard");
  if (!res) return { ok: false, detail: "no budget left for the review" };
  const policy = policyFor("standard", "read", res, !!current.web && h.manifest.capabilities.web);
  const template = pick("verify");
  const artifacts = current.contract.artifacts.length ? `\nArtifacts to inspect: ${current.contract.artifacts.join(", ")}` : "";
  const bundle = buildBundle({
    task: current,
    template,
    kind: "bundle",
    ask: ASK.verify,
    extra: [
      { name: "check", text: `## Check "${check.id}"\n${check.rubric}${artifacts}${worker ? `\nThe work was done by ${worker}.` : ""}` },
      { name: "work", text: result || "(the worker gave no text answer; inspect the working root)", source: "worker" },
    ],
  });
  const proj = project(bundle, h.manifest);
  const session = store.putSession({ id: newId("s_"), taskId: `${task.id}:verify`, harness: h.manifest.id, nativeId: null, cwd: current.cwd, state: "live", lostReason: null, createdAt: Date.now(), usedAt: Date.now() });
  const run: Run = store.putRun({
    id: newId("r_"),
    taskId: task.id,
    harness: h.manifest.id,
    sessionId: session.id,
    purpose: "verify",
    effort: "standard",
    trust: "read",
    status: "running",
    outcome: null,
    initiator: "engine",
    toolCalls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cost: 0 },
    templateRole: "verify",
    templateVersion: template.version,
    templateHash: template.hash,
    promptKind: "bundle",
    verdict: null,
    verdictSource: null,
    final: null,
    startedAt: Date.now(),
    endedAt: null,
  });
  store.event(task.id, run.id, { kind: "run", runId: run.id, phase: "start", harness: h.manifest.id, purpose: "verify", promptKind: "bundle", templateHash: template.hash });
  clearVerdict(current.cwd);
  const started = Date.now();
  const ex = await execute(current, h, run, { runId: run.id, cwd: current.cwd, system: proj.system, prompt: proj.prompt, policy, resume: null, sessionDir: sessionDir(current, h.manifest.id) + "-verify" }, policy, session);
  const rootNow = rootOf(store.task(task.id)!);
  store.patchTask(rootNow.id, { used: charge(rootNow, { toolCalls: ex.toolCalls, minutes: ex.minutes, cost: ex.usage.cost }) });
  const t = store.task(task.id)!;
  store.patchTask(task.id, { tokens: t.tokens + ex.usage.input + ex.usage.output, inputTokens: t.inputTokens + ex.usage.input, cacheRead: t.cacheRead + ex.usage.cacheRead, cost: t.cost + ex.usage.cost });
  interrupted.delete(task.id);
  const read = readVerdict(current.cwd, started, ex.final);
  const v = read.verdict;
  const ok = !v || v.decision === "pass";
  Object.assign(run, { status: "ended", outcome: v?.decision ?? "no-verdict", toolCalls: ex.toolCalls, usage: ex.usage, final: ex.final, endedAt: Date.now(), verdict: v, verdictSource: read.source });
  store.putRun(run);
  store.event(task.id, run.id, { kind: "run", runId: run.id, phase: "end", harness: h.manifest.id, purpose: "verify", outcome: run.outcome ?? undefined });
  score("verify", template.version, !!v);
  const same = h.manifest.id === worker ? " (same harness as the worker: no other was available)" : "";
  if (!v) return { ok, detail: `${h.manifest.id} filed no review verdict; not counted against the work${same}` };
  return { ok, detail: `${h.manifest.id}: ${v.reason}${same}` };
}
