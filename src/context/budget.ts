export interface Section {
  name: string;
  text: string;
  /** Lower is cut first. Sections without a priority are never cut. */
  cutOrder?: number;
  /** Which end survives a cut. */
  keep?: "head" | "tail";
}

/** Cuts sections in a fixed order until the total fits, and reports what was cut. */
export function fitContext(sections: Section[], maxChars: number): { sections: Section[]; cut: string[] } {
  const out = sections.map((s) => ({ ...s }));
  const cut: string[] = [];
  let total = out.reduce((n, s) => n + s.text.length, 0);
  const order = out.filter((s) => s.cutOrder !== undefined).sort((a, b) => a.cutOrder! - b.cutOrder!);
  for (const s of order) {
    if (total <= maxChars) break;
    const over = total - maxChars;
    const room = Math.max(0, s.text.length - over - 40);
    const before = s.text.length;
    s.text = room === 0 ? "" : s.keep === "tail" ? `[… cut]\n${s.text.slice(-room)}` : `${s.text.slice(0, room)}\n[… cut]`;
    total -= before - s.text.length;
    cut.push(room === 0 ? s.name : `${s.name} (partly)`);
  }
  return { sections: out, cut };
}
