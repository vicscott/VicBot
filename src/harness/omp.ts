import { mkdirSync } from "node:fs";
import { piFamilyParser, systemFile } from "./pi";
import { drive, spawnJsonl } from "./proc";
import type { Adapter, HarnessRun, Manifest, RunSpec } from "./types";

const READ_TOOLS = "read,grep,glob";
const EDIT_TOOLS = "read,bash,edit,write,grep,glob";

export function ompArgv(cmd: string[], spec: RunSpec, file: string | null): string[] {
  const argv = [...cmd, "-p", "--mode=json", "--no-title", "--approval-mode=yolo", `--thinking=${spec.policy.thinking}`, `--cwd=${spec.cwd}`, `--session-dir=${spec.sessionDir}`];
  if (spec.policy.tools !== "all") argv.push(`--tools=${spec.policy.tools === "read" ? READ_TOOLS : EDIT_TOOLS}${spec.policy.web ? ",web_search" : ""}`);
  if (spec.resume) argv.push(`--resume=${spec.resume}`);
  if (file) argv.push(`--append-system-prompt=${file}`);
  argv.push(`--max-time=${spec.policy.maxMinutes * 60}`);
  argv.push(spec.prompt);
  return argv;
}

export function create(manifest: Manifest): Adapter {
  return {
    manifest,
    spawn(spec): HarnessRun {
      let session: string | null = spec.resume;
      mkdirSync(spec.sessionDir, { recursive: true });
      const proc = spawnJsonl(ompArgv(manifest.entry.cmd, spec, systemFile(spec)), { cwd: spec.cwd });
      return {
        events: drive(proc, piFamilyParser((id) => (session = id))),
        sessionId: () => session,
        kill: () => proc.kill(),
      };
    },
  };
}
