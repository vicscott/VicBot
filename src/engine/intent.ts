/**
 * Whether a message shares an idea rather than asking for work. A heuristic with no model call:
 * an idea opener ("I think…", "what if…", 我觉得…) and no direct ask ("can you", "please", 帮我…) or problem report ("bug", 报错…).
 */
const OPENER = /^\s*(?:idea\s*[:：]|an idea\b|one idea\b|new idea\b|just a thought|a thought\b|thought\s*[:：]|i think\b|i feel\b|i believe\b|i guess\b|i wonder\b|i(?:'ve| have) been thinking\b|what if\b|how about\b|maybe (?:we|i|you|it|vicbot)\b|perhaps\b|it would be (?:nice|cool|great|good|useful)\b|wouldn'?t it be\b|we (?:could|should|might)\b|imagine\b|(?:我|我们)?(?:觉得|认为|感觉|在想|想到|突然想到|有个想法|有一个想法|有个点子)|想法\s*[:：]|一个想法|点子\s*[:：]|如果.{0,30}(?:会不会|是不是|怎么样|也许)|或许|也许|要是能|可以考虑)/i;
const REQUEST = /\b(?:can you|could you|would you|will you|please|pls|help me|tell me|show me|give me|i need you to|i want you to)\b|\b(?:bug|error|broken|crash(?:es|ed)?|fails?|failing|doesn'?t work|not working|wrong)\b|(?:报错|出错|坏了|不对|不行|失败|帮我|帮忙|请你?|麻烦你?|告诉我|你(?:能|可以)不能|你(?:能|可以).{0,6}吗|查一下|搜一下|找一下)/i;

export function isIdea(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 1500) return false;
  return OPENER.test(t) && !REQUEST.test(t);
}

/** What the quick worker is asked to do with an idea: react to it, not act on it. */
export function ideaGoal(idea: string): string {
  return [
    "The person shared an idea. It is not a request to do the work yet.",
    "Reply briefly, in the person's language, in at most 120 words:",
    "- restate the idea in one sentence,",
    "- its strongest point,",
    "- its biggest risk or open question,",
    "- one question that would help develop it.",
    "Do not research, write files or start the work. File a pass verdict.",
    "",
    "The idea:",
    idea,
  ].join("\n");
}

/** The goal when the person asks to take an idea further on a real route. */
export function developGoal(idea: string, route: "explore" | "build" | "operate"): string {
  const ask = route === "build" ? "Turn this idea into a first working version in the working root." : route === "operate" ? "Put this idea into practice with the tools you have, step by step." : "Develop this idea: what it would take, what exists already, the main options and risks, and a recommended next step.";
  return `${ask}\n\nThe person's idea:\n${idea}`;
}
