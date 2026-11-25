import { db } from "../store";
import type { HarnessPolicy, HarnessRun, RunSpec } from "../harness/types";
import type { Installed } from "../harness/registry";
import type { Run, Session, Task, Usage } from "../types";
import { live } from "./live";
import { LoopGuard } from "./loopguard";

export interface Executed {
  final: string | null;
  toolCalls: number;
  usage: Usage;
  minutes: number;
  limit: { reason: "budget" | "time"; text: string } | null;
  trip: string | null;
  exitCode: number | null;
  spawnError: string | null;
}

export const LEASE_MS = 120_000;

/**
 * Owns one harness process: streams its events into the transcript, enforces the run ceilings and the
 * loop guard at every step, and records the native session id.
 */
export async function execute(task: Task, h: Installed, run: Run, spec: RunSpec, policy: HarnessPolicy, session: Session): Promise<Executed> {
  const store = db();
  const started = Date.now();
  const usage: Usage = { input: 0, output: 0, cacheRead: 0, cost: 0 };
  const out: Executed = { final: null, toolCalls: 0, usage, minutes: 0, limit: null, trip: null, exitCode: null, spawnError: null };
  let handle: HarnessRun;
  try {
    handle = h.adapter.spawn(spec);
  } catch (err) {
    out.spawnError = (err as Error).message;
    store.event(task.id, run.id, { kind: "error", text: `could not start ${h.manifest.id}: ${out.spawnError}` });
    return out;
  }
  live.set(task.id, handle);
  const guard = new LoopGuard();
  const timer = setTimeout(() => {
    out.limit = { reason: "time", text: `the run reached its ${policy.maxMinutes} min ceiling` };
    handle.kill();
  }, policy.maxMinutes * 60_000);
  const lease = setInterval(() => store.renewJob(task.id, LEASE_MS), 30_000);
  try {
    for await (const ev of handle.events) {
      if (ev.kind === "session" && ev.id !== session.nativeId) {
        session.nativeId = ev.id;
        store.putSession({ ...session, state: "live", usedAt: Date.now() });
      }
      if (ev.kind === "text" && ev.text.trim()) out.final = ev.text;
      if (ev.kind === "exit") out.exitCode = ev.code;
      if (ev.kind === "usage") {
        usage.input += ev.input;
        usage.output += ev.output;
        usage.cacheRead += ev.cacheRead;
        usage.cost += ev.cost;
      }
      if (ev.kind === "tool" && ev.phase === "start") {
        out.toolCalls += 1;
        if (out.toolCalls > policy.maxToolCalls && !out.limit) {
          out.limit = { reason: "budget", text: `the run used its ${policy.maxToolCalls} tool calls` };
          handle.kill();
        }
      }
      const trip = guard.observe(ev);
      if (trip && !out.trip && !out.limit) {
        out.trip = trip.reason;
        handle.kill();
      }
      store.event(task.id, run.id, ev);
    }
  } catch (err) {
    store.event(task.id, run.id, { kind: "error", text: `harness stream failed: ${(err as Error).message}` });
  } finally {
    clearTimeout(timer);
    clearInterval(lease);
    live.delete(task.id);
  }
  out.minutes = (Date.now() - started) / 60_000;
  store.putSession({ ...session, usedAt: Date.now() });
  return out;
}
