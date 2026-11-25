import { join } from "node:path";
import { SESSION_DIR } from "../config";
import type { Installed } from "../harness/registry";
import { db, newId } from "../store";
import type { PromptKind, Session, Task } from "../types";

export interface SessionPlan {
  session: Session;
  resume: string | null;
  kind: PromptKind;
  note?: string;
}

export function sessionDir(task: Task, harness: string): string {
  return join(SESSION_DIR, harness, task.id);
}

/**
 * Strict resume: a live session with a native id resumes and gets a delta. Anything else starts fresh
 * from the recovery block, and the session is marked lost so the person sees that context restarted.
 */
export function strictResume(task: Task, h: Installed, continuing: boolean): SessionPlan {
  const store = db();
  const id = h.manifest.id;
  const existing = store.session(task.id, id);
  const fresh = (): Session => store.putSession({ id: newId("s_"), taskId: task.id, harness: id, nativeId: null, cwd: task.cwd, state: "live", lostReason: null, createdAt: Date.now(), usedAt: Date.now() });
  if (!continuing) return { session: existing && !existing.nativeId ? existing : fresh(), resume: null, kind: "bundle" };
  if (existing?.state === "live" && existing.nativeId && h.manifest.capabilities.resume === "cursor" && existing.cwd === task.cwd) {
    return { session: existing, resume: existing.nativeId, kind: "delta" };
  }
  const reason = !existing
    ? task.harness && task.harness !== id
      ? `harness changed from ${task.harness} to ${id}`
      : "no earlier session on this harness"
    : h.manifest.capabilities.resume === "none"
      ? `${id} cannot resume sessions`
      : existing.cwd !== task.cwd
        ? "working directory changed"
        : (existing.lostReason ?? "no native session id was recorded");
  if (existing && existing.state === "live") store.putSession({ ...existing, state: "lost", lostReason: reason });
  return { session: fresh(), resume: null, kind: "recovery", note: reason };
}
