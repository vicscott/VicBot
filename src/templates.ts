import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { TEMPLATE_DIR, TEMPLATE_TUNING } from "./config";
import { db } from "./store";
import type { Role, TemplateRow } from "./types";

export const ROLES: Role[] = ["explore", "build", "operate", "verify", "chair", "tune"];

interface Source {
  role: Role;
  protocol: string;
  policy: string;
}

export interface Rendered {
  role: Role;
  version: number;
  hash: string;
  text: string;
}

export function hashText(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex").slice(0, 12);
}

function section(md: string, name: string): string {
  const m = new RegExp(`^## ${name}\\s*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(md);
  return (m?.[1] ?? "").trim();
}

export function readSource(role: Role, dir = TEMPLATE_DIR): Source {
  const md = readFileSync(join(dir, `${role}.md`), "utf8").replace(/^---[\s\S]*?---\n/, "");
  return { role, protocol: section(md, "Protocol"), policy: section(md, "Policy") };
}

export function commonProtocol(dir = TEMPLATE_DIR): string {
  return readFileSync(join(dir, "protocol.md"), "utf8").trim();
}

/** The stable prefix for a role. No ids, no clock: the same version renders the same bytes. */
export function render(row: TemplateRow, common = commonProtocol()): string {
  return `ROLE: ${row.role}\n\n${common}\n\n## Role protocol\n${row.protocol}\n\n## Policy (v${row.version})\n${row.policy}\n`;
}

/**
 * Freezes generation 1 on first boot. Later edits to templates/*.md do not change v1; they are reported
 * so a developer can start a new generation on purpose (`vic templates reseed`).
 */
export function seedTemplates(dir = TEMPLATE_DIR): string[] {
  const warnings: string[] = [];
  const store = db();
  const roles = new Set(readdirSync(dir).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)));
  for (const role of ROLES) {
    if (!roles.has(role)) {
      warnings.push(`templates/${role}.md is missing`);
      continue;
    }
    const src = readSource(role, dir);
    const rows = store.templates(role);
    if (rows.length === 0) {
      const row: TemplateRow = { role, version: 1, status: "active", protocol: src.protocol, policy: src.policy, hash: "", parent: null, runs: 0, passes: 0, createdAt: Date.now(), note: "generation 1" };
      row.hash = hashText(render(row));
      store.putTemplate(row);
      continue;
    }
    const v1 = rows[0]!;
    if (v1.protocol !== src.protocol || v1.policy !== src.policy) warnings.push(`templates/${role}.md differs from frozen v1 (${v1.hash}); using the stored versions`);
  }
  return warnings;
}

/** Starts a new generation from the files: retires every stored version and freezes the files as the next version. */
export function reseed(role: Role, dir = TEMPLATE_DIR): TemplateRow {
  const store = db();
  const rows = store.templates(role);
  for (const r of rows) if (r.status !== "retired") store.putTemplate({ ...r, status: "retired" });
  const src = readSource(role, dir);
  const row: TemplateRow = { role, version: (rows.at(-1)?.version ?? 0) + 1, status: "active", protocol: src.protocol, policy: src.policy, hash: "", parent: null, runs: 0, passes: 0, createdAt: Date.now(), note: "reseeded from file" };
  row.hash = hashText(render(row));
  store.putTemplate(row);
  return row;
}

const picks = new Map<Role, number>();

/** The active version, except every Nth run goes to a candidate on trial. */
export function pick(role: Role): Rendered {
  const rows = db().templates(role);
  const active = rows.find((r) => r.status === "active");
  if (!active) throw new Error(`no active template for ${role}`);
  const candidate = rows.find((r) => r.status === "candidate");
  const n = (picks.get(role) ?? 0) + 1;
  picks.set(role, n);
  const row = candidate && n % TEMPLATE_TUNING.trialEvery === 0 ? candidate : active;
  return { role, version: row.version, hash: row.hash, text: render(row) };
}

export function score(role: Role, version: number, ok: boolean): void {
  const store = db();
  const row = store.templates(role).find((r) => r.version === version);
  if (!row || row.status === "retired") return;
  row.runs += 1;
  if (ok) row.passes += 1;
  store.putTemplate(row);
  if (row.status === "candidate" && row.runs >= TEMPLATE_TUNING.trialRuns) decide(role);
}

function rate(r: TemplateRow): number {
  return r.runs ? r.passes / r.runs : 0;
}

/** Promotes a candidate that beats the active version by the margin; otherwise retires it. */
export function decide(role: Role): "promoted" | "retired" | null {
  const store = db();
  const rows = store.templates(role);
  const active = rows.find((r) => r.status === "active");
  const cand = rows.find((r) => r.status === "candidate");
  if (!active || !cand) return null;
  const win = rate(cand) >= rate(active) + TEMPLATE_TUNING.promoteMargin;
  if (win) {
    store.putTemplate({ ...active, status: "retired" });
    store.putTemplate({ ...cand, status: "active" });
  } else store.putTemplate({ ...cand, status: "retired" });
  store.ledger({ taskId: null, runId: null, action: win ? "template.promote" : "template.retire", initiator: "keeper", device: null, detail: { role, version: cand.version, candidate: rate(cand), active: rate(active) } });
  return win ? "promoted" : "retired";
}

function changedLines(a: string, b: string): number {
  const left = a.split("\n").map((l) => l.trim()).filter(Boolean);
  const right = b.split("\n").map((l) => l.trim()).filter(Boolean);
  const ls = new Set(left);
  const rs = new Set(right);
  return Math.max(right.filter((l) => !ls.has(l)).length, left.filter((l) => !rs.has(l)).length);
}

/**
 * Registers a tuned policy as a candidate. Only the policy may change; the protocol is copied from the
 * active version, and the change must stay small.
 */
export function propose(role: Role, policy: string, note: string): TemplateRow {
  const store = db();
  const rows = store.templates(role);
  const active = rows.find((r) => r.status === "active");
  if (!active) throw new Error(`no active template for ${role}`);
  if (rows.some((r) => r.status === "candidate")) throw new Error(`${role} already has a candidate on trial`);
  const text = policy.trim();
  if (!text) throw new Error("empty policy");
  if (text.length > TEMPLATE_TUNING.maxPolicyChars) throw new Error(`policy longer than ${TEMPLATE_TUNING.maxPolicyChars} characters`);
  if (/^##\s/m.test(text) || /<\/?verdict>|verdict\.json/i.test(text)) throw new Error("policy may not contain headings or protocol text");
  const changed = changedLines(active.policy, text);
  if (changed === 0) throw new Error("policy is unchanged");
  if (changed > TEMPLATE_TUNING.maxChangedLines) throw new Error(`policy changes ${changed} lines; at most ${TEMPLATE_TUNING.maxChangedLines} allowed`);
  const row: TemplateRow = { role, version: (rows.at(-1)?.version ?? 0) + 1, status: "candidate", protocol: active.protocol, policy: text, hash: "", parent: active.version, runs: 0, passes: 0, createdAt: Date.now(), note: note.slice(0, 300) };
  row.hash = hashText(render(row));
  store.putTemplate(row);
  store.ledger({ taskId: null, runId: null, action: "template.propose", initiator: "keeper", device: null, detail: { role, version: row.version, parent: active.version, changed } });
  return row;
}
