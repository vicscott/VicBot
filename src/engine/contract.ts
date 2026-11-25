import type { Check, Contract, Effort, Route } from "../types";

const FILE = /(?:^|[\s`'"(])((?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)*\.[a-z0-9]{1,6})(?=$|[\s`'"),:;])/gi;
const WRITE_VERB = /\b(write|create|add|save|generate|produce|fix|update|edit|change|implement|refactor)\b|(写|创建|生成|保存|修改|修复|实现)/i;

/**
 * The automatic contract: named output files for build work, and an independent review for
 * standard and deep efforts. The quick path adds no extra model call.
 */
export function propose(goal: string, route: Route | null, effort: Effort): Contract {
  const artifacts: string[] = [];
  if (route === "build" && WRITE_VERB.test(goal)) {
    for (const m of goal.matchAll(FILE)) {
      const p = m[1]!;
      if (/^\d+\.\d+/.test(p) || /^(e\.g|i\.e|etc)\./i.test(p) || p.includes("://")) continue;
      if (!artifacts.includes(p)) artifacts.push(p);
      if (artifacts.length >= 8) break;
    }
  }
  const acceptance: Check[] = effort === "quick" ? [] : [{ id: "review", kind: "judge", rubric: "The answer or change does what the goal asks, with evidence. Do not fail on style." }];
  return { acceptance, constraints: [], artifacts };
}

function str(v: unknown, field: string, max = 500): string {
  if (typeof v !== "string" || !v.trim()) throw new Error(`${field} must be a non-empty string`);
  if (v.length > max) throw new Error(`${field} is longer than ${max} characters`);
  return v.trim();
}

/** Validates a contract edited by a person or proposed by a run. */
export function validateContract(raw: unknown): Contract {
  if (!raw || typeof raw !== "object") throw new Error("contract must be an object");
  const c = raw as Record<string, unknown>;
  const ids = new Set<string>();
  const acceptance = ((c.acceptance as unknown[] | undefined) ?? []).map((x, i): Check => {
    const k = x as Record<string, unknown>;
    const id = str(k.id ?? `c${i + 1}`, "check id", 40);
    if (ids.has(id)) throw new Error(`duplicate check id ${id}`);
    ids.add(id);
    const timeoutSec = typeof k.timeoutSec === "number" ? Math.min(900, Math.max(1, k.timeoutSec)) : undefined;
    switch (k.kind) {
      case "cmd":
      case "test":
        return { id, kind: k.kind, cmd: str(k.cmd, `${id}.cmd`), timeoutSec };
      case "file":
        return { id, kind: "file", path: str(k.path, `${id}.path`, 300), contains: typeof k.contains === "string" && k.contains ? k.contains.slice(0, 300) : undefined };
      case "judge":
        return { id, kind: "judge", rubric: str(k.rubric, `${id}.rubric`, 1000) };
      case "human":
        return { id, kind: "human", ask: str(k.ask, `${id}.ask`, 500) };
      default:
        throw new Error(`${id}: unknown check kind ${String(k.kind)}`);
    }
  });
  if (acceptance.length > 12) throw new Error("at most 12 checks");
  const list = (v: unknown, field: string, max: number) => {
    if (v === undefined) return [];
    if (!Array.isArray(v)) throw new Error(`${field} must be a list`);
    if (v.length > max) throw new Error(`${field}: at most ${max} entries`);
    return v.map((x, i) => str(x, `${field}[${i}]`, 300));
  };
  return { acceptance, constraints: list(c.constraints, "constraints", 20), artifacts: list(c.artifacts, "artifacts", 20) };
}
