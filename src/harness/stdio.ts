import type { VEvent } from "../types";
import { spawnJsonl, summarize } from "./proc";
import type { Adapter, HarnessRun, Manifest } from "./types";

const PROTOCOL = "1.2";

/**
 * The JSON-lines loader for third-party harnesses: hello → ready, turn → text|thinking|tool|usage|approval|done.
 * Approvals are denied unless the run holds full trust, and the ledger sees each one through the event stream.
 */
export function create(manifest: Manifest): Adapter {
  return {
    manifest,
    spawn(spec): HarnessRun {
      let session: string | null = spec.resume;
      const proc = spawnJsonl(manifest.entry.cmd, { cwd: spec.cwd, keepStdin: true });
      proc.write(JSON.stringify({ t: "hello", protocol: PROTOCOL, caps: {}, resume: spec.resume }));
      async function* events(): AsyncGenerator<VEvent> {
        let sentTurn = false;
        for await (const raw of proc.lines) {
          const m = raw as Record<string, unknown>;
          switch (m.t) {
            case "ready":
              if (typeof m.session === "string") {
                session = m.session;
                yield { kind: "session", id: m.session, state: "live" };
              }
              if (!sentTurn) {
                sentTurn = true;
                const prompt = spec.system ? `${spec.system}\n\n${spec.prompt}` : spec.prompt;
                proc.write(JSON.stringify({ t: "turn", prompt, tools: [], policy: spec.policy }));
              }
              break;
            case "text":
              yield { kind: "text", text: String(m.d ?? "") };
              break;
            case "thinking":
              yield { kind: "thinking", text: String(m.d ?? "") };
              break;
            case "tool":
              yield { kind: "tool", id: String(m.id), name: String(m.name), input: summarize(m.input), phase: m.phase === "end" ? "end" : "start", ok: m.ok !== false };
              break;
            case "usage":
              yield { kind: "usage", input: Number(m.in ?? 0), output: Number(m.out ?? 0), cacheRead: Number(m.cacheRead ?? 0), cost: Number(m.cost ?? 0) };
              break;
            case "approval": {
              const allow = spec.policy.trust === "full";
              proc.write(JSON.stringify({ t: "decision", id: m.id, allow }));
              yield { kind: "notice", text: `approval ${String(m.tool)}: ${allow ? "allowed (full trust)" : "denied (trust below full)"}` };
              break;
            }
            case "done":
              if (typeof m.text === "string" && m.text) yield { kind: "text", text: m.text };
              proc.kill();
              break;
            case "error":
              yield { kind: "error", text: String(m.message ?? "error") };
              break;
          }
        }
        yield { kind: "exit", code: await proc.exited };
      }
      return { events: events(), sessionId: () => session, kill: () => proc.kill() };
    },
  };
}
