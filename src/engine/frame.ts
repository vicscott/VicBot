import { db } from "../store";
import { FINAL, type Frame, type FrameReason, type Task } from "../types";

/**
 * Decides whether a message starts a new conversation or continues one. It runs on every message, so it
 * is a fast heuristic with no model call; the person can correct it with one click, and that is recorded.
 */

export const FRAMING = {
  /** A follow-up phrase attaches to the last conversation only if it was touched this recently. */
  followupWindowMs: 30 * 60_000,
  /** Conversations older than this are not considered at all. */
  horizonMs: 3 * 24 * 60 * 60_000,
  /** Share of the message's terms found in a conversation to call it the same topic. */
  similar: 0.4,
  /** Below `similar` but above this, the conversation is offered as an alternative. */
  maybe: 0.2,
  candidates: 20,
};

const NEW = /^\s*(new (task|topic|question|conversation)|unrelated|different (question|topic)|separately)\b|^\s*(新(任务|问题|话题)|另一个问题|另外一个问题|换个(话题|问题)|无关的?问题)/i;
const FOLLOWUP = /^\s*(and|also|plus|then|so|but|what about|how about|and what|what if|instead|again|same|more (on|about|detail)|go on|continue|keep going|next|why|is (it|that|this)|are (they|those|these)|can (it|you also)|does (it|that)|it|that|this|these|those|them)\b|^\s*(那|那么|还有|另外|再|继续|接着|然后|所以|但是|为什么|上面|刚才|之前|前面|这个|那个|这些|那些|它|他们|第[一二三四五六七八九十\d]+[个条点项]|展开|详细|具体|改成|换成|同样|一样)/i;
const ACK_WORD = "(?:thanks?(?: you)?(?: (?:so|very) much)?|thx|ty|ok(?:ay)?|got it|great|nice|cool|perfect|awesome|谢谢|多谢|好的?|收到|明白了?|知道了|不错|很好)";
const ACK = new RegExp(`^\\s*${ACK_WORD}(?:[\\s,，!.。！~]+${ACK_WORD})*[\\s!.。！~]*$`, "i");
const MENTION = /#(t[0-9a-f]{10})\b/;

const STOP = new Set(
  "the and for with that this what which when where how who why are was were you your can could would should will about from into have has had not but all any some more most just like also than then them they their there here our out use using get make need want know does did done its it's i'm let tell give show find please help".split(" "),
);
const STOP_CJK = new Set("我们 你们 他们 这个 那个 一下 一些 可以 什么 如何 怎么 需要 现在 还有 看看 帮我 请问 是不 不是 的话 就是 因为 所以 但是 如果 或者 然后 已经 没有 这些 那些 哪些 有些 有哪 我是 我现 在做".split(" "));
const CJK_RUN = /[\u3400-\u9fff\uf900-\ufaff]+/g;

/** Words for English-like text, character bigrams for CJK runs. */
export function terms(text: string): Set<string> {
  const out = new Set<string>();
  const lower = text.toLowerCase();
  for (const w of lower.replace(CJK_RUN, " ").match(/[\p{L}\p{N}][\p{L}\p{N}_-]{2,}/gu) ?? []) if (!STOP.has(w)) out.add(w.length > 4 ? w.replace(/(?<![su])s$/, "") : w);
  for (const run of lower.match(CJK_RUN) ?? []) {
    for (let i = 0; i + 1 < run.length; i++) {
      const bi = run.slice(i, i + 2);
      if (!STOP_CJK.has(bi)) out.add(bi);
    }
  }
  return out;
}

/** The share of the message's terms that the conversation already uses; needs at least two shared terms. */
export function overlap(message: Set<string>, topic: Set<string>): number {
  if (!message.size) return 0;
  let hit = 0;
  for (const t of message) if (topic.has(t)) hit++;
  if (hit < Math.min(2, message.size)) return 0;
  return hit / message.size;
}

export interface Candidate {
  task: Task;
  /** When the conversation last had a message in either direction. */
  touched: number;
  topic: Set<string>;
}

export function candidates(now = Date.now()): Candidate[] {
  const store = db();
  const roots = store
    .tasks(200)
    .filter((t) => !t.parentId && t.status !== "cancelled" && !t.meta.mergedInto && now - t.updatedAt < FRAMING.horizonMs)
    .slice(0, FRAMING.candidates);
  return roots.map((task) => {
    const rows = store.threadFor([task.id], 20);
    const said = rows.filter((r) => r.author === "person").map((r) => r.text);
    const text = [task.title, task.goal, ...said, (task.result ?? "").slice(0, 600)].join("\n");
    return { task, touched: Math.max(task.updatedAt, ...rows.map((r) => r.ts)), topic: terms(text) };
  });
}

export interface FrameInput {
  text: string;
  /** The conversation the quoted message belongs to. */
  quoteTask?: string | null;
  /** The conversation the person is looking at when they send. */
  context?: string | null;
  /** The person picked a route or effort by hand, which only makes sense for a new task. */
  configured?: boolean;
  now?: number;
}

export type Decision = Omit<Frame, "noteId">;

export function conversationOf(id: string): Task | null {
  const t = db().task(id);
  if (!t) return null;
  return t.rootId === t.id ? t : (db().task(t.rootId) ?? t);
}

const frame = (decision: Frame["decision"], taskId: string, reason: FrameReason, confidence: number, alt: string | null = null): Decision => ({ decision, taskId, reason, confidence, alt });

/** A continuation names its conversation; a "new" decision has an empty taskId that the caller fills in. */
export function decideFrame(input: FrameInput, pool?: Candidate[]): Decision {
  const now = input.now ?? Date.now();
  const text = input.text.trim();
  const usable = (t: Task | null): t is Task => !!t && t.status !== "cancelled" && !t.meta.mergedInto;
  if (NEW.test(text)) return frame("new", "", "asked-new", 1);
  if (input.quoteTask) {
    const t = conversationOf(input.quoteTask);
    if (usable(t)) return frame("continue", t.id, "quote", 1);
  }
  const mention = MENTION.exec(text)?.[1];
  if (mention) {
    const t = conversationOf(mention);
    if (usable(t)) return frame("continue", t.id, "mention", 1);
  }
  if (input.configured) return frame("new", "", "asked-new", 1);
  if (input.context) {
    const t = conversationOf(input.context);
    if (usable(t)) return frame(ACK.test(text) && FINAL.includes(t.status) ? "ack" : "continue", t.id, "context", 0.9);
    return frame("new", "", "stopped", 1);
  }
  const list = pool ?? candidates(now);
  const words = terms(text);
  const scored = list.map((c) => ({ c, score: overlap(words, c.topic) })).sort((a, b) => b.score - a.score || b.c.touched - a.c.touched);
  const best = scored[0];
  const last = [...list].sort((a, b) => b.touched - a.touched)[0];
  const recent = last && now - last.touched < FRAMING.followupWindowMs ? last : null;
  if (recent && ACK.test(text)) return frame(FINAL.includes(recent.task.status) ? "ack" : "continue", recent.task.id, "ack", 0.8);
  if (recent && FOLLOWUP.test(text)) {
    const mine = scored.find((x) => x.c.task.id === recent.task.id)?.score ?? 0;
    if (best && best.c.task.id !== recent.task.id && best.score >= FRAMING.maybe && best.score > mine * 2) return frame("continue", best.c.task.id, "similar", Math.round(best.score * 100) / 100, recent.task.id);
    const other = best && best.c.task.id !== recent.task.id && best.score >= FRAMING.maybe ? best.c.task.id : null;
    return frame("continue", recent.task.id, "followup", 0.75, other);
  }
  if (best && best.score >= FRAMING.similar) {
    const second = scored[1] && scored[1].score >= FRAMING.similar ? scored[1].c.task.id : null;
    return frame("continue", best.c.task.id, "similar", Math.round(best.score * 100) / 100, second);
  }
  return frame("new", "", "new", Math.round((1 - (best?.score ?? 0)) * 100) / 100, best && best.score >= FRAMING.maybe ? best.c.task.id : null);
}
