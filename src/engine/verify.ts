import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LIMITS } from "../config";
import type { Check, Task } from "../types";

export interface CheckOutcome {
  check: Check;
  ok: boolean;
  detail: string;
}

export async function runCommand(cmd: string, cwd: string, timeoutSec = LIMITS.checkTimeoutSec): Promise<{ ok: boolean; detail: string }> {
  const child = Bun.spawn(["/bin/sh", "-c", cmd], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutSec * 1000);
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  const code = await child.exited;
  clearTimeout(timer);
  const tail = (out + (err ? `\n${err}` : "")).trim().slice(-1500);
  if (timedOut) return { ok: false, detail: `timed out after ${timeoutSec}s\n${tail}` };
  return { ok: code === 0, detail: `exit ${code}${tail ? `\n${tail}` : ""}` };
}

export async function runDeterministic(task: Task, check: Check): Promise<CheckOutcome | null> {
  switch (check.kind) {
    case "cmd":
    case "test": {
      const r = await runCommand(check.cmd, task.cwd, check.timeoutSec);
      return { check, ...r };
    }
    case "file": {
      const path = resolve(task.cwd, check.path);
      if (!existsSync(path)) return { check, ok: false, detail: `${check.path} does not exist` };
      if (check.contains && !readFileSync(path, "utf8").includes(check.contains)) return { check, ok: false, detail: `${check.path} does not contain "${check.contains}"` };
      return { check, ok: true, detail: `${check.path} ok` };
    }
    default:
      return null;
  }
}

export type Reviewer = (check: Extract<Check, { kind: "judge" }>) => Promise<{ ok: boolean; detail: string }>;

/**
 * Deterministic checks first; reviews only when they all pass, so a broken build never costs a review.
 * Human checks are returned for the gate to turn into a card.
 */
export async function verify(task: Task, review: Reviewer): Promise<{ outcomes: CheckOutcome[]; human: Extract<Check, { kind: "human" }>[] }> {
  const outcomes: CheckOutcome[] = [];
  for (const check of task.contract.acceptance) {
    const r = await runDeterministic(task, check);
    if (r) outcomes.push(r);
  }
  if (outcomes.some((o) => !o.ok)) return { outcomes, human: [] };
  for (const check of task.contract.acceptance) {
    if (check.kind !== "judge") continue;
    outcomes.push({ check, ...(await review(check)) });
    if (!outcomes.at(-1)!.ok) return { outcomes, human: [] };
  }
  return { outcomes, human: task.contract.acceptance.filter((c): c is Extract<Check, { kind: "human" }> => c.kind === "human") };
}
