import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HARNESS_DIR } from "../config";
import * as codex from "./codex";
import { parseManifest } from "./manifest";
import * as nullHarness from "./null";
import * as omp from "./omp";
import * as pi from "./pi";
import * as stdio from "./stdio";
import type { Adapter, Manifest } from "./types";

const MODULES: Record<string, (m: Manifest) => Adapter> = {
  pi: pi.create,
  omp: omp.create,
  codex: codex.create,
  null: nullHarness.create,
};

export interface Installed {
  manifest: Manifest;
  adapter: Adapter;
  available: boolean;
  version: string | null;
  problem: string | null;
}

let installed: Installed[] = [];

function wanted(): Set<string> | null {
  const only = process.env.VICBOT_HARNESSES;
  return only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
}

async function probe(m: Manifest): Promise<{ available: boolean; version: string | null; problem: string | null }> {
  if (m.entry.kind === "in-process" && m.entry.module === "null") return { available: true, version: "null", problem: null };
  const bin = m.entry.cmd[0]!;
  const path = Bun.which(bin);
  if (!path) return { available: false, version: null, problem: `${bin} not found on PATH` };
  try {
    const child = Bun.spawn([path, ...m.probe], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    const timer = setTimeout(() => child.kill(), 8000);
    const out = await new Response(child.stdout).text();
    const code = await child.exited;
    clearTimeout(timer);
    const version = out.trim().split("\n")[0]?.slice(0, 80) ?? null;
    return code === 0 ? { available: true, version, problem: null } : { available: false, version, problem: `probe exited ${code}` };
  } catch (err) {
    return { available: false, version: null, problem: (err as Error).message };
  }
}

/** Scans harnesses/*.json, validates each manifest and probes its binary. */
export async function loadHarnesses(dir = HARNESS_DIR): Promise<Installed[]> {
  const only = wanted();
  const found: Installed[] = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let manifest: Manifest;
    try {
      manifest = parseManifest(JSON.parse(readFileSync(join(dir, file), "utf8")));
    } catch (err) {
      console.warn(`skipping ${file}: ${(err as Error).message}`);
      continue;
    }
    if (only ? !only.has(manifest.id) : manifest.test) continue;
    const make = manifest.entry.kind === "stdio" ? stdio.create : MODULES[manifest.entry.module];
    if (!make) {
      console.warn(`skipping ${file}: unknown module ${manifest.entry.kind === "in-process" ? manifest.entry.module : ""}`);
      continue;
    }
    found.push({ manifest, adapter: make(manifest), ...(await probe(manifest)) });
  }
  installed = found.sort((a, b) => a.manifest.rank - b.manifest.rank);
  return installed;
}

export function harnesses(): Installed[] {
  return installed;
}

export function available(): Installed[] {
  return installed.filter((h) => h.available);
}

export function harness(id: string): Installed | null {
  return installed.find((h) => h.manifest.id === id) ?? null;
}

/** For tests: install adapters directly. */
export function setHarnesses(list: Installed[]): void {
  installed = [...list].sort((a, b) => a.manifest.rank - b.manifest.rank);
}
