import type { Effort, Route, Trust, VEvent } from "../types";

export type ServeRole = "worker" | "verify" | "chair" | "tune";

export interface ServeRule {
  route?: Route;
  effort?: Effort;
  role?: ServeRole;
}

export interface Manifest {
  id: string;
  name: string;
  protocol: string;
  entry: { kind: "in-process"; module: string; cmd: string[] } | { kind: "stdio"; cmd: string[] };
  probe: string[];
  capabilities: {
    approvals: boolean;
    steering: boolean;
    resume: "cursor" | "none";
    effort: string[];
    sandbox: string[];
    images: boolean;
    /** How the stable context reaches the model: an appended system prompt, or a preamble in the prompt. */
    system: "append" | "preamble";
    /** Has a web search tool the adapter can turn on. */
    web: boolean;
  };
  routes: Route[];
  /** Ordered rules; the first harness (by rank) with a matching rule serves the request. */
  serves: ServeRule[];
  roles: ServeRole[];
  rank: number;
  cost: "subscription" | "api" | "free";
  /** Test-only harnesses load only when named in VICBOT_HARNESSES. */
  test?: boolean;
}

/** Decided by engine/policy.ts; adapters only translate it into flags. */
export interface HarnessPolicy {
  trust: Trust;
  sandbox: "read-only" | "workspace-write" | "danger-full-access";
  tools: "read" | "edit" | "all";
  approvals: "never";
  thinking: "low" | "medium" | "high";
  network: boolean;
  /** Turn on the harness's web search tool. */
  web: boolean;
  maxToolCalls: number;
  maxMinutes: number;
}

export interface RunSpec {
  runId: string;
  cwd: string;
  /** Stable context for harnesses that take an appended system prompt; null for preamble harnesses. */
  system: string | null;
  prompt: string;
  policy: HarnessPolicy;
  resume: string | null;
  sessionDir: string;
}

export interface HarnessRun {
  events: AsyncIterable<VEvent>;
  steer?(text: string): void;
  answer?(id: string, allow: boolean): void;
  sessionId(): string | null;
  kill(): void;
}

export interface Adapter {
  manifest: Manifest;
  spawn(spec: RunSpec): HarnessRun;
}
