import { LIMITS } from "../config";
import { db } from "../store";
import { FINAL, type PlanItem, type Task } from "../types";
import { kick } from "../wake/kick";
import { createTask } from "./create";
import { openCard } from "./host";
import { defaultTrust, lowerTrust } from "./policy";
import { settle } from "./settle";

const BAD = ["failed", "blocked", "cancelled"];

/** Validates a chair's plan: size, unique keys, known dependencies, no cycles. */
export function validatePlan(plan: PlanItem[]): string | null {
  if (!plan.length) return "the plan is empty";
  if (plan.length > LIMITS.planChildren) return `the plan has ${plan.length} parts; at most ${LIMITS.planChildren}`;
  const keys = new Set(plan.map((p) => p.key));
  if (keys.size !== plan.length) return "plan keys are not unique";
  for (const p of plan) for (const d of p.dependsOn) if (!keys.has(d)) return `${p.key} depends on unknown ${d}`;
  const done = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const p of plan) if (!done.has(p.key) && p.dependsOn.every((d) => done.has(d))) (done.add(p.key), (progress = true));
  }
  return done.size === plan.length ? null : "the plan has a dependency cycle";
}

const round = (t: Task) => `${t.renewals}:`;

export function createChildren(parent: Task, plan: PlanItem[]): string | null {
  const bad = validatePlan(plan);
  if (bad) return bad;
  const store = db();
  const prefix = round(parent);
  for (const item of plan) {
    const child = createTask({
      goal: `${item.goal}\n\nThis is one part of a larger task: ${parent.title}`,
      title: `${item.key}: ${item.goal.split("\n")[0]!.slice(0, 70)}`,
      route: item.route,
      effort: item.effort,
      parent,
      cwd: parent.cwd,
      trust: lowerTrust(parent.ceiling, defaultTrust(item.route)),
      planKey: prefix + item.key,
      dependsOn: item.dependsOn.map((d) => prefix + d),
      contract: { acceptance: [], constraints: parent.contract.constraints, artifacts: item.artifacts },
    });
    if (!item.dependsOn.length) store.enqueue(child.id, "start", {}, `start:${child.id}`);
    else store.patchTask(child.id, { statusReason: `waits for ${item.dependsOn.join(", ")}` });
  }
  store.transition(parent.id, "any", "waiting_child", {}, `${plan.length} part(s) planned`);
  kick();
  return null;
}

/** A child settled: start what is now unblocked, renew the plan on failure, or verify the whole. */
export function coordinate(parent: Task): void {
  const store = db();
  const kids = store.children(parent.id);
  if (!kids.length || parent.status !== "waiting_child") return;
  const latest = kids.at(-1)!;
  if (!latest.planKey) {
    const handoffKid = latest;
    if (!FINAL.includes(handoffKid.status)) return;
    if (handoffKid.status === "done") settle(parent.id, "done", `done by #${handoffKid.id}`, { result: handoffKid.result });
    else settle(parent.id, "blocked", `handoff #${handoffKid.id} ${handoffKid.status}: ${handoffKid.statusReason ?? ""}`);
    return;
  }
  const current = kids.filter((k) => k.planKey?.startsWith(round(parent)));
  const byKey = new Map(current.map((k) => [k.planKey!, k]));
  const failed = current.filter((k) => BAD.includes(k.status));
  if (failed.length) {
    const active = current.filter((k) => !FINAL.includes(k.status) && (k.status !== "queued" || store.runs(k.id).length > 0));
    if (active.length) return;
    const evidence = failed.map((k) => `- ${k.planKey}: ${k.status} — ${k.statusReason ?? ""}`).join("\n");
    if (parent.renewals >= LIMITS.renewals) {
      settle(parent.id, "blocked", `parts failed after ${parent.renewals} renewal(s)`);
      openCard({ taskId: parent.id, kind: "blocked", title: `#${parent.id} is stuck after ${parent.renewals} re-plans`, body: evidence, options: [{ id: "retry", label: "Try again" }, { id: "close", label: "Close it" }], allowText: true });
      return;
    }
    for (const k of current) if (!FINAL.includes(k.status)) settle(k.id, "cancelled", "the plan was renewed");
    store.patchTask(parent.id, { renewals: parent.renewals + 1 });
    store.transition(parent.id, "any", "queued", {}, `re-planning (renewal ${parent.renewals + 1})`);
    store.enqueue(parent.id, "start", { chair: true, evidence: `Earlier plan results:\n${evidence}` }, `renew:${parent.id}:${parent.renewals + 1}`);
    kick();
    return;
  }
  const ready = current.filter((k) => k.status === "queued" && k.dependsOn.every((d) => byKey.get(d)?.status === "done"));
  for (const k of ready) store.enqueue(k.id, "start", {}, `start:${k.id}`);
  if (ready.length) kick();
  if (current.length && current.every((k) => k.status === "done")) {
    const result = current.map((k) => `## ${k.planKey!.split(":")[1]}\n${k.result ?? "(no answer)"}`).join("\n\n");
    store.patchTask(parent.id, { result });
    store.transition(parent.id, "any", "queued", {}, "all parts done; verifying");
    store.enqueue(parent.id, "verify", {}, `verify:${parent.id}:${parent.renewals}`);
    kick();
  }
}
