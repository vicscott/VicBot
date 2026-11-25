import { BOUNDS } from "../config";
import type { Budget, Effort, Task } from "../types";

export type Reserve = Budget;

export function remaining(root: Task): Budget {
  return {
    toolCalls: root.budget.toolCalls - root.used.toolCalls,
    minutes: root.budget.minutes - root.used.minutes,
    cost: root.budget.cost - root.used.cost,
  };
}

/** What one run may spend: its effort ceiling, capped by what the root has left. */
export function reserve(root: Task, effort: Effort): Reserve | null {
  const left = remaining(root);
  if (left.toolCalls <= 0 || left.minutes <= 0.05 || left.cost <= 0) return null;
  const cap = BOUNDS[effort];
  return {
    toolCalls: Math.max(1, Math.min(cap.toolCalls, left.toolCalls)),
    minutes: Math.max(0.5, Math.min(cap.minutes, left.minutes)),
    cost: Math.min(cap.cost, left.cost),
  };
}

export function charge(root: Task, spent: Budget): Budget {
  return {
    toolCalls: root.used.toolCalls + spent.toolCalls,
    minutes: Math.round((root.used.minutes + spent.minutes) * 100) / 100,
    cost: Math.round((root.used.cost + spent.cost) * 10000) / 10000,
  };
}
