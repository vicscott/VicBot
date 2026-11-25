import { existsSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { Task } from "../types";

export type Baseline = Map<string, string | null>;

function hashFile(path: string): string | null {
  if (!existsSync(path) || !statSync(path).isFile()) return null;
  return new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex");
}

/** Hashes the named artifacts at run start; a pass needs at least one of them to change. */
export function takeBaseline(task: Task): Baseline {
  return new Map(task.contract.artifacts.map((p) => [p, hashFile(resolve(task.cwd, p))]));
}

export function changedArtifacts(task: Task, base: Baseline): string[] {
  return [...base].filter(([p, h]) => {
    const now = hashFile(resolve(task.cwd, p));
    return now !== null && now !== h;
  }).map(([p]) => p);
}
