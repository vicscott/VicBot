import type { VEvent } from "./types";

/** One line of visible progress. `key` lets a tool's end update the line its start opened. */
export interface Step {
  key: string | null;
  text: string;
  tone: "busy" | "ok" | "bad" | "info";
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Tool inputs arrive as JSON that may be cut off, so fields are read with a pattern, not JSON.parse. */
function field(input: string, ...names: string[]): string | null {
  for (const name of names) {
    const m = new RegExp(`"${name}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(input);
    if (m?.[1]) return m[1].replace(/\\n/g, " ").replace(/\\(.)/g, "$1");
  }
  return null;
}

function place(raw: string): string {
  if (/^https?:\/\//i.test(raw)) return clip(raw.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""), 70);
  const parts = raw.split("/").filter(Boolean);
  return clip(parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : raw, 60);
}

function shell(raw: string): string {
  const inner = /^\/bin\/(?:ba|z)?sh\s+-l?c\s+(['"])([\s\S]*)\1$/.exec(raw.trim())?.[2] ?? raw;
  return clip(inner.replace(/\s+/g, " ").trim(), 70);
}

/** A tool call in plain words. Internal bookkeeping (the verdict file, skills) reads as such. */
export function describeTool(name: string, input: string): string {
  const n = name.toLowerCase();
  const path = field(input, "path", "file_path", "file", "url") ?? (n === "edit" && input && !input.startsWith("{") ? input : null);
  if (path?.includes(".vicbot/")) return "Filing its verdict";
  if (path?.startsWith("skill://")) return "Loading a skill";
  if (n.includes("search") && !n.includes("grep")) {
    const q = field(input, "query", "q") ?? (input.startsWith("{") ? "" : input);
    return q ? `Searching the web: “${clip(q, 70)}”` : "Searching the web";
  }
  if (n === "fetch" || n === "web_fetch" || (path && /^https?:/i.test(path))) return `Opening ${place(path ?? field(input, "url") ?? "a page")}`;
  if (n === "read" || n === "read_file" || n === "view") return path ? `Reading ${place(path)}` : "Reading a file";
  if (n === "grep" || n === "rg") return `Searching files for “${clip(field(input, "pattern", "query") ?? "…", 40)}”`;
  if (n === "ls" || n === "glob" || n === "find") return `Looking through ${path ? place(path) : "files"}`;
  if (n === "bash" || n === "shell" || n === "exec" || n === "exec_command") {
    const cmd = field(input, "command", "cmd") ?? input;
    return cmd ? `Running \`${shell(cmd)}\`` : "Running a command";
  }
  if (n === "edit" || n === "apply_patch") return path ? `Editing ${place(path)}` : "Editing files";
  if (n === "write") return path ? `Writing ${place(path)}` : "Writing a file";
  return `Using ${name}`;
}

/** The first line of a reasoning summary, the short headline models emit while they think. */
export function thought(text: string): string {
  const line = text.split("\n").map((l) => l.replace(/[*_#`]/g, "").trim()).find(Boolean) ?? "";
  return clip(line, 90);
}

const RUN: Record<string, (h: string) => string> = {
  work: (h) => `${h} started working`,
  continue: (h) => `${h} picked up your message`,
  rework: (h) => `${h} is fixing what the review found`,
  verdict: (h) => `${h} is wrapping up`,
  verify: (h) => `${h} is reviewing the answer`,
  chair: (h) => `${h} is planning the parts`,
};

/** Turns one event into a visible step, or null for events the person does not need to see. */
export function stepOf(ev: VEvent, runId: string | null = null): Step | null {
  switch (ev.kind) {
    case "run":
      if (ev.phase === "start") return RUN[ev.purpose] ? { key: null, text: RUN[ev.purpose]!(ev.harness), tone: "info" } : null;
      return ev.outcome && /fail|error|crash|lost|limit/i.test(ev.outcome) ? { key: null, text: `${ev.harness} stopped: ${ev.outcome}`, tone: "bad" } : null;
    case "tool": {
      const key = `${runId ?? ""}:${ev.id}`;
      if (ev.phase === "start") return { key, text: describeTool(ev.name, ev.input), tone: "busy" };
      return { key, text: describeTool(ev.name, ev.input), tone: ev.ok === false ? "bad" : "ok" };
    }
    case "verdict":
      return { key: null, text: `Verdict: ${ev.decision}${ev.reason ? ` · ${clip(ev.reason, 90)}` : ""}`, tone: ev.decision === "pass" ? "ok" : ev.decision === "fail" ? "bad" : "info" };
    case "check":
      if (ev.check === "judge") return { key: null, text: ev.ok ? "Review passed" : `Review found problems: ${clip(ev.detail, 100)}`, tone: ev.ok ? "ok" : "bad" };
      return { key: null, text: `${ev.ok ? "Check passed" : "Check failed"}: ${ev.checkId}${ev.ok ? "" : ` · ${clip(ev.detail, 80)}`}`, tone: ev.ok ? "ok" : "bad" };
    case "handoff":
      return ev.phase === "asked" ? null : { key: null, text: ev.phase === "accepted" ? `Handed off${ev.route ? ` to ${ev.route}` : ""}${ev.taskId ? ` as #${ev.taskId}` : ""}` : `Handoff failed: ${clip(ev.reason, 80)}`, tone: ev.phase === "accepted" ? "info" : "bad" };
    case "steer":
      return ev.phase === "read" ? { key: null, text: "Read your message", tone: "ok" } : ev.phase === "queued" ? { key: null, text: "Your message is queued for its next turn", tone: "info" } : null;
    case "notice":
      return /^approval /.test(ev.text) ? null : { key: null, text: clip(ev.text, 140), tone: "info" };
    case "error":
      return { key: null, text: clip(ev.text, 140), tone: "bad" };
    case "limit":
      return { key: null, text: `Hit the ${ev.reason} limit`, tone: "bad" };
    case "session":
      return ev.state === "lost" ? { key: null, text: "Session lost; continuing from its notes", tone: "bad" } : null;
    case "status":
      if (ev.to === "waiting_input") return { key: null, text: "Waiting for your answer", tone: "info" };
      if (ev.to === "needs_route") return { key: null, text: "Waiting for you to pick a route", tone: "info" };
      return null;
    default:
      return null;
  }
}
