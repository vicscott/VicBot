import { existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_TUNING } from "../config";
import { createTask } from "../engine/create";
import { openCard } from "../engine/host";
import { db } from "../store";
import { ROLES } from "../templates";
import { FINAL, type Role } from "../types";
import { kick } from "./kick";
import { archiveShort, longNotes, memoryDir, rebuildManifest, safe, shortTasks, writeAtomic } from "./memory";

const ARCHIVE_AFTER_MS = 14 * 24 * 60 * 60_000;

export function archiveNote(key: string): boolean {
  const from = join(memoryDir(), "long", "notes", `${safe(key)}.md`);
  if (!existsSync(from)) return false;
  mkdirSync(join(memoryDir(), "archive"), { recursive: true });
  renameSync(from, join(memoryDir(), "archive", `note-${safe(key)}-${Date.now()}.md`));
  rebuildManifest();
  return true;
}

export interface KeeperReport {
  archived: string[];
  contradictions: string[];
  tuning: string[];
  manifestChars: number;
}

/**
 * The keeper's contract is mechanical: archive (never delete) finished short memory, rebuild the
 * manifest, surface contradictions as cards, and start template tuning when the evidence says so.
 */
export function runKeeper(now = Date.now()): KeeperReport {
  const store = db();
  const report: KeeperReport = { archived: [], contradictions: [], tuning: [], manifestChars: 0 };
  for (const { taskId, mtime } of shortTasks()) {
    const task = store.task(taskId);
    if (task && FINAL.includes(task.status) && now - mtime > ARCHIVE_AFTER_MS && archiveShort(taskId)) report.archived.push(taskId);
  }
  const bySubject = new Map<string, { key: string; text: string }[]>();
  for (const n of longNotes()) bySubject.set(n.subject, [...(bySubject.get(n.subject) ?? []), { key: n.key, text: n.text }]);
  const openTitles = new Set(store.cards({ open: true }).map((c) => c.title));
  for (const [subject, notes] of bySubject) {
    if (notes.length < 2 || new Set(notes.map((n) => n.text)).size < 2) continue;
    const title = `Memory disagrees about "${subject}"`;
    report.contradictions.push(subject);
    if (openTitles.has(title)) continue;
    openCard({
      taskId: null,
      kind: "contradiction",
      title,
      body: `${notes.map((n) => `- ${n.key}: ${n.text.slice(0, 200)}`).join("\n")}\nKeep one; the others move to archive/.\n${JSON.stringify(notes.map((n) => n.key))}`,
      options: notes.map((n) => ({ id: n.key, label: `Keep ${n.key}` })),
      allowText: false,
    });
  }
  report.manifestChars = rebuildManifest().length;
  for (const role of ROLES.filter((r): r is Role => r !== "tune")) {
    const rows = store.templates(role);
    const active = rows.find((r) => r.status === "active");
    if (!active || rows.some((r) => r.status === "candidate")) continue;
    const failures = active.runs - active.passes;
    if (active.runs < TEMPLATE_TUNING.minRuns || failures < TEMPLATE_TUNING.minFailures) continue;
    const already = store.tasks(200).some((t) => t.role === "tune" && t.meta.tuneRole === role && !FINAL.includes(t.status));
    if (already) continue;
    const reasons = store
      .ledgerRows(undefined, 400)
      .filter((l) => (l.action === "task.failed" || l.action === "task.blocked") && l.taskId !== null && store.task(l.taskId)?.role === role)
      .slice(0, 12)
      .map((l) => `- ${String(l.detail.reason ?? "").slice(0, 200)}`);
    const task = createTask({
      goal: `Tune the "${role}" policy (v${active.version}, ${active.passes}/${active.runs} passed).\n\nCurrent policy:\n${active.policy}\n\nRecent failure reasons:\n${reasons.join("\n") || "- none recorded"}\n\nReturn the whole revised policy. Change at most ${TEMPLATE_TUNING.maxChangedLines} lines and keep it under ${TEMPLATE_TUNING.maxPolicyChars} characters.`,
      title: `Tune ${role} policy v${active.version}`,
      route: "explore",
      effort: "quick",
      role: "tune",
      trust: "read",
      mode: "unattended",
      meta: { tuneRole: role },
    });
    store.enqueue(task.id, "start", { initiator: "keeper" }, `start:${task.id}`);
    report.tuning.push(role);
  }
  writeAtomic(join(memoryDir(), "keeper-report.md"), `# Keeper report ${new Date(now).toISOString()}\n\n${JSON.stringify(report, null, 2)}\n`);
  store.ledger({ taskId: null, runId: null, action: "keeper.run", initiator: "keeper", device: null, detail: { ...report } });
  if (report.tuning.length) kick();
  return report;
}
