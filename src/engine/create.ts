import { existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { BOUNDS, WORK_DIR } from "../config";
import { db, newId } from "../store";
import type { Contract, Effort, Mode, Role, Route, Shape, Task, Trust } from "../types";
import { propose } from "./contract";
import { defaultTrust } from "./policy";

export interface NewTask {
  goal: string;
  title?: string;
  route: Route | null;
  effort: Effort;
  shape?: Shape;
  designated?: string | null;
  web?: boolean;
  cwd?: string;
  contract?: Contract;
  parent?: Task;
  trust?: Trust;
  ceiling?: Trust;
  planKey?: string | null;
  dependsOn?: string[];
  visited?: Route[];
  role?: Role;
  mode?: Mode;
  meta?: Record<string, string>;
}

export function resolveCwd(cwd: string | undefined, id: string): string {
  if (!cwd) {
    const dir = join(process.env.VICBOT_WORK_DIR ?? WORK_DIR, id);
    mkdirSync(dir, { recursive: true });
    return dir;
  }
  const path = resolve(cwd.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`working directory ${path} does not exist`);
  return path;
}

export function titleOf(goal: string): string {
  const line = goal.trim().split("\n")[0]!.replace(/\s+/g, " ");
  return line.length > 80 ? line.slice(0, 79) + "…" : line || "untitled";
}

/** Root budgets cover the work, one verdict follow-up, one review and one rework. */
const ROOT_FACTOR = 3;

export function createTask(input: NewTask): Task {
  const id = newId("t");
  const parent = input.parent;
  const route = input.route;
  const trust = input.trust ?? (route ? defaultTrust(route) : "read");
  const base = BOUNDS[input.effort];
  const task: Task = {
    id,
    title: input.title ?? titleOf(input.goal),
    goal: input.goal,
    contract: input.contract ?? propose(input.goal, route, input.effort),
    contractTier: input.contract ? "edited" : "auto",
    shape: input.shape ?? "single",
    route,
    effort: input.effort,
    trust,
    ceiling: input.ceiling ?? parent?.ceiling ?? (trust === "full" ? "full" : "workspace"),
    mode: input.mode ?? parent?.mode ?? "interactive",
    role: input.role ?? route ?? "explore",
    status: route ? "queued" : "needs_route",
    statusReason: null,
    rootId: parent?.rootId ?? id,
    parentId: parent?.id ?? null,
    depth: parent ? parent.depth + 1 : 0,
    planKey: input.planKey ?? null,
    dependsOn: input.dependsOn ?? [],
    cwd: input.cwd && parent && input.cwd === parent.cwd ? parent.cwd : resolveCwd(input.cwd, id),
    harness: null,
    designated: input.designated ?? null,
    web: input.web ?? parent?.web ?? false,
    visited: input.visited ?? (route ? [route] : []),
    escalated: false,
    renewals: 0,
    reworks: 0,
    loopTrips: 0,
    meta: input.meta ?? {},
    budget: { toolCalls: base.toolCalls * ROOT_FACTOR, minutes: base.minutes * ROOT_FACTOR, cost: base.cost * ROOT_FACTOR },
    used: { toolCalls: 0, minutes: 0, cost: 0 },
    result: null,
    tokens: 0,
    cacheRead: 0,
    inputTokens: 0,
    cost: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  return db().putTask(task);
}
