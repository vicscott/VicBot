import type { VEvent } from "../types";
import { drive, spawnJsonl, summarize } from "./proc";
import type { Adapter, HarnessRun, Manifest, RunSpec } from "./types";

export function codexArgv(cmd: string[], spec: RunSpec): string[] {
  const effort = `model_reasoning_effort="${spec.policy.thinking}"`;
  if (spec.resume) {
    return [...cmd, "exec", "resume", spec.resume, "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${spec.policy.sandbox}"`, "-c", effort, "-"];
  }
  return [...cmd, "exec", "--json", "--skip-git-repo-check", "-s", spec.policy.sandbox, "-c", effort, "-C", spec.cwd, "-"];
}

export function codexParser(onSession: (id: string) => void) {
  const started = new Set<string>();
  const tool = (item: Record<string, unknown>): { name: string; input: string } | null => {
    switch (item.type) {
      case "command_execution":
        return { name: "bash", input: summarize(item.command) };
      case "file_change":
        return { name: "edit", input: summarize(((item.changes as { path?: string }[] | undefined) ?? []).map((c) => c.path).join(", ")) };
      case "mcp_tool_call":
        return { name: `${String(item.server)}.${String(item.tool)}`, input: summarize(item.arguments) };
      case "web_search":
        return { name: "web_search", input: summarize(item.query) };
      default:
        return null;
    }
  };
  return (line: Record<string, unknown>): VEvent[] => {
    const item = line.item as Record<string, unknown> | undefined;
    switch (line.type) {
      case "thread.started":
        if (typeof line.thread_id === "string") {
          onSession(line.thread_id);
          return [{ kind: "session", id: line.thread_id, state: "live" }];
        }
        return [];
      case "item.started": {
        const t = item && tool(item);
        if (!item || !t) return [];
        started.add(String(item.id));
        return [{ kind: "tool", id: String(item.id), name: t.name, input: t.input, phase: "start" }];
      }
      case "item.completed": {
        if (!item) return [];
        if (item.type === "agent_message" && typeof item.text === "string") return [{ kind: "text", text: item.text }];
        if (item.type === "reasoning" && typeof item.text === "string") return [{ kind: "thinking", text: item.text }];
        if (item.type === "error") return [{ kind: "notice", text: String(item.message ?? "error") }];
        const t = tool(item);
        if (!t) return [];
        const id = String(item.id);
        const ok = item.type === "command_execution" ? item.exit_code === 0 : item.status !== "failed";
        const end: VEvent = { kind: "tool", id, name: t.name, input: t.input, phase: "end", ok, error: ok ? undefined : summarize(item.aggregated_output ?? item.status, 300) };
        return started.has(id) ? [end] : [{ kind: "tool", id, name: t.name, input: t.input, phase: "start" }, end];
      }
      case "turn.completed": {
        const u = (line.usage ?? {}) as Record<string, unknown>;
        return [{ kind: "usage", input: Number(u.input_tokens ?? 0), output: Number(u.output_tokens ?? 0), cacheRead: Number(u.cached_input_tokens ?? 0), cost: 0 }];
      }
      case "turn.failed":
        return [{ kind: "error", text: String((line.error as Record<string, unknown> | undefined)?.message ?? "turn failed") }];
      case "error":
        return [{ kind: "error", text: String(line.message ?? "error") }];
      default:
        return [];
    }
  };
}

export function create(manifest: Manifest): Adapter {
  return {
    manifest,
    spawn(spec): HarnessRun {
      let session: string | null = spec.resume;
      const prompt = spec.system ? `${spec.system}\n\n${spec.prompt}` : spec.prompt;
      const proc = spawnJsonl(codexArgv(manifest.entry.cmd, spec), { cwd: spec.cwd, stdin: prompt });
      return {
        events: drive(proc, codexParser((id) => (session = id))),
        sessionId: () => session,
        kill: () => proc.kill(),
      };
    },
  };
}
