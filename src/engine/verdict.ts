import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { LIMITS } from "../config";
import { DECISIONS, EFFORTS, ROUTES, type Brief, type PlanItem, type Verdict, type VerdictSource } from "../types";

export const VERDICT_PATH = ".vicbot/verdict.json";

const cap = (v: unknown, n: number): string | undefined => (typeof v === "string" && v.trim() ? v.trim().slice(0, n) : undefined);
const list = (v: unknown, n: number, each = 300): string[] => (Array.isArray(v) ? v.filter((x) => typeof x === "string").slice(0, n).map((x: string) => x.slice(0, each)) : []);

export function parseBrief(v: unknown): Brief | undefined {
  if (!v || typeof v !== "object") return undefined;
  const b = v as Record<string, unknown>;
  const goal = cap(b.goal, 600);
  if (!goal) return undefined;
  const brief: Brief = {
    goal,
    done_when: cap(b.done_when, 400) ?? "",
    constraints: list(b.constraints, 10, 200),
    artifacts: list(b.artifacts, 10, 200),
    tried: list(b.tried, 10, 200),
    open_questions: list(b.open_questions, 10, 200),
  };
  while (JSON.stringify(brief).length > LIMITS.briefChars) {
    const longest = (["tried", "open_questions", "constraints", "artifacts"] as const).find((k) => brief[k].length);
    if (!longest) {
      brief.goal = brief.goal.slice(0, Math.max(100, brief.goal.length - 200));
      brief.done_when = brief.done_when.slice(0, 200);
      break;
    }
    brief[longest].pop();
  }
  return brief;
}

function parsePlan(v: unknown): PlanItem[] | undefined {
  if (!Array.isArray(v)) return undefined;
  return v.slice(0, LIMITS.planChildren + 2).flatMap((x): PlanItem[] => {
    const p = (x ?? {}) as Record<string, unknown>;
    const key = cap(p.key, 24);
    const goal = cap(p.goal, 1200);
    if (!key || !goal) return [];
    const route = ROUTES.includes(p.route as never) ? (p.route as PlanItem["route"]) : "explore";
    const effort = EFFORTS.includes(p.effort as never) ? (p.effort as PlanItem["effort"]) : "standard";
    return [{ key, goal, route, effort, dependsOn: list(p.dependsOn, 6, 24), artifacts: list(p.artifacts, 10, 200) }];
  });
}

/** Validates and caps every field. Returns null when the decision or reason is missing. */
export function normalize(raw: unknown): Verdict | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  if (!DECISIONS.includes(v.decision as never)) return null;
  const reason = cap(v.reason, LIMITS.verdictReason);
  if (!reason) return null;
  const out: Verdict = { decision: v.decision as Verdict["decision"], reason };
  const ask = cap(v.ask, LIMITS.verdictAsk);
  if (ask) out.ask = ask;
  const brief = parseBrief(v.brief);
  if (brief) out.brief = brief;
  if (ROUTES.includes(v.route as never)) out.route = v.route as Verdict["route"];
  if (Array.isArray(v.findings))
    out.findings = v.findings.slice(0, LIMITS.findings).map((f) => {
      const r = (f ?? {}) as Record<string, unknown>;
      return { title: cap(r.title, 200) ?? "", severity: cap(r.severity, 20) ?? "info", evidence: cap(r.evidence, 600) ?? "" };
    });
  if (Array.isArray(v.remember))
    out.remember = v.remember.slice(0, 10).flatMap((m) => {
      const r = (m ?? {}) as Record<string, unknown>;
      const key = cap(r.key, 48);
      const text = cap(r.text, 2000);
      return key && text ? [{ key, text, scope: r.scope === "long" ? ("long" as const) : ("short" as const), subject: cap(r.subject, 48) }] : [];
    });
  const wake = v.wake as Record<string, unknown> | undefined;
  if (wake && typeof wake.afterMinutes === "number" && wake.afterMinutes > 0) out.wake = { afterMinutes: Math.min(wake.afterMinutes, 7 * 24 * 60), note: cap(wake.note, 500) ?? "follow up" };
  const plan = parsePlan(v.plan);
  if (plan?.length) out.plan = plan;
  const policy = cap(v.policy, 4000);
  if (policy) out.policy = policy;
  if (out.decision === "human" && !out.ask) out.ask = out.reason.slice(0, LIMITS.verdictAsk);
  return out;
}

export function verdictFile(cwd: string): string {
  return join(resolve(cwd), VERDICT_PATH);
}

/** Removes a stale verdict before a run starts, so only this run's file counts. */
export function clearVerdict(cwd: string): void {
  const file = verdictFile(cwd);
  mkdirSync(join(resolve(cwd), ".vicbot"), { recursive: true });
  if (existsSync(file)) rmSync(file);
}

export function readVerdict(cwd: string, since: number, finalText: string | null): { verdict: Verdict | null; source: VerdictSource; note?: string } {
  const file = verdictFile(cwd);
  if (existsSync(file) && statSync(file).mtimeMs >= since - 1000) {
    try {
      const v = normalize(JSON.parse(readFileSync(file, "utf8")));
      if (v) return { verdict: v, source: "file" };
      return fromTag(finalText, "verdict.json was invalid");
    } catch {
      return fromTag(finalText, "verdict.json was not JSON");
    }
  }
  return fromTag(finalText, "no verdict.json");
}

function fromTag(text: string | null, why: string): { verdict: Verdict | null; source: VerdictSource; note?: string } {
  const matches = [...(text ?? "").matchAll(/<verdict>([\s\S]*?)<\/verdict>/g)];
  const last = matches.at(-1)?.[1];
  if (last) {
    try {
      const v = normalize(JSON.parse(last.trim()));
      if (v) return { verdict: v, source: "tag", note: `${why}; used the <verdict> tag` };
    } catch {}
  }
  return { verdict: null, source: "missing", note: why };
}

/** Strips the verdict tag from text shown to the person. */
export function stripVerdict(text: string): string {
  return text.replace(/<verdict>[\s\S]*?<\/verdict>/g, "").trim();
}
