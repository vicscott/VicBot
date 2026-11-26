/** A small markdown subset rendered as DOM nodes. No innerHTML, so model text can never inject markup. */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  return node;
}

const INLINE = /(`[^`\n]+`)|(\*\*[^*\n]+?\*\*)|(\[[^\]\n]+\]\((https?:\/\/[^\s)]+)\))|(#t[0-9a-f]{10})|(https?:\/\/[^\s)<>\]，。；、]+)/g;

export function inline(text: string, onTask?: (id: string) => void): DocumentFragment {
  const frag = document.createDocumentFragment();
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) frag.append(text.slice(last, m.index));
    last = m.index + m[0].length;
    if (m[1]) {
      const code = el("code");
      code.textContent = m[1].slice(1, -1);
      frag.append(code);
    } else if (m[2]) {
      const b = el("strong");
      b.append(inline(m[2].slice(2, -2), onTask));
      frag.append(b);
    } else if (m[3]) {
      const a = el("a");
      a.href = m[4]!;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = m[3].slice(1, m[3].indexOf("]("));
      frag.append(a);
    } else if (m[5]) {
      const a = el("a", "ptr");
      a.textContent = m[5];
      if (onTask) a.onclick = () => onTask(m[5]!.slice(1));
      frag.append(a);
    } else if (m[6]) {
      const a = el("a");
      a.href = m[6];
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = m[6];
      frag.append(a);
    }
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

const cells = (line: string) => line.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());

export function markdown(text: string, onTask?: (id: string) => void): HTMLElement {
  const root = el("div", "md");
  const lines = text.replace(/\r/g, "").split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (/^```/.test(line)) {
      const body: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!); i++) body.push(lines[i]!);
      i++;
      const pre = el("pre");
      pre.textContent = body.join("\n");
      root.append(pre);
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const hx = el(`h${Math.min(6, heading[1]!.length + 2)}` as "h3");
      hx.append(inline(heading[2]!, onTask));
      root.append(hx);
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? "")) {
      const table = el("table");
      const head = el("tr");
      for (const c of cells(line)) {
        const th = el("th");
        th.append(inline(c, onTask));
        head.append(th);
      }
      table.append(head);
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]!); i++) {
        const tr = el("tr");
        for (const c of cells(lines[i]!)) {
          const td = el("td");
          td.append(inline(c, onTask));
          tr.append(td);
        }
        table.append(tr);
      }
      const wrap = el("div", "md-table");
      wrap.append(table);
      root.append(wrap);
      continue;
    }
    const item = /^\s*(?:[-*+]|(\d+)[.)])\s+(.*)$/.exec(line);
    if (item) {
      const list = el(item[1] ? "ol" : "ul");
      if (item[1] && item[1] !== "1") (list as HTMLOListElement).start = Number(item[1]);
      while (i < lines.length) {
        const m = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]!);
        if (!m) break;
        const li = el("li");
        li.append(inline(m[1]!, onTask));
        list.append(li);
        i++;
      }
      root.append(list);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quote = el("blockquote");
      const body: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]!); i++) body.push(lines[i]!.replace(/^\s*>\s?/, ""));
      quote.append(inline(body.join(" "), onTask));
      root.append(quote);
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      root.append(el("hr"));
      i++;
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    for (; i < lines.length; i++) {
      const l = lines[i]!;
      if (!l.trim() || /^(```|#{1,6}\s|\s*>|\s*(?:[-*+]|\d+[.)])\s)/.test(l) || (/^\s*\|.*\|\s*$/.test(l) && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1] ?? ""))) break;
      para.push(l);
    }
    const p = el("p");
    para.forEach((l, n) => {
      if (n) p.append(el("br"));
      p.append(inline(l, onTask));
    });
    root.append(p);
  }
  return root;
}
