import type { Effort, Route, Shape } from "./types";

export interface Decision {
  route: Route | null;
  effort: Effort;
  shape: Shape;
  designated: string | null;
  confidence: number;
  reason: string;
  /** The answer depends on current facts outside the machine, so the worker needs web search. */
  web: boolean;
  /** The input with a leading @harness removed. */
  text: string;
}

/** Keyword rules per route. Each match adds its weight; the top route wins and confidence is its share. */
const RULES: Record<Route, [RegExp, number][]> = {
  explore: [
    [/\b(research|investigate|explore|survey|compare|find out|look into|what is|what are|why does|how does|explain|summari[sz]e|read up|papers?|options for)\b/i, 2],
    [/\b(brainstorm|ideas?|pros and cons|landscape|alternatives?|review)\b/i, 1],
    [/(调研|研究|探索|比较|总结|了解|解释|为什么)/, 2],
  ],
  build: [
    [/\b(code|implement|refactor|fix|bug|tests?|build|compile|repo|function|script|migrate|api|typescript|python|rust|endpoint|cli)\b/i, 2],
    [/\.(ts|tsx|js|py|rs|go|java|c|cpp|swift|json|md)\b|\bsrc\/|\bpackage\.json\b|`[^`]+`/i, 2],
    [/(代码|实现|重构|修复|编写|脚本|测试)/, 2],
  ],
  operate: [
    [/\b(deploy|install|configure|set ?up|restart|server|mockup|slides?|presentation|click|browser|website|fill (in|out)|form|book|schedule|email|calendar|screenshot)\b/i, 2],
    [/\b(daily|every day|remind|organi[sz]e|clean up|download|upload|rename files|backup)\b/i, 1],
    [/(部署|安装|配置|操作|浏览器|日常|整理|邮件|日程|备份)/, 2],
  ],
};

const DEEP = /\b(thorough(ly)?|in[- ]depth|comprehensive|deep[- ]dive|carefully|end[- ]to[- ]end|audit|heavy)\b|(深入|全面|彻底|详细)/i;
const QUICK = /\b(quick(ly)?|briefly|just|only|one[- ]liner|simple|tiny|small)\b|(简单|快速|简要|一句话)/i;
const ORCHESTRATE = /\b(orchestrate|break (it|this) down|split (it|this) into|in parallel|several parts|multi[- ]step plan)\b|(分解|拆分|并行)/i;
const DESIGNATE = /^\s*@([a-z0-9][a-z0-9-]{0,31})\b\s*/i;
const SHORT = 160;
/** Facts that change over time: availability, eligibility, prices, policy, news. */
const FRESH = /\b(latest|current(ly)?|today|this (week|month|year)|news|price|pricing|cost|availab(le|ility)|apply|application|eligib(le|ility)|access|policy|regulation|deadline|release[sd]?|version|which .{0,40} can i|20[2-3]\d)\b|(最新|目前|现在|当前|今年|最近|申请|开放|获取|资格|价格|费用|政策|规定|截止|新闻|发布|版本|数据库|哪些.{0,20}(可以|能))/i;
/** Questions about the files on this machine do not need the web. */
const LOCAL = /\b(this (repo|codebase|project|file|folder|directory)|in (the )?(repo|codebase)|src\/|\.\/)|\.(ts|tsx|js|py|rs|go|json|md)\b|(这个(项目|仓库|代码|文件|目录)|本地)/i;
/** CJK text carries about three times the content per character of English. */
const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g;

function weight(input: string): number {
  return input.length + 2 * (input.match(CJK)?.length ?? 0);
}

function effortFor(input: string, route: Route | null, web: boolean): [Effort, string] {
  if (DEEP.test(input)) return ["deep", "asked for depth"];
  if (QUICK.test(input)) return ["quick", "asked for brevity"];
  if (web) return ["standard", "needs current facts"];
  const size = weight(input);
  if (size > 800) return ["deep", "long request"];
  if (size <= SHORT && !input.includes("\n") && route !== "build") return ["quick", "short request"];
  return ["standard", "default"];
}

function needsWeb(input: string): boolean {
  return FRESH.test(input) && !LOCAL.test(input);
}

export function route(raw: string): Decision {
  const at = DESIGNATE.exec(raw);
  const designated = at ? at[1]!.toLowerCase() : null;
  const input = at ? raw.slice(at[0].length) : raw;
  const shape: Shape = designated ? "designated" : ORCHESTRATE.test(input) ? "orchestrated" : "single";
  const scores = {} as Record<Route, number>;
  const hits: string[] = [];
  let total = 0;
  for (const [r, rules] of Object.entries(RULES) as [Route, [RegExp, number][]][]) {
    scores[r] = 0;
    for (const [re, weight] of rules) {
      const m = input.match(re);
      if (!m) continue;
      scores[r] += weight;
      total += weight;
      hits.push(`${r}:"${m[0]}"`);
    }
  }
  const tail = `${designated ? `; designated @${designated}` : ""}${shape === "orchestrated" ? "; asked to split" : ""}`;
  if (total === 0) {
    const web = needsWeb(input);
    const [effort, why] = effortFor(input, null, web);
    return { route: null, effort, shape, designated, confidence: 0, reason: `no routing signal; ${effort}: ${why}${web ? "; web" : ""}${tail}`, web, text: input };
  }
  const [best, score] = (Object.entries(scores) as [Route, number][]).sort((a, b) => b[1] - a[1])[0]!;
  const confidence = (score / total) * Math.min(1, score / 2);
  const web = needsWeb(input);
  const [effort, why] = effortFor(input, best, web);
  return { route: best, effort, shape, designated, confidence: Math.round(confidence * 100) / 100, reason: `${hits.join(", ")}; ${effort}: ${why}${web ? "; web" : ""}${tail}`, web, text: input };
}
