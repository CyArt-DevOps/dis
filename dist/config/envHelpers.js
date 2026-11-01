const SECRET_KEYS = ["DIS_API_KEY", "INTEGRATION_SECRET"];
const MIN_SECRET_LENGTH = 32;
/**
 * A misconfigured integration variable must not stop the bot: it is treated as
 * unset (integration off) with a warning that names the variable, never its value.
 */
export function sanitizeIntegrationEnv(raw, warn = (m) => console.warn(m)) {
    const out = {};
    for (const key of SECRET_KEYS) {
        const v = raw[key];
        if (!v)
            continue;
        if (v.length < MIN_SECRET_LENGTH) {
            warn(`${key} is shorter than ${MIN_SECRET_LENGTH} characters; ignoring it (EMS integration disabled).`);
            continue;
        }
        out[key] = v;
    }
    const url = raw.EMS_API_URL;
    if (url) {
        if (URL.canParse(url))
            out.EMS_API_URL = url;
        else
            warn("EMS_API_URL is not a valid URL; ignoring it (EMS integration disabled).");
    }
    return out;
}
//# sourceMappingURL=envHelpers.js.map