import type { Server } from "bun";
import index from "../ui/index.html";
import { allowedHosts, authenticate, createPairCode, redeemPairCode, revokeDevice } from "./auth";
import { bus } from "./bus";
import { BOUNDS, HOST, LIMITS, PORT, ROUTE_THRESHOLD } from "./config";
import { selectHarness } from "./engine/policy";
import { answerCard, assignRoute, cancel, editContract, grantTrust, intake, withdraw, type Actor } from "./engine/tasks";
import { harnesses, loadHarnesses } from "./harness/registry";
import { route as decide } from "./router";
import { db } from "./store";
import { seedTemplates } from "./templates";
import { EFFORTS, ROUTES, TRUSTS, type BusMessage, type Effort, type Route, type Scope, type Trust } from "./types";
import { runKeeper } from "./wake/keeper";
import { ensureMemory, instructionsBody, setInstructions } from "./wake/memory";
import { startTimers } from "./wake/timers";
import { settleOrphans, startWorker } from "./wake/worker";

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

type Handler = (req: Request & { params: Record<string, string> }, actor: Actor) => unknown | Promise<unknown>;

/**
 * Host pins against DNS rebinding, Origin against CSRF, and every call needs an actor: the local
 * machine, or a paired device token.
 */
function guard(req: Request, server: Server<unknown>, open = false): Actor | Response {
  const host = req.headers.get("host") ?? "";
  if (!allowedHosts().includes(host)) return new Response("Bad host", { status: 403 });
  const origin = req.headers.get("origin");
  if (req.method !== "GET" && origin !== null && origin !== `http://${host}` && origin !== `https://${host}`) return new Response("Bad origin", { status: 403 });
  const actor = authenticate(req, server.requestIP(req)?.address ?? null);
  if (!actor && !open) return Response.json({ error: "pair this device first" }, { status: 401 });
  return actor ?? { device: "anonymous", scope: "notify" };
}

function api(fn: Handler, opts: { scope?: Scope; open?: boolean } = {}) {
  return async (req: Request & { params: Record<string, string> }, server: Server<unknown>): Promise<Response> => {
    const actor = guard(req, server, opts.open);
    if (actor instanceof Response) return actor;
    if (opts.scope === "full" && actor.scope !== "full") return Response.json({ error: "needs a full-scope device" }, { status: 403 });
    if (opts.scope === "standard" && actor.scope === "notify") return Response.json({ error: "needs a standard or full device" }, { status: 403 });
    try {
      return Response.json(await fn(req, actor));
    } catch (err) {
      const status = err instanceof HttpError ? err.status : 400;
      return Response.json({ error: (err as Error).message }, { status });
    }
  };
}

async function body(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get("content-type")?.includes("application/json")) throw new Error("expected application/json");
  const parsed: unknown = await req.json();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("expected a JSON object");
  return parsed as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== "string" || !v) throw new Error(`missing ${field}`);
  return v;
}

function opt<T extends string>(v: unknown, values: readonly T[], field: string): T | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (!values.includes(v as T)) throw new Error(`unknown ${field} ${String(v)}`);
  return v as T;
}

function meta(actor: Actor) {
  return {
    you: actor,
    harnesses: harnesses().map((h) => ({ id: h.manifest.id, name: h.manifest.name, available: h.available, version: h.version, problem: h.problem, routes: h.manifest.routes, roles: h.manifest.roles, capabilities: h.manifest.capabilities, serves: h.manifest.serves })),
    mapping: Object.fromEntries(ROUTES.flatMap((r) => EFFORTS.map((e) => [`${r}/${e}`, selectHarness({ route: r, effort: e, role: "worker" })?.manifest.id ?? null]))),
    bounds: BOUNDS,
    limits: { handoffHops: LIMITS.handoffHops, renewals: LIMITS.renewals, planChildren: LIMITS.planChildren },
    threshold: ROUTE_THRESHOLD,
  };
}

function taskDetail(id: string) {
  const store = db();
  const task = store.task(id);
  if (!task) throw new HttpError(404, "no such task");
  return {
    task,
    runs: store.runs(id),
    events: store.events(id),
    checks: store.checks(id),
    notes: store.notes(id),
    cards: store.cards({ taskId: id }),
    sessions: store.sessions(id),
    children: store.children(id),
    parent: task.parentId ? store.task(task.parentId) : null,
    ledger: store.ledgerRows(id, 100),
  };
}

/** The one write endpoint. An idempotency id makes retries from flaky networks safe. */
async function postEvent(req: Request, actor: Actor): Promise<unknown> {
  const b = await body(req);
  const id = typeof b.id === "string" && b.id ? `${actor.device}:${b.id.slice(0, 80)}` : null;
  if (id) {
    const prior = db().idempotent(id);
    if (prior !== undefined) return prior;
  }
  const writes = actor.scope !== "notify";
  const needWrite = () => {
    if (!writes) throw new HttpError(403, "a notify device can only answer cards");
  };
  let result: unknown;
  switch (b.type) {
    case "say":
      needWrite();
      result = intake(
        str(b.text, "text"),
        {
          taskId: typeof b.taskId === "string" && b.taskId ? b.taskId : undefined,
          route: opt<Route>(b.route, ROUTES, "route"),
          effort: opt<Effort>(b.effort, EFFORTS, "effort"),
          cwd: typeof b.cwd === "string" && b.cwd.trim() ? b.cwd.trim() : undefined,
          mode: b.mode === "unattended" ? "unattended" : "interactive",
          interrupt: b.interrupt === true,
        },
        actor,
      );
      break;
    case "route":
      needWrite();
      result = assignRoute(str(b.taskId, "taskId"), opt<Route>(b.route, ROUTES, "route") ?? (str(b.route, "route") as Route), actor);
      break;
    case "cancel":
      needWrite();
      result = cancel(str(b.taskId, "taskId"), actor);
      break;
    case "withdraw":
      needWrite();
      result = withdraw(str(b.noteId, "noteId"), actor);
      break;
    case "contract":
      needWrite();
      result = editContract(str(b.taskId, "taskId"), b.contract, actor);
      break;
    case "trust":
      needWrite();
      result = grantTrust(str(b.taskId, "taskId"), opt<Trust>(b.trust, TRUSTS, "trust") ?? "read", actor);
      break;
    case "answer":
      result = answerCard(str(b.cardId, "cardId"), typeof b.option === "string" && b.option ? b.option : null, typeof b.text === "string" ? b.text : null, actor);
      break;
    case "preview":
      result = decide(str(b.text, "text"));
      break;
    case "profile":
      if (actor.scope !== "full") throw new HttpError(403, "needs a full-scope device");
      result = { text: setInstructions(typeof b.text === "string" ? b.text : "") };
      break;
    case "keeper":
      if (actor.scope !== "full") throw new HttpError(403, "needs a full-scope device");
      result = runKeeper();
      break;
    default:
      throw new Error(`unknown event type ${String(b.type)}`);
  }
  if (id) db().remember(id, result);
  return result;
}

/** SSE. A cursor replays the thread rows the client missed, then the live bus follows. */
function stream(req: Request, server: Server<unknown>): Response {
  const actor = guard(req, server);
  if (actor instanceof Response) return actor;
  const cursor = Number(new URL(req.url).searchParams.get("cursor") ?? 0) || 0;
  const enc = new TextEncoder();
  let off = () => {};
  let ping: Timer | undefined;
  const out = new ReadableStream<Uint8Array>({
    start(ctl) {
      const send = (m: BusMessage) => {
        try {
          ctl.enqueue(enc.encode(`data: ${JSON.stringify(m)}\n\n`));
        } catch {
          off();
        }
      };
      ctl.enqueue(enc.encode(": ready\n\n"));
      if (cursor) for (const row of db().thread(cursor, 500)) send({ type: "thread", row });
      off = bus.on(send);
      ping = setInterval(() => {
        try {
          ctl.enqueue(enc.encode(": ping\n\n"));
        } catch {
          clearInterval(ping);
        }
      }, 15000);
    },
    cancel() {
      off();
      clearInterval(ping);
    },
  });
  return new Response(out, { headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" } });
}

export function routes() {
  return {
    "/": index,
    "/v1/meta": api((_req, actor) => meta(actor)),
    "/v1/stream": stream,
    "/v1/thread": api((req) => db().thread(Number(new URL(req.url).searchParams.get("after") ?? 0) || 0, 300)),
    "/v1/tasks": api(() => db().tasks()),
    "/v1/tasks/:id": api((req) => taskDetail(req.params.id!)),
    "/v1/cards": api((req) => db().cards({ open: new URL(req.url).searchParams.get("open") === "1" })),
    "/v1/templates": api(() => db().templates()),
    "/v1/profile": api(() => ({ text: instructionsBody() })),
    "/v1/events": { POST: api(postEvent) },
    "/v1/devices": api(() => db().devices(), { scope: "full" }),
    "/v1/devices/code": { POST: api(async (req) => createPairCode(opt<Scope>((await body(req)).scope, ["full", "standard", "notify"], "scope") ?? "standard"), { scope: "full" }) },
    "/v1/devices/pair": {
      POST: api(
        async (req) => {
          const b = await body(req);
          return redeemPairCode(str(b.code, "code"), typeof b.name === "string" ? b.name : "device");
        },
        { open: true },
      ),
    },
    "/v1/devices/:id/revoke": { POST: api((req, actor) => revokeDevice(req.params.id!, actor), { scope: "full" }) },
  };
}

export async function serve() {
  ensureMemory();
  for (const w of seedTemplates()) console.warn(`template: ${w}`);
  const found = await loadHarnesses();
  const orphans = settleOrphans();
  const server = Bun.serve({
    hostname: HOST,
    port: PORT,
    idleTimeout: 0,
    routes: routes() as never,
    fetch: () => new Response("Not found", { status: 404 }),
    development: process.env.VICBOT_DEV === "1" && { hmr: true },
  });
  startWorker();
  startTimers();
  console.log(`VicBot on ${server.url}`);
  for (const h of found) console.log(`  ${h.available ? "✓" : "✗"} ${h.manifest.id}${h.version ? ` (${h.version})` : ""}${h.problem ? ` — ${h.problem}` : ""}`);
  if (orphans) console.log(`Recovering ${orphans} task(s) that were running when VicBot stopped.`);
  if (HOST !== "127.0.0.1" && HOST !== "localhost") console.log("Listening beyond loopback: remote clients need a paired device token (vic pair).");
  return server;
}
