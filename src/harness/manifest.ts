import { ROUTES } from "../types";
import type { Manifest } from "./types";

const ROLES = ["worker", "verify", "chair", "tune"];

function fail(id: string, msg: string): never {
  throw new Error(`manifest ${id}: ${msg}`);
}

function strings(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

/** Validates a harness.json. Protocol major must be 1; unknown fields are ignored. */
export function parseManifest(raw: unknown): Manifest {
  if (!raw || typeof raw !== "object") throw new Error("manifest: not an object");
  const m = raw as Record<string, unknown>;
  const id = typeof m.id === "string" && /^[a-z0-9][a-z0-9-]{0,31}$/.test(m.id) ? m.id : fail(String(m.id), "id must be lowercase [a-z0-9-]");
  if (typeof m.protocol !== "string" || m.protocol.split(".")[0] !== "1") fail(id, `unsupported protocol ${String(m.protocol)}`);
  const entry = m.entry as Record<string, unknown> | undefined;
  if (!entry || (entry.kind !== "in-process" && entry.kind !== "stdio")) fail(id, "entry.kind must be in-process or stdio");
  if (!strings(entry.cmd) || entry.cmd.length === 0) fail(id, "entry.cmd must be a non-empty string array");
  if (entry.kind === "in-process" && typeof entry.module !== "string") fail(id, "in-process entry needs a module");
  const caps = (m.capabilities ?? {}) as Record<string, unknown>;
  const routes = strings(m.routes) ? m.routes : fail(id, "routes must be a string array");
  for (const r of routes) if (!(ROUTES as readonly string[]).includes(r)) fail(id, `unknown route ${r}`);
  const roles = strings(m.roles) ? m.roles : ["worker"];
  for (const r of roles) if (!ROLES.includes(r)) fail(id, `unknown role ${r}`);
  const serves = Array.isArray(m.serves) ? (m.serves as Manifest["serves"]) : [];
  return {
    id,
    name: typeof m.name === "string" ? m.name : id,
    protocol: m.protocol as string,
    entry: entry as Manifest["entry"],
    probe: strings(m.probe) ? m.probe : ["--version"],
    capabilities: {
      approvals: caps.approvals === true,
      steering: caps.steering === true,
      resume: caps.resume === "cursor" ? "cursor" : "none",
      effort: strings(caps.effort) ? caps.effort : [],
      sandbox: strings(caps.sandbox) ? caps.sandbox : [],
      images: caps.images === true,
      system: caps.system === "append" ? "append" : "preamble",
      web: caps.web === true,
    },
    routes: routes as Manifest["routes"],
    serves,
    roles: roles as Manifest["roles"],
    rank: typeof m.rank === "number" ? m.rank : 100,
    cost: m.cost === "api" || m.cost === "free" ? m.cost : "subscription",
    test: m.test === true,
  };
}
