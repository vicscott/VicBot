import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Budget, Effort, Route, Trust } from "./types";

export const ROOT = resolve(import.meta.dir, "..");
export const HOME = process.env.VICBOT_HOME ?? join(homedir(), ".vicbot");
export const DB_PATH = join(HOME, "vicbot-v1.db");
export const MEMORY_DIR = join(HOME, "memory");
export const WORK_DIR = join(HOME, "work");
export const SESSION_DIR = join(HOME, "sessions");
export const CONTEXT_DIR = join(HOME, "context");
export const HARNESS_DIR = process.env.VICBOT_HARNESS_DIR ?? join(ROOT, "harnesses");
export const TEMPLATE_DIR = join(ROOT, "templates");

export const HOST = process.env.VICBOT_HOST ?? "127.0.0.1";
export const PORT = Number(process.env.VICBOT_PORT ?? 7420);
export const EXTRA_HOSTS = (process.env.VICBOT_ALLOWED_HOSTS ?? "").split(",").filter(Boolean);

/** Per-run ceilings by effort (§13 Bounds). A root task owns one budget of the same size. */
export const BOUNDS: Record<Effort, Budget> = {
  quick: { toolCalls: 15, minutes: 3, cost: 0.5 },
  standard: { toolCalls: 80, minutes: 15, cost: 3 },
  deep: { toolCalls: 300, minutes: 60, cost: 12 },
};

export const LIMITS = {
  sameCall: 3,
  sameError: 3,
  failingSteps: 4,
  handoffHops: 2,
  briefChars: 1500,
  reworkFailureChars: 4000,
  reworkAnswerChars: 1200,
  reworksPerCheck: 1,
  renewals: 2,
  planChildren: 6,
  verdictReason: 2000,
  verdictAsk: 1000,
  findings: 50,
  stableChars: 1500,
  envelopeChars: 4000,
  contextChars: 24000,
  progressChars: 3000,
  concurrency: Number(process.env.VICBOT_CONCURRENCY ?? 3),
  checkTimeoutSec: 120,
};

/** Below this router confidence the task waits in needs_route with a card. */
export const ROUTE_THRESHOLD = 0.5;

/** Starting trust per route. operate starts at workspace; full is granted by the person. */
export const DEFAULT_TRUST: Record<Route, Trust> = { explore: "read", build: "workspace", operate: "workspace" };

export const TIMERS = { tickMs: 5000, keeperEveryMinutes: 24 * 60, pairCodeMs: 5 * 60_000 };

export const TEMPLATE_TUNING = {
  minRuns: 10,
  minFailures: 3,
  trialEvery: 4,
  trialRuns: 8,
  promoteMargin: 0.1,
  maxPolicyChars: 1200,
  maxChangedLines: 4,
};
