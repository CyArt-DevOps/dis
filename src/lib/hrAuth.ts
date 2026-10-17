import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Per-HR credentials for sensitive dashboard actions (leave grants, warnings,
 * terminations, holidays). The shared dashboard password only gets someone to
 * the page; every write is then signed off by a named HR member with their own
 * password, so the audit trail names a verified person.
 *
 * Pure crypto helpers live here so they can be unit-tested without a database.
 */

const N = 16384;
const KEYLEN = 32;

/** "scrypt$N$salt$hash", all base64url. */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, KEYLEN, { N });
  return `scrypt$${N}$${salt.toString("base64url")}$${hash.toString("base64url")}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [alg, n, salt, hash] = stored.split("$");
  if (alg !== "scrypt" || !n || !salt || !hash) return false;
  const expected = Buffer.from(hash, "base64url");
  const got = scryptSync(password, Buffer.from(salt, "base64url"), expected.length, { N: Number(n) });
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Readable but strong: 4 groups of 4 from an unambiguous alphabet (~80 bits). */
export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  let out = "";
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i]! % alphabet.length];
    if (i % 4 === 3 && i < 15) out += "-";
  }
  return out;
}

/**
 * Short-lived proof that an HR member verified, so they aren't asked for
 * their password on every click. HMAC-signed with a per-process secret:
 * restarting the bot simply asks everyone to verify again.
 */
export interface HrClaims {
  id: number;
  name: string;
  exp: number; // epoch ms
}

export function signToken(claims: HrClaims, secret: Buffer): string {
  const body = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const sig = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function readToken(token: string, secret: Buffer, now = Date.now()): HrClaims | null {
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const got = Buffer.from(sig, "base64url");
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(body, "base64url").toString()) as HrClaims;
    if (typeof claims.id !== "number" || typeof claims.name !== "string" || typeof claims.exp !== "number") return null;
    return claims.exp > now ? claims : null;
  } catch {
    return null;
  }
}

/**
 * Failed-attempt limiter: after `max` failures inside `windowMs` a key is
 * locked until the window passes. Keys are per HR name and per client IP, so
 * neither guessing one person's password nor spraying many names works.
 */
export class Lockout {
  private fails = new Map<string, number[]>();
  constructor(private max = 5, private windowMs = 15 * 60_000) {}

  lockedFor(key: string, now = Date.now()): number {
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    this.fails.set(key, recent);
    if (recent.length < this.max) return 0;
    return this.windowMs - (now - recent[0]!);
  }

  fail(key: string, now = Date.now()): void {
    const recent = (this.fails.get(key) ?? []).filter((t) => now - t < this.windowMs);
    recent.push(now);
    this.fails.set(key, recent);
  }

  clear(key: string): void {
    this.fails.delete(key);
  }
}
