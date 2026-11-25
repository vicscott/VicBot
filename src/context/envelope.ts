import { LIMITS } from "../config";

function attr(v: string): string {
  return v.replace(/[^\w.:-]/g, "_").slice(0, 64);
}

/** Escapes our own markers so untrusted text cannot close an envelope or forge a verdict. */
export function escapeMarkers(text: string): string {
  return text.replace(/<(\/?)(external|verdict)/gi, "&lt;$1$2");
}

/** Wraps text that did not come from VicBot itself: notes, tool output, results of other runs. */
export function envelope(source: string, id: string, text: string, cap = LIMITS.envelopeChars): string {
  let body = escapeMarkers(text);
  if (body.length > cap) body = body.slice(0, cap) + `\n[… ${body.length - cap} characters cut]`;
  return `<external source="${attr(source)}" id="${attr(id)}" trust="untrusted">\n${body}\n</external>`;
}
