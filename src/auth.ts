import { EXTRA_HOSTS, HOST, PORT, TIMERS } from "./config";
import type { Actor } from "./engine/tasks";
import { db, newId } from "./store";
import type { Device, Scope } from "./types";

const ALNUM = [[48, 10], [65, 26], [97, 26]].flatMap(([start, n]) => Array.from({ length: n! }, (_, i) => String.fromCharCode(start! + i))).join("");
const LOOPBACK_IPS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);
const LOOPBACK_HOSTS = [`127.0.0.1:${PORT}`, `localhost:${PORT}`, `[::1]:${PORT}`];

export function allowedHosts(): string[] {
  return [...new Set([...LOOPBACK_HOSTS, `${HOST}:${PORT}`, ...EXTRA_HOSTS])];
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

function randomCode(len: number, alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("");
}

/** A pair code is valid for five minutes and redeemable once. Only its hash is stored. */
export function createPairCode(scope: Scope): { code: string; expiresAt: number } {
  const code = randomCode(8);
  const expiresAt = Date.now() + TIMERS.pairCodeMs;
  db().addPairCode(sha256(code), scope, expiresAt);
  return { code, expiresAt };
}

let failedPairs: number[] = [];

export function redeemPairCode(code: string, name: string): { device: Device; token: string } {
  const now = Date.now();
  failedPairs = failedPairs.filter((t) => now - t < TIMERS.pairCodeMs);
  if (failedPairs.length >= 10) throw new Error("too many failed pairing attempts; wait a few minutes");
  const scope = db().redeemPairCode(sha256(code.trim().toUpperCase()));
  if (!scope) {
    failedPairs.push(now);
    throw new Error("that code is wrong, used or expired");
  }
  const token = `vb_${randomCode(40, ALNUM)}`;
  const device: Device = { id: newId("d_"), name: name.trim().slice(0, 60) || "device", scope: scope as Scope, createdAt: now, lastSeen: now, revoked: false };
  db().addDevice(device, sha256(token));
  db().ledger({ taskId: null, runId: null, action: "device.pair", initiator: "person", device: device.id, detail: { name: device.name, scope } });
  return { device, token };
}

export function revokeDevice(id: string, by: Actor): Device {
  const device = db().devices().find((d) => d.id === id);
  if (!device) throw new Error("no such device");
  device.revoked = true;
  db().updateDevice(device);
  db().ledger({ taskId: null, runId: null, action: "device.revoke", initiator: "person", device: by.device, detail: { id } });
  return device;
}

const seen = new Map<string, number>();

/**
 * The local browser and CLI on this machine are trusted as a full-scope device: the request must come
 * from a loopback address with a loopback Host header. Everything else needs a paired device token.
 */
export function authenticate(req: Request, ip: string | null): Actor | null {
  const host = req.headers.get("host") ?? "";
  if (ip && LOOPBACK_IPS.has(ip) && LOOPBACK_HOSTS.includes(host) && process.env.VICBOT_LOCAL_TRUST !== "0") return { device: "local", scope: "full" };
  const header = req.headers.get("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : new URL(req.url).searchParams.get("token");
  if (!token) return null;
  const device = db().deviceByToken(sha256(token));
  if (!device || device.revoked) return null;
  const last = seen.get(device.id) ?? 0;
  if (Date.now() - last > 60_000) {
    seen.set(device.id, Date.now());
    db().updateDevice({ ...device, lastSeen: Date.now() });
  }
  return { device: device.id, scope: device.scope };
}
