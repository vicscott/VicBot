import { BOUNDS, LIMITS } from "../config";
import type { Rendered } from "../templates";
import type { Note, PromptKind, Task } from "../types";
import { instructions, manifest, progress } from "../wake/memory";
import { fitContext, type Section } from "./budget";
import { envelope } from "./envelope";

/** The harness-neutral context for one turn. `stable` never contains ids or the clock. */
export interface Bundle {
  kind: PromptKind;
  stable: string;
  task: string;
  memory: string;
  volatile: string;
  ask: string;
  cut: string[];
  templateHash: string;
}

export interface BundleInput {
  task: Task;
  template: Rendered;
  kind: PromptKind;
  ask: string;
  notes?: Note[];
  extra?: { name: string; text: string; source?: string }[];
  lastResult?: string | null;
  remaining?: { toolCalls: number; minutes: number };
}

function ago(ms: number): string {
  const m = Math.round(ms / 60000);
  return m < 60 ? `${m} min` : m < 2880 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
}

function checksText(task: Task): string {
  if (!task.contract.acceptance.length) return "- none named; the gate still needs a pass verdict" + (task.contract.artifacts.length ? " and a changed artifact" : "");
  return task.contract.acceptance
    .map((c) => {
      switch (c.kind) {
        case "cmd":
        case "test":
          return `- ${c.id} (${c.kind}): \`${c.cmd}\` must exit 0`;
        case "file":
          return `- ${c.id} (file): ${c.path} exists${c.contains ? ` and contains "${c.contains}"` : ""}`;
        case "judge":
          return `- ${c.id} (independent review): ${c.rubric.slice(0, 200)}`;
        case "human":
          return `- ${c.id} (person): ${c.ask}`;
      }
    })
    .join("\n");
}

/** The task block: per task, unchanged between turns unless the person edits the contract. */
export function taskBlock(task: Task): string {
  const lines = [
    "# Task",
    envelope("person", "goal", task.goal, 6000),
    "",
    `Route: ${task.route ?? "unrouted"} · effort: ${task.effort} · shape: ${task.shape} · trust: ${task.trust}`,
    `Run ceiling: ${BOUNDS[task.effort].toolCalls} tool calls, ${BOUNDS[task.effort].minutes} min.`,
    "",
    "## Done when",
    checksText(task),
  ];
  if (task.contract.artifacts.length) lines.push("", "## Artifacts (must change or be created)", ...task.contract.artifacts.map((a) => `- ${a}`));
  if (task.contract.constraints.length) lines.push("", "## Constraints", ...task.contract.constraints.map((c) => `- ${c}`));
  return lines.join("\n");
}

export function buildBundle(input: BundleInput): Bundle {
  const { task, template } = input;
  const now = Date.now();
  const mem = [manifest().trim(), instructions().trim()].filter(Boolean).join("\n\n");
  const sections: Section[] = [];
  if (input.kind !== "delta") {
    const prog = progress(task.id).trim();
    if (prog) sections.push({ name: "progress", text: `## Progress so far\n${prog}`, cutOrder: 3, keep: "tail" });
  }
  if (input.kind === "recovery") {
    sections.push({ name: "recovery", text: "## Recovery\nThe previous session was lost. You start fresh: rely on the progress above and the files in the working root, and do not assume earlier tool output." });
    if (input.lastResult) sections.push({ name: "last-result", text: `## Last answer\n${envelope("previous-run", "last", input.lastResult, LIMITS.reworkAnswerChars)}`, cutOrder: 2, keep: "head" });
  }
  for (const x of input.extra ?? []) sections.push({ name: x.name, text: x.source ? envelope(x.source, x.name, x.text, LIMITS.reworkFailureChars) : x.text, cutOrder: x.source ? 1 : undefined, keep: "head" });
  const notes = input.notes ?? [];
  if (notes.length) sections.push({ name: "notes", text: `## Messages from the person since the last turn\n${notes.map((n) => envelope("person", n.id, n.text)).join("\n")}` });
  const rem = input.remaining;
  sections.push({
    name: "clock",
    text: `## Now\n${new Date(now).toISOString()} · task opened ${ago(now - task.createdAt)} ago${rem ? ` · budget left: ${rem.toolCalls} tool calls, ${Math.round(rem.minutes)} min` : ""} · trust: ${task.trust}`,
  });
  const fitted = fitContext([{ name: "memory", text: mem, cutOrder: 0, keep: "head" }, ...sections], LIMITS.contextChars);
  const [memSection, ...rest] = fitted.sections;
  return {
    kind: input.kind,
    stable: template.text,
    task: taskBlock(task),
    memory: memSection!.text ? `# Memory (index)\n${memSection!.text}` : "",
    volatile: rest.map((s) => s.text).filter(Boolean).join("\n\n"),
    ask: input.ask,
    cut: fitted.cut,
    templateHash: template.hash,
  };
}
