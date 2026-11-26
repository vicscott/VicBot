import { DEFAULT_TRUST } from "../config";
import { available, type Installed } from "../harness/registry";
import type { HarnessPolicy, ServeRole } from "../harness/types";
import type { Effort, Route, Trust } from "../types";
import { TRUSTS } from "../types";
import type { Reserve } from "./budget";

const SANDBOX: Record<Trust, HarnessPolicy["sandbox"]> = { read: "read-only", workspace: "workspace-write", full: "danger-full-access" };
const TOOLS: Record<Trust, HarnessPolicy["tools"]> = { read: "read", workspace: "edit", full: "all" };
const THINKING: Record<Effort, HarnessPolicy["thinking"]> = { quick: "low", standard: "medium", deep: "high" };

export function defaultTrust(route: Route): Trust {
  return DEFAULT_TRUST[route];
}

/** A handoff or a child may lower trust, never raise it. */
export function lowerTrust(parent: Trust, wanted: Trust): Trust {
  return TRUSTS.indexOf(wanted) < TRUSTS.indexOf(parent) ? wanted : parent;
}

/** The one table that decides sandbox, tools and thinking. Adapters translate it into flags. */
export function policyFor(effort: Effort, trust: Trust, reserve: Reserve, web = false): HarnessPolicy {
  return {
    trust,
    sandbox: SANDBOX[trust],
    tools: TOOLS[trust],
    approvals: "never",
    thinking: THINKING[effort],
    network: trust !== "read",
    web,
    maxToolCalls: reserve.toolCalls,
    maxMinutes: reserve.minutes,
  };
}

function matches(h: Installed, route: Route, effort: Effort, role: ServeRole): boolean {
  return h.manifest.serves.some((rule) => (rule.role ?? "worker") === role && (!rule.route || rule.route === route) && (!rule.effort || rule.effort === effort));
}

/**
 * Picks a harness from the installed manifests: the lowest rank whose `serves` rules match,
 * then any harness that claims the route and role. A task that needs the web prefers harnesses
 * with web search and falls back to the rest. Nothing here names a harness.
 */
export function selectHarness(opts: { route: Route; effort: Effort; role: ServeRole; designated?: string | null; exclude?: string[]; web?: boolean }): Installed | null {
  const pool = available();
  if (opts.designated) return pool.find((h) => h.manifest.id === opts.designated) ?? null;
  const exclude = new Set(opts.exclude ?? []);
  const ranked = pool.filter((h) => h.manifest.roles.includes(opts.role) && h.manifest.routes.includes(opts.route));
  const preferred = ranked.filter((h) => !exclude.has(h.manifest.id));
  const tiers = opts.web ? [preferred.filter((h) => h.manifest.capabilities.web), preferred, ranked] : [preferred, ranked];
  for (const tier of tiers) {
    const pick = tier.find((h) => matches(h, opts.route, opts.effort, opts.role)) ?? tier[0];
    if (pick) return pick;
  }
  return null;
}
