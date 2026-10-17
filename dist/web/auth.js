import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../config/env.js";
import { FAVICON_PNG_B64, LOGO_PNG_B64 } from "./brand.js";
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
/**
 * Self-contained sign-in page in the dashboard's BagUI look. Everything it
 * needs (logo, favicon, styles) is inline: until the cookie exists, the guard
 * redirects every other path back here, so it cannot load app assets.
 */
const LOGIN_PAGE = (error) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="robots" content="noindex,nofollow">
<title>Sign in · CyArt Intern Ops</title>
<link rel="icon" type="image/png" href="data:image/png;base64,${FAVICON_PNG_B64}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; --bg:#050505; --panel:#0b0b0c; --panel2:#121214;
          --line:rgba(255,255,255,.08); --line2:rgba(255,255,255,.14);
          --fg:#fafafa; --muted:#a1a1aa; --dim:#71717a; --orange:#ff6b2c; --green:#5aa34a }
  * { box-sizing:border-box }
  html,body { height:100% }
  body { margin:0; min-height:100vh; display:grid; place-items:center; padding:24px 16px;
         background:var(--bg); color:var(--fg);
         font:15px/1.5 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
         -webkit-font-smoothing:antialiased; overflow-x:hidden; position:relative }
  /* engineering grid + the brand's two colours as faint glows */
  body::before { content:""; position:fixed; inset:0; pointer-events:none;
         background-image:linear-gradient(to right,rgba(255,255,255,.04) 1px,transparent 1px),
                          linear-gradient(to bottom,rgba(255,255,255,.04) 1px,transparent 1px);
         background-size:36px 36px;
         mask-image:radial-gradient(ellipse at center,#000 20%,transparent 70%) }
  body::after { content:""; position:fixed; inset:0; pointer-events:none;
         background:radial-gradient(600px 320px at 30% 18%,rgba(255,107,44,.13),transparent 70%),
                    radial-gradient(600px 320px at 72% 22%,rgba(90,163,74,.12),transparent 70%) }
  main { position:relative; z-index:1; width:min(400px,100%) }
  .card { border:1px solid var(--line); border-radius:20px; background:rgba(11,11,12,.85);
          backdrop-filter:blur(12px); padding:36px 32px 28px;
          box-shadow:0 30px 80px -20px rgba(0,0,0,.8), inset 0 1px 0 rgba(255,255,255,.04) }
  .logo { display:block; width:76px; height:76px; margin:0 auto 18px;
          filter:drop-shadow(0 8px 24px rgba(255,107,44,.18)) drop-shadow(0 8px 24px rgba(90,163,74,.14)) }
  .pill { display:flex; width:max-content; margin:0 auto 14px; align-items:center; gap:8px;
          border:1px solid var(--line); background:var(--panel); border-radius:999px;
          padding:4px 12px; font-size:11px; color:var(--muted) }
  .dot { width:6px; height:6px; border-radius:50%; background:#34d399; box-shadow:0 0 0 3px rgba(52,211,153,.15) }
  h1 { margin:0; text-align:center; font-size:26px; font-weight:600; letter-spacing:-.02em;
       background:linear-gradient(180deg,#fafafa 0%,#a1a1aa 130%); -webkit-background-clip:text;
       background-clip:text; color:transparent }
  .sub { margin:6px 0 26px; text-align:center; color:var(--muted); font-size:14px }
  label { display:block; font-size:12px; color:var(--muted); margin:0 0 6px }
  .field { position:relative }
  input { width:100%; height:44px; padding:0 44px 0 16px; border-radius:999px;
          border:1px solid var(--line2); background:var(--panel); color:var(--fg);
          font:inherit; font-size:15px; outline:none; transition:border-color .15s, box-shadow .15s }
  input::placeholder { color:var(--dim) }
  input:focus { border-color:rgba(255,255,255,.3); box-shadow:0 0 0 4px rgba(255,255,255,.06) }
  .err input { border-color:rgba(251,113,133,.5) }
  .toggle { position:absolute; right:6px; top:6px; width:32px; height:32px; border:0; border-radius:999px;
            background:transparent; color:var(--dim); cursor:pointer; display:grid; place-items:center }
  .toggle:hover { color:var(--fg); background:rgba(255,255,255,.06) }
  .msg { display:flex; gap:8px; align-items:center; margin:12px 0 0; padding:9px 12px;
         border:1px solid rgba(251,113,133,.25); background:rgba(251,113,133,.06);
         border-radius:12px; color:#fda4af; font-size:13px }
  button[type=submit] { width:100%; height:44px; margin-top:16px; border:0; border-radius:999px;
          background:#fafafa; color:#000; font:inherit; font-weight:600; font-size:15px;
          cursor:pointer; transition:background .15s, transform .05s }
  button[type=submit]:hover { background:#e4e4e7 }
  button[type=submit]:active { transform:translateY(1px) }
  button[type=submit]:disabled { opacity:.6; cursor:progress }
  .foot { display:flex; justify-content:center; gap:6px; align-items:center; margin-top:22px;
          color:var(--dim); font-size:12px }
  .brand { margin-top:18px; text-align:center; color:var(--dim); font-size:12px }
  .brand b { color:var(--muted); font-weight:500 }
  @media (max-width:420px) { .card { padding:28px 20px 22px } h1 { font-size:23px } }
</style></head>
<body><main>
  <form class="card${error ? " err" : ""}" method="post" action="/login" autocomplete="on">
    <img class="logo" alt="CyArt" src="data:image/png;base64,${LOGO_PNG_B64}">
    <div class="pill"><span class="dot"></span>Intern Ops · staff only</div>
    <h1>Welcome back</h1>
    <p class="sub">Sign in to the CyArt attendance dashboard.</p>
    <label for="pw">Password</label>
    <div class="field">
      <input id="pw" type="password" name="password" placeholder="Enter dashboard password"
             autofocus required autocomplete="current-password" aria-invalid="${error ? "true" : "false"}">
      <button class="toggle" type="button" aria-label="Show password" onclick="var i=document.getElementById('pw');var s=i.type==='password';i.type=s?'text':'password';this.setAttribute('aria-label',s?'Hide password':'Show password')">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
      </button>
    </div>
    ${error ? '<div class="msg" role="alert"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 8v5M12 16h.01"/></svg>Incorrect password. Try again.</div>' : ""}
    <button type="submit" onclick="var f=this.form;if(f.checkValidity()){var b=this;setTimeout(function(){b.disabled=true;b.textContent='Signing in…'},0)}">Sign in</button>
    <div class="foot">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="4" y="10.5" width="16" height="10" rx="2.5"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/></svg>
      Encrypted session · stays signed in for ${MAX_AGE_DAYS} days
    </div>
  </form>
  <p class="brand">© ${new Date().getFullYear()} <b>CyArt</b> · Intern attendance &amp; operations</p>
</main></body></html>`;
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