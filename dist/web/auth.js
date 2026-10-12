import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
/**
 * Password gate for the dashboard.
 *
 * The dashboard serves member names, attendance history and leave records, so
 * it ran loopback-only and unauthenticated. Hosting it at a public address
 * removes that protection, and Cloudflare in front is not enough on its own:
 * the origin (`us.monkey-network.xyz:<port>`) stays directly reachable, so
 * anyone who learns it would bypass the proxy entirely. The gate therefore
 * lives in the app.
 *
 * The cookie is an HMAC of a fixed string keyed by the password, so it needs no
 * server-side session store and survives restarts, but changing WEB_PASSWORD
 * invalidates every existing cookie.
 */
const COOKIE = "dash_auth";
const MAX_AGE_DAYS = 30;
function expectedToken(password) {
    return createHmac("sha256", password).update("dashboard-session-v1").digest("base64url");
}
/** Constant-time compare that tolerates length mismatch without throwing. */
function safeEqual(a, b) {
    const ab = Buffer.from(a);
    const bb = Buffer.from(b);
    if (ab.length !== bb.length)
        return false;
    return timingSafeEqual(ab, bb);
}
function cookieValue(header, name) {
    if (!header)
        return undefined;
    for (const part of header.split(";")) {
        const [k, ...rest] = part.trim().split("=");
        if (k === name)
            return decodeURIComponent(rest.join("="));
    }
    return undefined;
}
export function isAuthed(req) {
    const password = env.WEB_PASSWORD;
    if (!password)
        return true; // gate disabled (loopback-only mode)
    const got = cookieValue(req.headers.cookie, COOKIE);
    return got !== undefined && safeEqual(got, expectedToken(password));
}
const LOGIN_PAGE = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>CyArt Dashboard</title>
<style>
  :root { color-scheme: dark }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:15px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;
         background:#0f1115; color:#e7e9ee }
  form { width:min(360px,90vw); padding:28px; border:1px solid #262a33;
         border-radius:12px; background:#161922 }
  h1 { margin:0 0 4px; font-size:18px }
  p { margin:0 0 20px; color:#9aa1ad; font-size:13px }
  input { width:100%; box-sizing:border-box; padding:10px 12px; margin-bottom:12px;
          border:1px solid #2d323d; border-radius:8px; background:#0f1115; color:inherit }
  button { width:100%; padding:10px; border:0; border-radius:8px;
           background:#5865f2; color:#fff; font-weight:600; cursor:pointer }
  .err { color:#ff6b6b; font-size:13px; margin-bottom:12px }
</style></head>
<body><form method="post" action="/login">
  <h1>CyArt Intern Dashboard</h1>
  <p>Staff access only.</p>
  ${error ? '<div class="err">Incorrect password.</div>' : ""}
  <input type="password" name="password" placeholder="Password" autofocus autocomplete="current-password">
  <button type="submit">Sign in</button>
</form></body></html>`;
/**
 * Mountable auth routes + guard. No-ops entirely when WEB_PASSWORD is unset,
 * which keeps local development on loopback exactly as it was.
 */
export function authRoutes() {
    const password = env.WEB_PASSWORD;
    if (!password)
        return [];
    const token = expectedToken(password);
    const loginGet = (req, res, next) => {
        if (req.method !== "GET" || req.path !== "/login")
            return next();
        if (isAuthed(req))
            return res.redirect("/");
        res.type("html").send(LOGIN_PAGE(req.query.error === "1"));
    };
    const loginPost = (req, res, next) => {
        if (req.method !== "POST" || req.path !== "/login")
            return next();
        const supplied = String(req.body?.password ?? "");
        if (!safeEqual(supplied, password))
            return res.redirect("/login?error=1");
        res.cookie(COOKIE, token, {
            httpOnly: true,
            sameSite: "lax",
            secure: env.WEB_SECURE_COOKIE,
            maxAge: MAX_AGE_DAYS * 86400_000,
        });
        res.redirect("/");
    };
    const guard = (req, res, next) => {
        if (isAuthed(req))
            return next();
        // APIs get a status code; humans get the form.
        if (req.path.startsWith("/api/"))
            return res.status(401).json({ error: "unauthorized" });
        res.redirect("/login");
    };
    return [loginGet, loginPost, guard];
}
//# sourceMappingURL=auth.js.map