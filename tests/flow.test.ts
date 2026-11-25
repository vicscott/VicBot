import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { cancel, answerCard, intake, message, withdraw } from "../src/engine/tasks";
import { live } from "../src/engine/live";
import { loadHarnesses } from "../src/harness/registry";
import { db, Store, useStore } from "../src/store";
import { seedTemplates } from "../src/templates";
import type { Task } from "../src/types";
import { ensureMemory } from "../src/wake/memory";
import { idle, startWorker, stopWorker } from "../src/wake/worker";

const me = { device: "test", scope: "full" as const };

beforeAll(async () => {
  useStore(new Store(":memory:"));
  ensureMemory();
  await loadHarnesses();
  startWorker();
});

afterAll(() => stopWorker());

beforeEach(() => {
  useStore(new Store(":memory:"));
  seedTemplates();
});

function say(text: string, opts: Parameters<typeof intake>[1] = {}): Task {
  const r = intake(text, opts, me);
  if (!r.task) throw new Error("no task");
  return r.task;
}

const get = (id: string) => db().task(id)!;

test("a quick task runs once, passes, and the host reports it", async () => {
  const t = say("explain quickly what a monad is");
  expect(t.route).toBe("explore");
  await idle();
  const done = get(t.id);
  expect(done.status).toBe("done");
  expect(done.result).toContain("null harness reply");
  const runs = db().runs(t.id);
  expect(runs.map((r) => r.purpose)).toEqual(["work"]);
  expect(runs[0]!.verdictSource).toBe("tag");
  expect(runs[0]!.templateHash).toMatch(/^[0-9a-f]{12}$/);
  expect(done.cacheRead).toBe(80);
  const thread = db().thread();
  expect(thread.some((r) => r.author === "host" && r.text.startsWith("Done:") && r.pointer === `task:${t.id}`)).toBe(true);
});

test("standard effort adds an independent review before done", async () => {
  const t = say("research and compare the options for a message queue in a standard way", { effort: "standard" });
  await idle();
  expect(get(t.id).status).toBe("done");
  expect(db().runs(t.id).map((r) => r.purpose)).toEqual(["work", "verify"]);
  expect(db().checks(t.id).map((c) => [c.checkId, c.ok])).toEqual([["review", true]]);
});

test("a missing verdict gets one follow-up turn, then counts as fail", async () => {
  const t = say("explain #null:silent quickly");
  await idle();
  expect(get(t.id).status).toBe("failed");
  expect(db().runs(t.id).map((r) => r.purpose)).toEqual(["work", "verdict"]);
});

test("a human verdict parks on a card; the answer continues the task", async () => {
  const t = say("explain #null:human quickly");
  await idle();
  expect(get(t.id).status).toBe("waiting_input");
  const card = db().cards({ taskId: t.id, open: true })[0]!;
  expect(card.kind).toBe("question");
  answerCard(card.id, null, "A", me);
  expect(() => answerCard(card.id, null, "B", me)).toThrow();
  await idle();
  expect(get(t.id).status).toBe("done");
  expect(db().runs(t.id).map((r) => r.purpose)).toEqual(["work", "continue"]);
});

test("rework goes back once with the five-field block", async () => {
  const t = say("explain #null:rework quickly");
  await idle();
  expect(get(t.id).status).toBe("done");
  expect(get(t.id).reworks).toBe(1);
  expect(db().runs(t.id).map((r) => r.purpose)).toEqual(["work", "rework"]);
});

test("a check that fails twice escalates to a chair and a plan", async () => {
  const t = say("research #null:review-fail options", { effort: "standard" });
  await idle(20_000);
  const final = get(t.id);
  expect(final.escalated).toBe(true);
  expect(final.shape).toBe("orchestrated");
  const kids = db().children(t.id);
  expect(kids.map((k) => k.planKey)).toEqual(["0:a", "0:b"]);
  expect(kids.every((k) => k.status === "done")).toBe(true);
  expect(final.status).toBe("blocked");
  expect(db().cards({ taskId: t.id, open: true }).some((c) => c.kind === "blocked")).toBe(true);
});

test("a handoff creates a child on the new route and the parent follows it", async () => {
  const t = say("explain #null:handoff quickly");
  await idle();
  const parent = get(t.id);
  const [child] = db().children(t.id);
  expect(child!.route).toBe("build");
  expect(child!.visited).toEqual(["explore", "build"]);
  expect(child!.trust).toBe("workspace");
  expect(child!.status).toBe("done");
  expect(parent.status).toBe("done");
  expect(parent.result).toBe(child!.result);
  expect(db().events(t.id).filter((e) => e.event.kind === "handoff").map((e) => (e.event as { phase: string }).phase)).toEqual(["asked", "accepted"]);
});

test("a pass with no changed artifact is sent back; writing it passes", async () => {
  const bad = say("fix the bug and write `notes.md` quickly", { route: "build" });
  const good = say("create `out.txt` quickly #null:write=out.txt", { route: "build" });
  await idle(20_000);
  expect(get(good.id).contract.artifacts).toEqual(["out.txt"]);
  expect(get(good.id).status).toBe("done");
  const checks = db().checks(bad.id).filter((c) => c.checkId === "artifacts");
  expect(checks.length).toBe(2);
  expect(get(bad.id).escalated).toBe(true);
});

test("the loop guard nudges once, then escalates", async () => {
  const t = say("explain #null:loop quickly");
  await idle(20_000);
  const final = get(t.id);
  expect(final.loopTrips).toBe(2);
  expect(final.escalated).toBe(true);
  expect(final.status).toBe("done");
});

test("a message to a finished task reopens it with a delta turn", async () => {
  const t = say("explain quickly what a monad is");
  await idle();
  const r = intake("and a functor?", { taskId: t.id }, me);
  expect(r.note?.status).toBe("queued");
  await idle();
  expect(get(t.id).status).toBe("done");
  expect(db().note(r.note!.id)!.status).toBe("read");
  expect(db().runs(t.id).map((x) => x.purpose)).toEqual(["work", "continue"]);
  expect(db().runs(t.id)[1]!.promptKind).toBe("recovery");
});

test("notes can be withdrawn until delivered; status questions never create tasks", () => {
  const t = say("hello there");
  expect(t.status).toBe("needs_route");
  const note = message(t.id, "also this", "push", me);
  expect(withdraw(note.id, me).status).toBe("withdrawn");
  expect(() => withdraw(note.id, me)).toThrow();
  const before = db().tasks().length;
  const r = intake("status", {}, me);
  expect(r.task).toBeUndefined();
  expect(db().tasks().length).toBe(before);
  expect(db().thread().at(-1)!.text).toContain("task(s) active");
});

test("an unsure route waits on a card, and the answer starts it", async () => {
  const t = say("hello there");
  const card = db().cards({ taskId: t.id, open: true })[0]!;
  expect(card.kind).toBe("route");
  answerCard(card.id, "explore", null, me);
  await idle();
  expect(get(t.id).status).toBe("done");
});

test("cancel stops a running task", async () => {
  process.env.VICBOT_NULL_DELAY_MS = "400";
  const t = say("explain quickly");
  for (let i = 0; i < 50 && !live.has(t.id); i++) await Bun.sleep(10);
  expect(live.has(t.id)).toBe(true);
  cancel(t.id, me);
  await idle();
  process.env.VICBOT_NULL_DELAY_MS = "5";
  expect(get(t.id).status).toBe("cancelled");
  expect(db().runs(t.id)[0]!.outcome).toBe("cancelled");
});

test("a spent budget blocks with a card, and extending continues", async () => {
  const t = say("explain quickly");
  db().patchTask(t.id, { budget: { toolCalls: 0, minutes: 0, cost: 0 } });
  await idle();
  expect(get(t.id).status).toBe("blocked");
  const card = db().cards({ taskId: t.id, open: true }).find((c) => c.kind === "budget")!;
  answerCard(card.id, "extend", null, me);
  await idle();
  expect(get(t.id).status).toBe("done");
});

test("the inbox dedupes by key", () => {
  const t = say("hello there");
  expect(db().enqueue(t.id, "timer", {}, "k1")).not.toBeNull();
  expect(db().enqueue(t.id, "timer", {}, "k1")).toBeNull();
});
