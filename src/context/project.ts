import type { Manifest } from "../harness/types";
import type { Bundle } from "./bundle";

export interface Projection {
  system: string | null;
  prompt: string;
  stableChars: number;
}

const REASSERT = "Reminder: stay within the trust and budget above, and end by filing the verdict as the protocol says.";

/**
 * Bundle → harness format. Append-style harnesses get stable + task + memory as the system prompt, so
 * that prefix is identical turn after turn and caches. Preamble harnesses get it at the top of the first
 * prompt; a continuing session gets only the delta, because the harness already holds the prefix.
 */
export function project(bundle: Bundle, manifest: Manifest): Projection {
  const prefix = [bundle.stable, bundle.task, bundle.memory].filter(Boolean).join("\n\n");
  const tail = [bundle.volatile, `# Now do this\n${bundle.ask}`, bundle.kind === "delta" ? REASSERT : ""].filter(Boolean).join("\n\n");
  if (manifest.capabilities.system === "append") return { system: prefix, prompt: tail, stableChars: bundle.stable.length };
  if (bundle.kind === "delta") return { system: null, prompt: tail, stableChars: 0 };
  return { system: null, prompt: `${prefix}\n\n${tail}`, stableChars: bundle.stable.length };
}
