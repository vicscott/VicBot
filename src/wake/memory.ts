import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LIMITS, MEMORY_DIR } from "../config";
import type { MemoryWrite } from "../types";

const dir = () => process.env.VICBOT_MEMORY_DIR ?? MEMORY_DIR;
const shortDir = (taskId: string) => join(dir(), "short", safe(taskId));
const notesDir = () => join(dir(), "long", "notes");

export function safe(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "note";
}

/** Every write goes through a temp file and a rename, so a reader never sees half a file. */
export function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, path);
}

function read(path: string): string {
  return existsSync(path) ? readFileSync(path, "utf8") : "";
}

export function ensureMemory(): void {
  for (const sub of ["short", "long/notes", "archive"]) mkdirSync(join(dir(), sub), { recursive: true });
  if (!existsSync(join(dir(), "long", "instructions.md"))) writeAtomic(join(dir(), "long", "instructions.md"), "# Standing instructions\n\n");
  if (!existsSync(join(dir(), "manifest.md"))) rebuildManifest();
}

export function manifest(): string {
  return read(join(dir(), "manifest.md"));
}

export function instructions(): string {
  return read(join(dir(), "long", "instructions.md"));
}

export function progress(taskId: string): string {
  return read(join(shortDir(taskId), "progress.md"));
}

/** progress.md keeps its newest lines within the cap. */
export function appendProgress(taskId: string, line: string): void {
  const path = join(shortDir(taskId), "progress.md");
  let text = read(path) + `- ${new Date().toISOString().slice(0, 16)} ${line.replace(/\s+/g, " ").trim()}\n`;
  if (text.length > LIMITS.progressChars) text = text.slice(text.indexOf("\n", text.length - LIMITS.progressChars) + 1);
  writeAtomic(path, text);
}

export function told(taskId: string, text: string): void {
  const path = join(shortDir(taskId), "told.md");
  writeAtomic(path, read(path) + `- ${new Date().toISOString().slice(0, 16)} ${text.replace(/\s+/g, " ").slice(0, 300)}\n`);
}

export interface LongNote {
  key: string;
  subject: string;
  text: string;
  updated: string;
  source: string;
}

function parseNote(key: string, raw: string): LongNote {
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(raw);
  const meta: Record<string, string> = {};
  for (const line of (fm?.[1] ?? "").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) meta[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return { key, subject: meta.subject ?? key, updated: meta.updated ?? "", source: meta.source ?? "", text: raw.slice(fm?.[0].length ?? 0).trim() };
}

export function longNotes(): LongNote[] {
  if (!existsSync(notesDir())) return [];
  return readdirSync(notesDir())
    .filter((f) => f.endsWith(".md"))
    .map((f) => parseNote(f.slice(0, -3), readFileSync(join(notesDir(), f), "utf8")));
}

/** One fact per file for long memory; short memory facts go to the task's facts.md. */
export function remember(taskId: string, w: MemoryWrite): string {
  const text = w.text.trim().slice(0, 2000);
  if (!text) return "";
  if (w.scope === "short") {
    const path = join(shortDir(taskId), "facts.md");
    writeAtomic(path, read(path) + `- ${safe(w.key)}: ${text.replace(/\n/g, " ")}\n`);
    return path;
  }
  const key = safe(w.key);
  const path = join(notesDir(), `${key}.md`);
  const subject = safe(w.subject ?? w.key);
  writeAtomic(path, `---\nkey: ${key}\nsubject: ${subject}\nupdated: ${new Date().toISOString()}\nsource: ${safe(taskId)}\n---\n${text}\n`);
  rebuildManifest();
  return path;
}

/** The manifest is derived from the files and can always be rebuilt. */
export function rebuildManifest(): string {
  const notes = longNotes().sort((a, b) => a.key.localeCompare(b.key));
  const lines = ["# Memory manifest", "", "Long notes (one fact per file in long/notes/):"];
  for (const n of notes) lines.push(`- ${n.key} [${n.subject}]: ${n.text.split("\n")[0]!.slice(0, 120)}`);
  if (!notes.length) lines.push("- (none yet)");
  const text = lines.join("\n") + "\n";
  writeAtomic(join(dir(), "manifest.md"), text);
  return text;
}

/** The keeper never deletes: it moves a finished task's short memory into archive/. */
export function archiveShort(taskId: string): boolean {
  const from = shortDir(taskId);
  if (!existsSync(from)) return false;
  const to = join(dir(), "archive", `short-${safe(taskId)}-${Date.now()}`);
  mkdirSync(dirname(to), { recursive: true });
  renameSync(from, to);
  return true;
}

export function shortTasks(): { taskId: string; mtime: number }[] {
  const root = join(dir(), "short");
  if (!existsSync(root)) return [];
  return readdirSync(root).map((taskId) => ({ taskId, mtime: statSync(join(root, taskId)).mtimeMs }));
}

export function memoryDir(): string {
  return dir();
}
