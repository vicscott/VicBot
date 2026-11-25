import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONTEXT_DIR } from "../config";
import type { VEvent } from "../types";
import { drive, spawnJsonl, summarize } from "./proc";
import type { Adapter, HarnessRun, Manifest, RunSpec } from "./types";

const READ_TOOLS = "read,ls,grep,find";
const EDIT_TOOLS = "read,bash,edit,write,ls,grep,find";

/** pi and omp share the same JSON event family. */
export function piFamilyParser(onSession: (id: string) => void) {
  return (line: Record<string, unknown>): VEvent[] => {
    switch (line.type) {
      case "session":
        if (typeof line.id === "string") {
          onSession(line.id);
          return [{ kind: "session", id: line.id, state: "live" }];
        }
        return [];
      case "message_end": {
        const msg = line.message as Record<string, unknown> | undefined;
        if (!msg || msg.role !== "assistant") return [];
        const out: VEvent[] = [];
        for (const block of (msg.content as Record<string, unknown>[] | undefined) ?? []) {
          if (block.type === "text" && typeof block.text === "string" && block.text.trim()) out.push({ kind: "text", text: block.text });
          if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.trim()) out.push({ kind: "thinking", text: block.thinking });
        }
        const u = msg.usage as Record<string, unknown> | undefined;
        if (u) {
          const cacheRead = Number(u.cacheRead ?? 0);
          const input = Number(u.input ?? 0) + cacheRead + Number(u.cacheWrite ?? 0);
          const cost = Number((u.cost as Record<string, unknown> | undefined)?.total ?? 0);
          out.push({ kind: "usage", input, output: Number(u.output ?? 0), cacheRead, cost });
        }
        if (msg.stopReason === "error" && typeof msg.errorMessage === "string") out.push({ kind: "error", text: msg.errorMessage });
        return out;
      }
      case "tool_execution_start":
        return [{ kind: "tool", id: String(line.toolCallId), name: String(line.toolName), input: summarize(line.args), phase: "start" }];
      case "tool_execution_end": {
        const ok = line.isError !== true;
        return [{ kind: "tool", id: String(line.toolCallId), name: String(line.toolName), input: "", phase: "end", ok, error: ok ? undefined : summarize(line.result, 300) }];
      }
      default:
        return [];
    }
  };
}

export function systemFile(spec: RunSpec): string | null {
  if (!spec.system) return null;
  mkdirSync(CONTEXT_DIR, { recursive: true });
  const file = join(CONTEXT_DIR, `${spec.runId}.md`);
  writeFileSync(file, spec.system);
  return file;
}

export function piArgv(cmd: string[], spec: RunSpec, file: string | null): string[] {
  const argv = [...cmd, "-p", "--mode", "json", "--session-dir", spec.sessionDir, "--thinking", spec.policy.thinking];
  if (spec.resume) argv.push("--session", spec.resume);
  if (spec.policy.tools !== "all") argv.push("--tools", spec.policy.tools === "read" ? READ_TOOLS : EDIT_TOOLS);
  if (file) argv.push("--append-system-prompt", file);
  argv.push(spec.prompt);
  return argv;
}

export function create(manifest: Manifest): Adapter {
  return {
    manifest,
    spawn(spec): HarnessRun {
      let session: string | null = spec.resume;
      mkdirSync(spec.sessionDir, { recursive: true });
      const proc = spawnJsonl(piArgv(manifest.entry.cmd, spec, systemFile(spec)), { cwd: spec.cwd });
      return {
        events: drive(proc, piFamilyParser((id) => (session = id))),
        sessionId: () => session,
        kill: () => proc.kill(),
      };
    },
  };
}
