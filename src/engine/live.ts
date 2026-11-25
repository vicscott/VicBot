import type { HarnessRun } from "../harness/types";

/** The process handles of runs in flight, by task. A parked or ended run holds none. */
export const live = new Map<string, HarnessRun>();

/** Tasks whose current run was stopped on purpose; the loop must not read that run as a failure. */
export const interrupted = new Set<string>();

export function killRun(taskId: string): boolean {
  const handle = live.get(taskId);
  if (!handle) return false;
  interrupted.add(taskId);
  handle.kill();
  return true;
}
