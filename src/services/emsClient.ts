import { env } from "../config/env.js";
import { EmsHttpError, EmsNotJsonError, looksLikeChallenge } from "../lib/emsErrors.js";
import { signRequest } from "../lib/signing.js";
import { EmsBreaker, EmsCoolingDown } from "../lib/emsBreaker.js";

export { EmsHttpError, EmsCoolingDown };

/** Shared by every EMS call: they all leave from the bot's one IP. */
// The logger is loaded lazily: this module stays free of logger/env side effects for its tests.
export let emsBreaker = new EmsBreaker(Date.now, (e) => {
  void import("../core/logger.js")
    .then(({ logger }) => {
      if (e.type === "opened") logger.warn({ until: e.until.toISOString() }, "EMS calls paused: host is blocking or resetting the bot");
      else logger.info("EMS calls resumed");
    })
    .catch(() => undefined);
});
/** Tests only. */
export function resetEmsBreaker(b: EmsBreaker = new EmsBreaker()): void {
  emsBreaker = b;
}

export class IntegrationDisabled extends Error {
  constructor() {
    super("EMS integration is not configured");
  }
}

export function integrationEnabled(): boolean {
  return Boolean(env.EMS_API_URL && env.INTEGRATION_SECRET);
}

/** Signed POST to EMS `/api/integrations/dis<path>`. Throws on non-2xx. */
export async function emsPost<T = unknown>(path: string, body: unknown, timeoutMs = 8000): Promise<T> {
  if (!env.EMS_API_URL || !env.INTEGRATION_SECRET) throw new IntegrationDisabled();
  const probe = emsBreaker.before();
  try {
    const out = await emsPostOnce<T>(path, body, timeoutMs);
    emsBreaker.success();
    return out;
  } catch (err) {
    emsBreaker.failure(err, probe);
    throw err;
  }
}

async function emsPostOnce<T>(path: string, body: unknown, timeoutMs: number): Promise<T> {
  if (!env.EMS_API_URL || !env.INTEGRATION_SECRET) throw new IntegrationDisabled();
  const fullPath = `/api/integrations/dis${path}`;
  const raw = JSON.stringify(body);
  const ts = String(Date.now());
  const res = await fetch(`${env.EMS_API_URL.replace(/\/+$/, "")}${fullPath}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-DIS-Timestamp": ts,
      "X-DIS-Signature": signRequest(env.INTEGRATION_SECRET, ts, "POST", fullPath, raw),
    },
    body: raw,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (!res.ok) throw new EmsHttpError(res.status, text);
  if (!text) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new EmsNotJsonError(res.status, res.headers.get("content-type") ?? "", looksLikeChallenge(text));
  }
}
