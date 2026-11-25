import type { VEvent } from "../types";

export interface Proc {
  lines: AsyncIterable<unknown>;
  write(line: string): void;
  stderr(): string;
  exited: Promise<number | null>;
  kill(): void;
}

/** Spawns a JSON-lines process. Non-JSON stdout lines are skipped; stderr keeps a short tail. */
export function spawnJsonl(cmd: string[], opts: { cwd: string; stdin?: string; keepStdin?: boolean; env?: Record<string, string> }): Proc {
  const child = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdin: opts.stdin !== undefined || opts.keepStdin ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...opts.env },
  });
  if (opts.stdin !== undefined && child.stdin) {
    child.stdin.write(opts.stdin);
    if (!opts.keepStdin) child.stdin.end();
  }
  let tail = "";
  void (async () => {
    for await (const chunk of child.stderr as ReadableStream<Uint8Array>) {
      tail = (tail + new TextDecoder().decode(chunk)).slice(-4000);
    }
  })();
  async function* lines(): AsyncGenerator<unknown> {
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of child.stdout as ReadableStream<Uint8Array>) {
      buf += dec.decode(chunk, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          yield JSON.parse(line);
        } catch {}
      }
    }
    const last = buf.trim();
    if (last.startsWith("{")) {
      try {
        yield JSON.parse(last);
      } catch {}
    }
  }
  let killed = false;
  return {
    lines: lines(),
    write(line) {
      if (child.stdin && !killed) child.stdin.write(line.endsWith("\n") ? line : line + "\n");
    },
    stderr: () => tail,
    exited: child.exited.then((code) => code),
    kill() {
      if (killed) return;
      killed = true;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    },
  };
}

/** Drives a process to completion, mapping each JSON line through `map`, and always ends with an exit event. */
export async function* drive(proc: Proc, map: (line: Record<string, unknown>) => VEvent[]): AsyncGenerator<VEvent> {
  for await (const raw of proc.lines) {
    if (raw && typeof raw === "object") yield* map(raw as Record<string, unknown>);
  }
  const code = await proc.exited;
  if (code !== 0) {
    const err = proc.stderr().split("\n").filter((l) => l.trim() && !/extension/i.test(l)).slice(-6).join("\n");
    if (err) yield { kind: "error", text: err };
  }
  yield { kind: "exit", code };
}

export function summarize(input: unknown, max = 160): string {
  const s = typeof input === "string" ? input : JSON.stringify(input ?? "");
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}
