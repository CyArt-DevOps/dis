import { env } from "../config/env.js";
import { EmsHttpError, EmsNotJsonError, looksLikeChallenge } from "../lib/emsErrors.js";
import { signRequest } from "../lib/signing.js";
export { EmsHttpError };
export class IntegrationDisabled extends Error {
    constructor() {
        super("EMS integration is not configured");
    }
}
export function integrationEnabled() {
    return Boolean(env.EMS_API_URL && env.INTEGRATION_SECRET);
}
/** Signed POST to EMS `/api/integrations/dis<path>`. Throws on non-2xx. */
export async function emsPost(path, body, timeoutMs = 8000) {
    if (!env.EMS_API_URL || !env.INTEGRATION_SECRET)
        throw new IntegrationDisabled();
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
    if (!res.ok)
        throw new EmsHttpError(res.status, text);
    if (!text)
        return {};
    try {
        return JSON.parse(text);
    }
    catch {
        throw new EmsNotJsonError(res.status, res.headers.get("content-type") ?? "", looksLikeChallenge(text));
    }
}
//# sourceMappingURL=emsClient.js.map