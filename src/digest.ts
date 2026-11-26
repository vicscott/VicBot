/**
 * A long answer read at a glance: its conclusion, how many parts it has, and the leading sentence of
 * each part. Built from the markdown alone, with no model call, so it works for every harness.
 */
export interface DigestPart {
  title: string | null;
  lead: string;
}

export interface Digest {
  conclusion: string | null;
  parts: DigestPart[];
  /** Short answers are shown whole; a digest of them would only repeat them. */
  short: boolean;
}

const SHORT_CHARS = 600;
const LEAD_CHARS = 220;
const LABEL = /^\s*(?:\*\*|__)?\s*(conclusion|bottom line|tl;?dr|in short|short answer|answer|summary|结论|总结|简短回答|一句话|答案)\s*(?:\*\*|__)?\s*[:：]\s*(?:\*\*|__)?\s*/i;
const HEADING_CONCLUSION = /^(conclusion|conclusions|summary|tl;?dr|bottom line|in short|short answer|answer|结论|总结|小结|简短回答)\b/i;
const CLOSER = /^(so,|overall|in summary|in short|to sum up|all in all|总之|综上|因此|所以|总的来说)/i;

const stripTags = (s: string) => s.replace(/<verdict>[\s\S]*?<\/verdict>/g, "").replace(/\r/g, "").trim();

/** Inline markdown that would read oddly when cut out of its block. */
function plainInline(s: string): string {
  return s
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/** The first sentence, or the first LEAD_CHARS characters of it. Bold and code survive; links keep their text. */
export function firstSentence(text: string): string {
  const s = plainInline(text);
  const m = /^(.+?[.!?](?=\s|$)|.+?[。！？])/.exec(s);
  let out = (m?.[1] ?? s).trim();
  if (out.length > LEAD_CHARS) out = `${out.slice(0, LEAD_CHARS - 1).trimEnd()}…`;
  const bolds = (out.match(/\*\*/g) ?? []).length;
  if (bolds % 2) out = out.replace(/\*\*(?!.*\*\*)/, "");
  return out;
}

interface Block {
  kind: "para" | "list" | "code" | "table" | "quote";
  lines: string[];
}

interface Section {
  title: string | null;
  blocks: Block[];
}

function blocksOf(md: string): Section[] {
  const sections: Section[] = [{ title: null, blocks: [] }];
  let cur: Block | null = null;
  let fence = false;
  const flush = () => {
    if (cur && cur.lines.some((l) => l.trim())) sections.at(-1)!.blocks.push(cur);
    cur = null;
  };
  for (const line of md.split("\n")) {
    if (fence) {
      cur!.lines.push(line);
      if (/^\s*(```|~~~)/.test(line)) {
        fence = false;
        flush();
      }
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      flush();
      cur = { kind: "code", lines: [line] };
      fence = true;
      continue;
    }
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      flush();
      sections.push({ title: plainInline(heading[1]!.replace(/\*\*/g, "")), blocks: [] });
      continue;
    }
    if (!line.trim()) {
      if (cur?.kind !== "list") flush();
      continue;
    }
    const kind: Block["kind"] = /^\s*\|/.test(line) ? "table" : /^\s*(?:[-*+]|\d+[.)])\s+/.test(line) ? "list" : /^\s*>/.test(line) ? "quote" : "para";
    const cont = cur && (cur.kind === kind || (cur.kind === "list" && /^\s{2,}\S/.test(line)));
    if (!cont) {
      if (cur?.kind === "list" && kind === "para" && !/^\s/.test(line)) flush();
      else if (cur && cur.kind !== kind) flush();
      cur ??= { kind, lines: [] };
    }
    cur!.lines.push(line);
  }
  flush();
  return sections.filter((s) => s.title || s.blocks.length);
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+/;

/** A part's leading line comes from its first block, so a section that opens with a table is described as one. */
function leadOf(blocks: Block[]): string {
  const first = blocks[0];
  if (!first) return "";
  if (first.kind === "para" || first.kind === "quote") {
    const lead = firstSentence(first.lines.join(" "));
    const next = blocks[1];
    const items = next?.kind === "list" ? next.lines.filter((l) => ITEM.test(l)).length : 0;
    return items && /[:：]$/.test(lead) ? `${lead} ${items} item${items > 1 ? "s" : ""}.` : lead;
  }
  if (first.kind === "list") {
    const items = first.lines.filter((l) => ITEM.test(l));
    return `${firstSentence(items[0] ?? "")}${items.length > 1 ? ` (+${items.length - 1} more)` : ""}`;
  }
  if (first.kind === "table") {
    const cols = first.lines[0]!.split("|").map((c) => c.trim()).filter(Boolean);
    const rows = first.lines.filter((l) => !/^\s*\|?\s*:?-{2,}/.test(l)).length - 1;
    return `A table of ${Math.max(rows, 0)} row${rows === 1 ? "" : "s"}: ${cols.slice(0, 4).join(", ")}${cols.length > 4 ? ", …" : ""}`;
  }
  const lang = /^\s*```\s*(\w+)/.exec(first.lines[0]!)?.[1];
  return `A code block${lang ? ` (${lang})` : ""}`;
}

export function digest(raw: string | null | undefined): Digest {
  const md = stripTags(raw ?? "");
  const sections = blocksOf(md);
  const count = sections.reduce((n, s) => n + s.blocks.length, 0);
  if (md.length <= SHORT_CHARS && count <= 3) return { conclusion: null, parts: [], short: true };
  let conclusion: string | null = null;
  const take = (s: Section, i: number) => {
    const text = s.blocks[i]!.lines.join(" ");
    s.blocks.splice(i, 1);
    return text;
  };
  for (const s of sections) {
    const i = s.blocks.findIndex((b) => b.kind === "para" && LABEL.test(b.lines[0]!));
    if (i < 0) continue;
    conclusion = firstSentences(take(s, i).replace(LABEL, ""));
    break;
  }
  if (!conclusion) {
    const i = sections.findIndex((s) => s.title && HEADING_CONCLUSION.test(s.title));
    if (i >= 0) {
      const lead = leadOf(sections[i]!.blocks);
      if (lead) {
        conclusion = firstSentences(sections[i]!.blocks.find((b) => b.kind === "para")?.lines.join(" ") ?? lead);
        sections.splice(i, 1);
      }
    }
  }
  if (!conclusion) {
    const last = sections.at(-1)?.blocks.at(-1);
    if (last?.kind === "para" && CLOSER.test(plainInline(last.lines[0]!))) conclusion = firstSentences(take(sections.at(-1)!, sections.at(-1)!.blocks.length - 1));
  }
  if (!conclusion) {
    const first = sections[0];
    if (first && !first.title && first.blocks[0]?.kind === "para") conclusion = firstSentences(take(first, 0));
  }
  const parts: DigestPart[] = [];
  for (const s of sections) {
    if (s.title) {
      const lead = leadOf(s.blocks);
      if (lead || s.blocks.length) parts.push({ title: s.title, lead });
      continue;
    }
    for (let i = 0; i < s.blocks.length; i++) {
      const b = s.blocks[i]!;
      const next = s.blocks[i + 1];
      if (b.kind === "para" && next?.kind === "list" && /[:：]\s*$/.test(b.lines.join(" "))) {
        parts.push({ title: null, lead: leadOf([b, next]) });
        i++;
        continue;
      }
      const lead = leadOf([b]);
      if (lead) parts.push({ title: null, lead });
    }
  }
  return { conclusion, parts: parts.filter((p) => p.lead || p.title), short: false };
}

/** Up to two sentences, for a conclusion. */
function firstSentences(text: string): string {
  const one = firstSentence(text);
  const rest = plainInline(text).slice(plainInline(one).replace(/…$/, "").length).trim();
  if (!rest || one.endsWith("…") || one.length > 140) return one;
  const two = firstSentence(rest);
  return `${one} ${two}`.length <= LEAD_CHARS + 60 ? `${one} ${two}` : one;
}
