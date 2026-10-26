import { env } from "../config/env.js";
import { EmsHttpError } from "../lib/emsErrors.js";
import { signRequest } from "../lib/signing.js";

export { EmsHttpError };

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
  return (text ? JSON.parse(text) : {}) as T;
}
