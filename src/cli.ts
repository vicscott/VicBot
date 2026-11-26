#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { PORT } from "./config";
import type { Card, Task, TemplateRow } from "./types";

const BASE = process.env.VICBOT_URL ?? `http://127.0.0.1:${PORT}`;
const TOKEN = process.env.VICBOT_TOKEN;

const HELP = `vic — VicBot

  vic serve                          start the server and the web UI
  vic run <text> [--route r] [--effort e] [--cwd dir] [--wait]
  vic say <text> [--task id] [--interrupt]   talk to the host, or to a task
  vic ls                             list tasks
  vic show <id>                      a task with its runs, checks and notes
  vic cancel <id>                    stop a task
  vic route <text>                   preview the router's decision
  vic answer <card> [option] [--text t]
  vic cards                          open cards
  vic pair [--scope full|standard|notify]    make a one-time pairing code
  vic harness list                   installed harnesses and the route mapping
  vic templates                      template versions, hashes and pass rates
  vic templates reseed <role>        freeze templates/<role>.md as a new generation
  vic profile [text]                 show or set what every task knows about you
  vic keeper                         run the keeper now

  VICBOT_URL and VICBOT_TOKEN point the CLI at a remote server.`;

async function call<T>(path: string, payload?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  if (payload !== undefined) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await fetch(BASE + path, { method: payload === undefined ? "GET" : "POST", headers, body: payload === undefined ? undefined : JSON.stringify(payload) });
  } catch {
    throw new Error(`cannot reach VicBot at ${BASE}. Start it with: vic serve`);
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? res.statusText);
  return data;
}

const event = <T>(payload: Record<string, unknown>) => call<T>("/v1/events", { id: crypto.randomUUID(), ...payload });

function line(t: Task): string {
  const tokens = t.inputTokens ? ` · ${Math.round((t.cacheRead / t.inputTokens) * 100)}% cached` : "";
  return `${t.id}  ${t.status.padEnd(16)} ${(t.route ?? "-").padEnd(8)} ${t.effort.padEnd(9)} ${(t.harness ?? "-").padEnd(6)} ${t.title}${tokens}`;
}

async function wait(id: string): Promise<Task> {
  const final = ["done", "blocked", "failed", "cancelled", "waiting_input", "needs_route"];
  for (;;) {
    const { task } = await call<{ task: Task }>(`/v1/tasks/${id}`);
    if (final.includes(task.status)) return task;
    await Bun.sleep(1500);
  }
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      route: { type: "string" },
      effort: { type: "string" },
      cwd: { type: "string" },
      task: { type: "string" },
      text: { type: "string" },
      scope: { type: "string" },
      wait: { type: "boolean" },
      interrupt: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  const text = rest.join(" ");
  switch (cmd) {
    case "serve":
      await (await import("./server")).serve();
      return;
    case "run": {
      if (!text) throw new Error("usage: vic run <text>");
      const r = await event<{ task?: Task }>({ type: "say", text, route: values.route, effort: values.effort, cwd: values.cwd ?? process.cwd() });
      if (!r.task) return console.log("(answered by the host; see the thread)");
      console.log(line(r.task));
      if (values.wait) {
        const t = await wait(r.task.id);
        console.log(`\n${t.status}${t.statusReason ? `: ${t.statusReason}` : ""}\n\n${t.result ?? ""}`);
      }
      return;
    }
    case "say": {
      if (!text) throw new Error("usage: vic say <text>");
      const r = await event<{ task?: Task; note?: { id: string } }>({ type: "say", text, taskId: values.task, interrupt: values.interrupt });
      if (r.note) console.log(`queued note ${r.note.id} for #${values.task}`);
      else if (r.task) console.log(line(r.task));
      else {
        const rows = await call<{ author: string; text: string }[]>("/v1/thread");
        console.log(rows.filter((x) => x.author === "host").at(-1)?.text ?? "");
      }
      return;
    }
    case "ls":
      for (const t of await call<Task[]>("/v1/tasks")) console.log(line(t));
      return;
    case "show": {
      const d = await call<{ task: Task; runs: { id: string; harness: string; purpose: string; outcome: string | null; templateHash: string; usage: { input: number; cacheRead: number } }[]; checks: { checkId: string; ok: boolean; detail: string }[]; notes: { id: string; status: string; text: string }[] }>(`/v1/tasks/${rest[0]}`);
      console.log(line(d.task));
      console.log(`cwd ${d.task.cwd} · trust ${d.task.trust} · shape ${d.task.shape} · used ${d.task.used.toolCalls}/${d.task.budget.toolCalls} calls`);
      if (d.task.statusReason) console.log(`reason: ${d.task.statusReason}`);
      for (const r of d.runs) console.log(`  run ${r.id} ${r.harness} ${r.purpose} → ${r.outcome ?? "running"} · template ${r.templateHash} · ${r.usage.input ? Math.round((r.usage.cacheRead / r.usage.input) * 100) : 0}% cached`);
      for (const c of d.checks) console.log(`  check ${c.checkId} ${c.ok ? "ok" : "FAILED"}: ${c.detail.split("\n")[0]}`);
      for (const n of d.notes) console.log(`  note ${n.id} ${n.status}: ${n.text.slice(0, 80)}`);
      if (d.task.result) console.log(`\n${d.task.result}`);
      return;
    }
    case "cancel":
      console.log(line(await event<Task>({ type: "cancel", taskId: rest[0] })));
      return;
    case "route":
      console.log(JSON.stringify(await event({ type: "preview", text }), null, 2));
      return;
    case "answer":
      await event<Card>({ type: "answer", cardId: rest[0], option: rest[1], text: values.text });
      console.log("answered");
      return;
    case "cards":
      for (const c of await call<Card[]>("/v1/cards?open=1")) console.log(`${c.id}  ${c.kind.padEnd(13)} ${c.title}  [${c.options.map((o) => o.id).join(" | ")}${c.allowText ? " | --text" : ""}]`);
      return;
    case "pair": {
      const r = await call<{ code: string; expiresAt: number }>("/v1/devices/code", { scope: values.scope ?? "standard" });
      console.log(`Pairing code: ${r.code}\nValid until ${new Date(r.expiresAt).toLocaleTimeString()}, once. Enter it on the device's VicBot page.`);
      return;
    }
    case "harness": {
      const m = await call<{ harnesses: { id: string; available: boolean; version: string | null; problem: string | null; routes: string[] }[]; mapping: Record<string, string | null> }>("/v1/meta");
      for (const h of m.harnesses) console.log(`${h.available ? "✓" : "✗"} ${h.id.padEnd(6)} ${h.version ?? ""}${h.problem ? ` — ${h.problem}` : ""}`);
      console.log("\nroute/effort → harness");
      for (const [k, v] of Object.entries(m.mapping)) console.log(`  ${k.padEnd(18)} ${v ?? "(none)"}`);
      return;
    }
    case "templates": {
      if (rest[0] === "reseed") {
        const { reseed } = await import("./templates");
        const row = reseed(rest[1] as never);
        console.log(`${row.role} v${row.version} ${row.hash} is now active (restart the server to pick it up)`);
        return;
      }
      for (const t of await call<TemplateRow[]>("/v1/templates")) console.log(`${t.role.padEnd(8)} v${t.version} ${t.hash} ${t.status.padEnd(9)} ${t.passes}/${t.runs} passed${t.note ? ` · ${t.note}` : ""}`);
      return;
    }
    case "profile": {
      const r = text.trim() ? await event<{ text: string }>({ type: "profile", text }) : await call<{ text: string }>("/v1/profile");
      console.log(r.text || "(empty) Set it with: vic profile \"I work at a university in Hong Kong…\"");
      return;
    }
    case "keeper":
      console.log(JSON.stringify(await event({ type: "keeper" }), null, 2));
      return;
    default:
      console.log(HELP);
  }
}

main(process.argv.slice(2)).catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
