import type { RequestHandler } from "express";
import { FAVICON_PNG_B64, LOGO_PNG_B64 } from "./brand.js";

/**
 * Public Terms of Service and Privacy Policy for the BotCy Discord app.
 * These are the ONLY pages served without the dashboard password: Discord's
 * app verification and anyone using the bot must be able to read them.
 * Mounted before the auth guard in server.ts.
 */

const UPDATED = "19 October 2026";
const CONTACT = "inquiry@cyart.io";

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${title} · BotCy by CyArt</title>
<link rel="icon" type="image/png" href="data:image/png;base64,${FAVICON_PNG_B64}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
<style>
  :root { color-scheme: dark; --bg:#050505; --panel:#0b0b0c; --line:rgba(255,255,255,.08); --fg:#fafafa; --muted:#a1a1aa; --dim:#71717a; --orange:#ff6b2c; --green:#5aa34a }
  * { box-sizing:border-box }
  body { margin:0; background:var(--bg); color:var(--fg); font:16px/1.7 Geist,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif; -webkit-font-smoothing:antialiased }
  header { border-bottom:1px solid var(--line); background:var(--panel) }
  .bar { max-width:820px; margin:0 auto; padding:16px; display:flex; align-items:center; gap:12px }
  .bar img { width:34px; height:34px }
  .bar b { font-weight:600 }
  .bar nav { margin-left:auto; display:flex; gap:16px; font-size:14px }
  a { color:#fafafa; text-underline-offset:3px } nav a { color:var(--muted); text-decoration:none } nav a:hover, nav a.on { color:var(--fg) }
  main { max-width:820px; margin:0 auto; padding:40px 16px 80px }
  h1 { margin:0; font-size:34px; letter-spacing:-.02em; background:linear-gradient(180deg,#fafafa,#a1a1aa 130%); -webkit-background-clip:text; background-clip:text; color:transparent }
  .meta { color:var(--dim); font-size:14px; margin:6px 0 28px }
  h2 { font-size:19px; margin:34px 0 8px; padding-bottom:6px; border-bottom:1px solid var(--line) }
  h2::after { content:""; display:block; width:28px; height:2px; margin-top:8px; background:linear-gradient(90deg,var(--orange) 64%,var(--green) 64%) }
  p, li { color:#d4d4d8 } ul { padding-left:20px } li { margin:4px 0 }
  .note { border:1px solid var(--line); background:var(--panel); border-radius:14px; padding:14px 16px; color:var(--muted); font-size:14px }
  footer { border-top:1px solid var(--line); color:var(--dim); font-size:13px; text-align:center; padding:24px 16px }
</style></head><body>
<header><div class="bar"><img alt="CyArt" src="data:image/png;base64,${LOGO_PNG_B64}"><b>BotCy</b><span style="color:var(--dim)">by CyArt</span>
<nav><a href="/terms"${title.startsWith("Terms") ? ' class="on"' : ""}>Terms</a><a href="/privacy"${title.startsWith("Privacy") ? ' class="on"' : ""}>Privacy</a></nav></div></header>
<main><h1>${title}</h1><div class="meta">Last updated ${UPDATED}</div>${body}</main>
<footer>© ${new Date().getFullYear()} CyArt · <a href="mailto:${CONTACT}">${CONTACT}</a> · <a href="https://www.cyart.io">www.cyart.io</a></footer>
</body></html>`;
}

const TERMS = page(
  "Terms of Service",
  `
<p>These Terms govern your use of <b>BotCy</b> (the "Bot"), a Discord application operated by CyArt ("CyArt", "we", "us") to run its internship programme, together with the related attendance dashboard. By joining a Discord server where the Bot is installed, or by interacting with it, you agree to these Terms.</p>

<h2>1. What the Bot does</h2>
<p>BotCy is an internal tool for CyArt's internship programme. It verifies members and assigns roles by batch, project, module and pod; records voice-channel attendance; schedules meetings and records meeting attendance; handles leave requests and support tickets; posts attendance summaries; and lets authorised HR staff issue formal warnings and generate attendance reports.</p>

<h2>2. Who may use it</h2>
<ul>
<li>You must meet Discord's minimum age and follow Discord's <a href="https://discord.com/terms">Terms of Service</a> and <a href="https://discord.com/guidelines">Community Guidelines</a>.</li>
<li>The Bot is intended for CyArt interns, staff and invited participants of CyArt servers. It is not offered as a public service.</li>
</ul>

<h2>3. Your responsibilities</h2>
<ul>
<li>Provide accurate information during verification and in leave requests or tickets.</li>
<li>Do not misuse the Bot, attempt to manipulate attendance records, interfere with its operation, or access data you are not authorised to see.</li>
<li>Follow the attendance rules and code of conduct communicated by CyArt for the internship programme.</li>
</ul>

<h2>4. Attendance, warnings and programme decisions</h2>
<p>Attendance is measured from your presence in designated voice channels and from meeting records. Based on the programme rules, CyArt HR may issue formal warnings, which are delivered by direct message or a private thread and must be acknowledged. Repeated non-compliance may lead to termination of the internship and removal from the server. Decisions are made by CyArt staff; the Bot records and communicates them.</p>

<h2>5. Availability</h2>
<p>We aim to keep the Bot running but provide it "as is", without guarantees of uninterrupted availability or error-free operation. Records may be corrected by HR where an error is identified. We may change, suspend or discontinue features at any time.</p>

<h2>6. Limitation of liability</h2>
<p>To the extent permitted by applicable law, CyArt is not liable for indirect or consequential losses arising from use of, or inability to use, the Bot.</p>

<h2>7. Termination of access</h2>
<p>We may restrict or remove your access to the Bot or the server if you breach these Terms or the programme rules, or when your participation in the programme ends.</p>

<h2>8. Changes</h2>
<p>We may update these Terms. The "Last updated" date above shows the latest version; continued use after an update means you accept it.</p>

<h2>9. Contact</h2>
<p>Questions about these Terms: <a href="mailto:${CONTACT}">${CONTACT}</a>. See also our <a href="/privacy">Privacy Policy</a>.</p>
`
);

const PRIVACY = page(
  "Privacy Policy",
  `
<p>This policy explains what information <b>BotCy</b> (the "Bot") and its attendance dashboard collect, why, and how it is handled. The Bot is operated by CyArt for its internship programme.</p>

<h2>1. Information we collect</h2>
<ul>
<li><b>Discord account data:</b> user ID, username, display name and avatar, and your roles and membership in CyArt servers.</li>
<li><b>Verification details you provide:</b> full name, batch, project, module and pod.</li>
<li><b>Attendance data:</b> when you join and leave voice channels in CyArt servers, and the time served each day.</li>
<li><b>Programme records:</b> meeting attendance, leave requests (including reasons and any documents you submit), support tickets and their transcripts, and formal warnings with their acknowledgements and HR notes.</li>
</ul>
<p>The Bot does not read your direct messages to other users and does not collect data from servers other than CyArt's.</p>

<h2>2. How we use it</h2>
<ul>
<li>To run the internship programme: verification, role assignment, attendance tracking, meetings, leave, tickets and communication.</li>
<li>To measure compliance with the programme's attendance rules, produce attendance reports, and issue warnings where the rules are not met.</li>
<li>To keep the service secure and to investigate misuse.</li>
</ul>
<p>We do not sell personal data and do not use it for advertising.</p>

<h2>3. Who can see it</h2>
<ul>
<li>Authorised CyArt staff (HR, managers and project leads) through the password-protected dashboard and staff-only channels.</li>
<li>Service providers that host and run the Bot on our behalf: Discord (platform), our hosting provider, our database provider (TiDB Cloud) and Cloudflare (network). They process data only to provide their service.</li>
<li>Authorities, where required by law.</li>
</ul>

<h2>4. Retention</h2>
<p>Records are kept for the duration of the internship programme and for a reasonable period afterwards for certification, reference and audit purposes, after which they are deleted or anonymised. Closed support-ticket channels are deleted automatically after a short archive period.</p>

<h2>5. Security</h2>
<p>Data is stored in a managed cloud database with encrypted connections. The dashboard requires a password, sensitive actions require individual HR credentials, and access is limited to staff who need it.</p>

<h2>6. Your choices and rights</h2>
<ul>
<li>You can ask to see the information we hold about you, or ask us to correct or delete it, by emailing <a href="mailto:${CONTACT}">${CONTACT}</a>. Some records may need to be kept while you are an active intern or where we are required to keep them.</li>
<li>You can leave the server at any time; attendance tracking stops when you are no longer a member.</li>
</ul>

<h2>7. Changes</h2>
<p>We may update this policy. The "Last updated" date above shows the latest version.</p>

<h2>8. Contact</h2>
<p>Privacy questions or requests: <a href="mailto:${CONTACT}">${CONTACT}</a>. See also our <a href="/terms">Terms of Service</a>.</p>
`
);

/** Public pages, mounted BEFORE the auth guard. Only these two paths. */
export const legalRoutes: RequestHandler = (req, res, next) => {
  if (req.method !== "GET") return next();
  const path = req.path.replace(/\/+$/, "") || "/";
  if (path === "/terms" || path === "/tos") {
    res.type("html").send(TERMS);
    return;
  }
  if (path === "/privacy" || path === "/privacy-policy") {
    res.type("html").send(PRIVACY);
    return;
  }
  next();
};
