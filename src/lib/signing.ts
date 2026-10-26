import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Request signing shared with the EMS portal (api/services/disSigning.js).
 * Both sides must produce the same hex for the same inputs — the test vector in
 * tests/signing.test.ts is duplicated in the EMS repo to keep them in step.
 */
export const MAX_SKEW_MS = 5 * 60_000;

export function signRequest(secret: string, timestamp: string, method: string, path: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${method.toUpperCase()}.${path}.${body}`).digest("hex");
}

export function verifyRequest(a: {
  secret: string;
  timestamp: string;
  method: string;
  path: string;
  body: string;
  signature: string;
  now?: number;
}): boolean {
  const ts = Number(a.timestamp);
  if (!Number.isFinite(ts) || Math.abs((a.now ?? Date.now()) - ts) > MAX_SKEW_MS) return false;
  const want = Buffer.from(signRequest(a.secret, a.timestamp, a.method, a.path, a.body));
  const got = Buffer.from(a.signature ?? "");
  return got.length === want.length && timingSafeEqual(got, want);
}
