/** True for a host's bot-check page (Hostinger/LiteSpeed reCAPTCHA, Cloudflare challenge) instead of our API. */
export function looksLikeChallenge(body) {
    return /Bot Verification|lsrecaptcha|grecaptcha|challenges\.cloudflare\.com|cf-chl/i.test(body.slice(0, 5000));
}
/** Non-2xx response from EMS. Kept free of env imports so it is cheap to share. */
export class EmsHttpError extends Error {
    status;
    challenge;
    constructor(status, body) {
        super(`EMS ${status}: ${body.slice(0, 200)}`);
        this.status = status;
        this.name = "EmsHttpError";
        this.challenge = looksLikeChallenge(body);
    }
}
/** A 2xx whose body is not JSON (e.g. a bot-check page served with 200). Carries no body text. */
export class EmsNotJsonError extends Error {
    status;
    contentType;
    challenge;
    constructor(status, contentType, challenge) {
        super(`EMS ${status}: not JSON (${contentType || "no content-type"})${challenge ? ", bot-check page" : ""}`);
        this.status = status;
        this.contentType = contentType;
        this.challenge = challenge;
        this.name = "EmsNotJsonError";
    }
}
/**
 * Short, body-free reason for logs: "http_401", "http_403_challenge", "not_json_challenge",
 * "timeout", "network_ECONNRESET", "disabled", ... Never includes response text (it may hold a password).
 */
export function describeEmsError(err) {
    if (err instanceof EmsHttpError)
        return `http_${err.status}${err.challenge ? "_challenge" : ""}`;
    if (err instanceof EmsNotJsonError)
        return err.challenge ? "not_json_challenge" : `not_json_${err.status}`;
    if (!(err instanceof Error))
        return "unknown";
    if (err.name === "TimeoutError" || err.name === "AbortError")
        return "timeout";
    if (err.name === "IntegrationDisabled" || err.message === "EMS integration is not configured")
        return "disabled";
    const cause = err.cause;
    if (cause && typeof cause.code === "string")
        return `network_${cause.code}`;
    if (cause && cause.name === "ConnectTimeoutError")
        return "network_connect_timeout";
    if (err.name === "TypeError" && /fetch failed/i.test(err.message))
        return "network_fetch_failed";
    return `error_${err.name}`;
}
/** A 4xx is a permanent rejection (retrying the same payload won't help) except timeout and rate limit. */
export function isRetryableEmsError(err) {
    if (!(err instanceof EmsHttpError))
        return true;
    return !(err.status >= 400 && err.status < 500) || err.status === 408 || err.status === 429;
}
//# sourceMappingURL=emsErrors.js.map