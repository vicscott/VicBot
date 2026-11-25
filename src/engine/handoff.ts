import { LIMITS } from "../config";
import { db } from "../store";
import type { Brief, Task, Verdict } from "../types";
import { kick } from "../wake/kick";
import { createTask } from "./create";
import { defaultTrust, lowerTrust } from "./policy";
import { settle } from "./settle";

export function briefText(b: Brief): string {
  const list = (name: string, xs: string[]) => (xs.length ? `\n${name}:\n${xs.map((x) => `- ${x}`).join("\n")}` : "");
  return `${b.goal}${b.done_when ? `\n\nDone when: ${b.done_when}` : ""}${list("Constraints", b.constraints)}${list("Artifacts", b.artifacts)}${list("Already tried", b.tried)}${list("Open questions", b.open_questions)}`;
}

/** Returns why a handoff must be refused, or null when it may go ahead. */
export function refuseHandoff(task: Task, v: Verdict): string | null {
  if (!v.route) return "the verdict names no route";
  if (!v.brief) return "the verdict has no valid brief";
  if (v.route === task.route) return `already on ${v.route}`;
  if (task.visited.length > LIMITS.handoffHops) return `the chain already has ${task.visited.length - 1} hops`;
  if (task.visited.includes(v.route)) return `${v.route} was already visited in this chain`;
  if (task.shape === "designated") return "a designated task does not hand off";
  return null;
}

/** A typed brief becomes a child on the new route. The parent waits; trust never rises. */
export function handoff(task: Task, v: Verdict): void {
  const store = db();
  const refused = refuseHandoff(task, v);
  if (refused) {
    store.event(task.id, null, { kind: "handoff", phase: "failed", route: v.route, reason: refused });
    settle(task.id, "blocked", `handoff refused: ${refused}`);
    return;
  }
  const route = v.route!;
  const brief = v.brief!;
  store.event(task.id, null, { kind: "handoff", phase: "asked", route, reason: v.reason });
  const child = createTask({
    goal: briefText(brief),
    title: `${route}: ${brief.goal.split("\n")[0]!.slice(0, 70)}`,
    route,
    effort: task.effort,
    parent: task,
    cwd: task.cwd,
    trust: lowerTrust(task.ceiling, defaultTrust(route)),
    visited: [...task.visited, route],
    contract: { acceptance: task.contract.acceptance, constraints: brief.constraints, artifacts: brief.artifacts.length ? brief.artifacts : task.contract.artifacts },
  });
  store.event(task.id, null, { kind: "handoff", phase: "accepted", route, taskId: child.id, reason: v.reason });
  store.transition(task.id, "any", "waiting_child", {}, `handed off to #${child.id} (${route})`);
  store.enqueue(child.id, "start", {}, `start:${child.id}`);
  kick();
}
