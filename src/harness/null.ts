import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { VEvent } from "../types";
import type { Adapter, HarnessRun, Manifest } from "./types";

/**
 * The degradation harness: zero capabilities, a fixed reply, a verdict tag in its text.
 * Markers in the prompt steer it for tests: `#null:<decision>`, `#null:write=<path>`, `#null:plan`.
 */
export function create(manifest: Manifest): Adapter {
  return {
    manifest,
    spawn(spec): HarnessRun {
      let killed = false;
      const full = spec.prompt + "\n" + (spec.system ?? "");
      const settled = /<external source="person" id="answer-|^## Rework/m.test(full);
      const text = full
        .split("\n")
        .filter((l) => !l.startsWith("This is one part of a larger task"))
        .join("\n")
        .replace(settled ? /#null:(human|rework)\b/g : /(?!)/g, "");
      async function* events(): AsyncGenerator<VEvent> {
        await Bun.sleep(Number(process.env.VICBOT_NULL_DELAY_MS ?? 30));
        if (killed) return void (yield { kind: "exit", code: null });
        const isVerify = /^ROLE: verify$/m.test(text);
        const isChair = /^ROLE: chair$/m.test(text);
        const write = /#null:write=([\w./-]+)/.exec(text)?.[1];
        if (write && !isVerify && !isChair && spec.policy.tools !== "read") {
          const target = resolve(spec.cwd, write);
          if (target.startsWith(resolve(spec.cwd))) {
            yield { kind: "tool", id: "w1", name: "write", input: write, phase: "start" };
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, `written by null at ${Date.now()}\n`);
            yield { kind: "tool", id: "w1", name: "write", input: write, phase: "end", ok: true };
          }
        }
        if (/#null:loop/.test(text) && !isVerify && !isChair) {
          for (let i = 0; i < 4 && !killed; i++) {
            yield { kind: "tool", id: `l${i}`, name: "bash", input: "ls", phase: "start" };
            yield { kind: "tool", id: `l${i}`, name: "bash", input: "ls", phase: "end", ok: true };
          }
        }
        let verdict: Record<string, unknown> = { decision: "pass", reason: "null harness: fixed reply" };
        if (isVerify) verdict = { decision: /#null:review-fail/.test(text) ? "fail" : "pass", reason: "null reviewer" };
        else if (isChair) {
          verdict = {
            decision: "pass",
            reason: "null chair plan",
            plan: [
              { key: "a", goal: "first part", route: "explore", effort: "quick", dependsOn: [], artifacts: [] },
              { key: "b", goal: "second part", route: "explore", effort: "quick", dependsOn: ["a"], artifacts: [] },
            ],
          };
        } else {
          const decision = /#null:(rework|fail|human|overflow|handoff|silent)\b/.exec(text)?.[1];
          if (decision === "silent") verdict = {};
          else if (decision === "human") verdict = { decision, reason: "need a choice", ask: "Pick A or B?" };
          else if (decision === "handoff" || decision === "overflow")
            verdict = {
              decision,
              reason: "needs another route",
              route: "build",
              brief: { goal: "continue the work", done_when: "it works", constraints: [], artifacts: [], tried: ["null"], open_questions: [] },
            };
          else if (decision) verdict = { decision, reason: `null ${decision}` };
        }
        yield { kind: "session", id: `null-${spec.runId}`, state: "live" };
        const body = Object.keys(verdict).length ? `\n<verdict>${JSON.stringify(verdict)}</verdict>` : "";
        yield { kind: "text", text: `null harness reply.${body}` };
        yield { kind: "usage", input: 100, output: 10, cacheRead: 80, cost: 0 };
        yield { kind: "exit", code: 0 };
      }
      return { events: events(), sessionId: () => null, kill: () => void (killed = true) };
    },
  };
}
