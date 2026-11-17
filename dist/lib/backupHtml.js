/**
 * Renders a dissolved project's messages as one self-contained, Discord-looking
 * HTML page (sidebar of channels, message pane). Pure: no I/O. Every string that
 * came from Discord is HTML-escaped before any formatting is applied.
 */
const GROUP_MS = 7 * 60_000;
const TZ = "Asia/Kolkata";
export function esc(s) {
    return s
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
/** Discord markdown subset → safe HTML. */
export function renderMarkdown(raw) {
    const slots = [];
    const hold = (html) => `\u0000${slots.push(html) - 1}\u0000`;
    let text = raw.replace(/\u0000/g, "");
    // Code blocks first: their content is shown verbatim.
    text = text.replace(/```(?:[A-Za-z0-9_+-]*\n)?([\s\S]*?)```/g, (_m, code) => hold(`<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre>`));
    text = esc(text);
    text = text.replace(/`([^`\n]+)`/g, (_m, code) => hold(`<code>${code}</code>`));
    text = text.replace(/https?:\/\/[^\s<]+/g, (match) => {
        // `<url>` (escaped to &lt;url&gt;) and trailing markdown/punctuation stay outside the link.
        const tail = /(?:&gt;|[*_~|.,!?)])+$/.exec(match)?.[0] ?? "";
        const url = match.slice(0, match.length - tail.length);
        return hold(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`) + tail;
    });
    text = text
        .replace(/\*\*([^\n]+?)\*\*/g, "<strong>$1</strong>")
        .replace(/__([^\n]+?)__/g, "<u>$1</u>")
        .replace(/~~([^\n]+?)~~/g, "<s>$1</s>")
        .replace(/\|\|([^\n]+?)\|\|/g, '<span class="spoiler">$1</span>')
        .replace(/\*([^*\n]+)\*/g, "<em>$1</em>")
        .replace(/(^|[^\w])_([^_\n]+)_(?!\w)/gm, "$1<em>$2</em>");
    const lines = text.split("\n").map((line) => (line.startsWith("&gt; ") ? `<blockquote>${line.slice(5)}</blockquote>` : line));
    let html = lines.join("<br>").replace(/<\/blockquote><br>/g, "</blockquote>");
    html = html.replace(/\u0000(\d+)\u0000/g, (_m, i) => slots[Number(i)] ?? "");
    return html;
}
function fmt(iso, opts) {
    return new Date(iso).toLocaleString("en-IN", { timeZone: TZ, ...opts });
}
const fullTime = (iso) => fmt(iso, { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
const shortTime = (iso) => fmt(iso, { hour: "2-digit", minute: "2-digit" });
const dayLabel = (iso) => fmt(iso, { day: "numeric", month: "long", year: "numeric" });
export function formatSize(bytes) {
    if (bytes < 1024)
        return `${bytes} B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
const plural = (n, word) => `${n.toLocaleString("en-IN")} ${word}${n === 1 ? "" : "s"}`;
function initials(name) {
    return esc((name.trim()[0] ?? "?").toUpperCase());
}
function avatar(data, authorId) {
    const a = data.authors[authorId];
    if (a?.avatar?.startsWith("data:image/"))
        return `<div class="av"><img src="${a.avatar}" alt=""></div>`;
    return `<div class="av initials">${initials(a?.name ?? "?")}</div>`;
}
function authorName(data, id) {
    return data.authors[id]?.name ?? "Unknown user";
}
function replyBar(data, byId, m) {
    if (!m.replyTo)
        return "";
    const target = byId.get(m.replyTo);
    if (!target)
        return `<div class="reply missing">Original message not found</div>`;
    const snippet = target.content ? target.content.replace(/\s+/g, " ").slice(0, 80) : target.attachments.length ? "Attachment" : "Message";
    return `<div class="reply"><span class="r-name">${esc(authorName(data, target.authorId))}</span> <span class="r-text">${esc(snippet)}</span></div>`;
}
function attachmentHtml(a) {
    if (a.dataUri?.startsWith("data:image/")) {
        return `<img class="att-img" src="${a.dataUri}" alt="${esc(a.name)}" loading="lazy">`;
    }
    const note = a.note ? `<span class="f-note">${esc(a.note)}</span>` : "";
    return `<div class="file"><span class="f-name">${esc(a.name)}</span><span class="f-size">${formatSize(a.size)}</span>${note}</div>`;
}
function embedHtml(e) {
    const color = typeof e.color === "number" ? `#${e.color.toString(16).padStart(6, "0")}` : "#1e1f22";
    const parts = [];
    if (e.authorName)
        parts.push(`<div class="e-author">${esc(e.authorName)}</div>`);
    if (e.title) {
        const t = esc(e.title);
        parts.push(e.url && /^https?:\/\//.test(e.url)
            ? `<div class="e-title"><a href="${esc(e.url)}" target="_blank" rel="noopener noreferrer">${t}</a></div>`
            : `<div class="e-title">${t}</div>`);
    }
    if (e.description)
        parts.push(`<div class="e-desc">${renderMarkdown(e.description)}</div>`);
    if (e.fields.length) {
        parts.push(`<div class="e-fields">${e.fields
            .map((f) => `<div class="e-field"><div class="e-fname">${esc(f.name)}</div><div>${renderMarkdown(f.value)}</div></div>`)
            .join("")}</div>`);
    }
    if (e.footer)
        parts.push(`<div class="e-footer">${esc(e.footer)}</div>`);
    return `<div class="embed" style="border-left-color:${color}">${parts.join("")}</div>`;
}
function bodyHtml(m) {
    const out = [];
    if (m.content)
        out.push(`<div class="text">${renderMarkdown(m.content)}${m.editedAt ? ' <span class="edited">(edited)</span>' : ""}</div>`);
    else if (m.editedAt)
        out.push(`<span class="edited">(edited)</span>`);
    for (const e of m.embeds)
        out.push(embedHtml(e));
    for (const a of m.attachments)
        out.push(attachmentHtml(a));
    for (const s of m.stickers)
        out.push(`<div class="sticker">Sticker: ${esc(s)}</div>`);
    if (m.reactions.length) {
        out.push(`<div class="reacts">${m.reactions.map((r) => `<span class="react">${esc(r.emoji)} <b>${r.count}</b></span>`).join("")}</div>`);
    }
    return out.join("");
}
function messagesHtml(data, ch) {
    if (!ch.messages.length)
        return `<div class="empty">No messages in this channel.</div>`;
    const byId = new Map(ch.messages.map((m) => [m.id, m]));
    const out = [];
    let prev = null;
    let prevDay = "";
    for (const m of ch.messages) {
        const day = dayLabel(m.createdAt);
        if (day !== prevDay) {
            out.push(`<div class="day"><span>${esc(day)}</span></div>`);
            prevDay = day;
            prev = null;
        }
        const id = `m-${esc(m.id)}`;
        if (m.system) {
            out.push(`<div class="system" id="${id}">${esc(m.system)} <span class="time">${esc(fullTime(m.createdAt))}</span></div>`);
            prev = null;
            continue;
        }
        const grouped = prev !== null &&
            prev.authorId === m.authorId &&
            !m.replyTo &&
            Date.parse(m.createdAt) - Date.parse(prev.createdAt) <= GROUP_MS;
        if (grouped) {
            out.push(`<div class="msg cont" id="${id}"><div class="gutter">${esc(shortTime(m.createdAt))}</div><div class="body">${bodyHtml(m)}</div></div>`);
        }
        else {
            const a = data.authors[m.authorId];
            const tags = `${a?.bot ? '<span class="tag">BOT</span>' : ""}${m.pinned ? '<span class="pin">Pinned</span>' : ""}`;
            out.push(`<div class="msg head" id="${id}">${replyBar(data, byId, m)}<div class="row">${avatar(data, m.authorId)}<div class="body">` +
                `<div class="who"><span class="name" title="${esc(a?.username ?? "")}">${esc(authorName(data, m.authorId))}</span>${tags}` +
                `<span class="time">${esc(fullTime(m.createdAt))}</span></div>${bodyHtml(m)}</div></div></div>`);
        }
        if (grouped && m.pinned)
            out[out.length - 1] = out[out.length - 1].replace('<div class="body">', '<div class="body"><span class="pin">Pinned</span>');
        prev = m;
    }
    return out.join("\n");
}
function sidebarHtml(data) {
    const out = [];
    let cat = null;
    for (const ch of data.channels) {
        if (ch.category !== cat) {
            cat = ch.category;
            out.push(`<div class="side-cat">${esc(cat)}</div>`);
        }
        const cls = ch.kind === "thread" ? "side-item thread" : "side-item";
        const icon = ch.kind === "voice" ? "🔊" : ch.kind === "thread" ? "↳" : "#";
        out.push(`<a class="${cls}" data-ch="${esc(ch.id)}" href="#${esc(ch.id)}"><span class="hash">${icon}</span><span class="cname">${esc(ch.name)}</span><span class="count">${ch.messages.length}</span></a>`);
    }
    return out.join("\n");
}
const CSS = `
*{box-sizing:border-box}
html,body{margin:0;height:100%}
body{background:#313338;color:#dbdee1;font:15px/1.375 "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif;display:flex}
a{color:#00a8fc;text-decoration:none}a:hover{text-decoration:underline}
.side{width:260px;flex:none;background:#2b2d31;height:100vh;overflow-y:auto;padding-bottom:16px}
.side-head{padding:16px;border-bottom:1px solid #1f2023;margin-bottom:8px}
.proj{color:#f2f3f5;font-weight:700;font-size:16px;word-break:break-word}
.meta{color:#949ba4;font-size:12px;margin-top:4px}
.side-cat{color:#949ba4;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.02em;padding:16px 16px 4px}
.side-item{display:flex;align-items:center;gap:6px;margin:1px 8px;padding:6px 8px;border-radius:4px;color:#949ba4}
.side-item:hover{background:#35373c;color:#dbdee1;text-decoration:none}
.side-item.active{background:#404249;color:#f2f3f5}
.side-item.thread{margin-left:24px;font-size:14px}
.hash{width:18px;text-align:center;flex:none;opacity:.8}
.cname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.count{font-size:11px;background:#1e1f22;border-radius:8px;padding:0 6px}
main{flex:1;min-width:0;height:100vh;overflow-y:auto}
.chan-head{position:sticky;top:0;background:#313338;border-bottom:1px solid #26272b;padding:12px 16px;color:#f2f3f5;font-weight:600;z-index:1}
.chan-head small{color:#949ba4;font-weight:400;margin-left:8px}
.msgs{padding:8px 0 24px}
.day{display:flex;align-items:center;margin:16px 16px 8px;color:#949ba4;font-size:12px;font-weight:600}
.day:before,.day:after{content:"";flex:1;height:1px;background:#3f4147}
.day span{padding:0 8px}
.msg{padding:2px 16px 2px 16px}
.msg:hover{background:#2e3035}
.msg.head{margin-top:14px}
.row{display:flex;gap:16px}
.av{width:40px;height:40px;border-radius:50%;flex:none;overflow:hidden;background:#5865f2;color:#fff;display:flex;align-items:center;justify-content:center;font-weight:600}
.av img{width:100%;height:100%;object-fit:cover}
.msg.cont{display:flex;gap:16px}
.gutter{width:40px;flex:none;font-size:11px;color:transparent;text-align:right;padding-top:3px}
.msg.cont:hover .gutter{color:#949ba4}
.body{flex:1;min-width:0}
.who{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap}
.name{color:#f2f3f5;font-weight:600}
.time{color:#949ba4;font-size:12px}
.tag{background:#5865f2;color:#fff;font-size:10px;font-weight:700;border-radius:3px;padding:0 4px}
.pin{color:#f0b232;font-size:11px;font-weight:600;margin-right:6px}
.text{white-space:normal;word-wrap:break-word;overflow-wrap:anywhere}
.edited{color:#949ba4;font-size:11px}
code{background:#2b2d31;border-radius:3px;padding:0 3px;font-family:Consolas,"Courier New",monospace;font-size:13px}
pre{background:#2b2d31;border:1px solid #1e1f22;border-radius:4px;padding:8px;margin:4px 0;overflow-x:auto;white-space:pre-wrap}
pre code{background:none;padding:0}
blockquote{margin:2px 0;padding-left:10px;border-left:4px solid #4e5058}
.spoiler{background:#1e1f22;border-radius:3px;padding:0 2px}
.reply{display:flex;gap:6px;align-items:center;margin:0 0 4px 56px;font-size:13px;color:#b5bac1;position:relative;white-space:nowrap;overflow:hidden}
.reply:before{content:"";position:absolute;left:-36px;top:8px;width:30px;height:10px;border-left:2px solid #4e5058;border-top:2px solid #4e5058;border-top-left-radius:6px}
.reply.missing{font-style:italic;color:#949ba4}
.r-name{color:#f2f3f5;font-weight:600}
.r-text{overflow:hidden;text-overflow:ellipsis}
.embed{background:#2b2d31;border-left:4px solid #1e1f22;border-radius:4px;padding:8px 12px;margin:4px 0;max-width:520px}
.e-author{font-size:13px;font-weight:600;color:#f2f3f5}
.e-title{font-weight:600;color:#f2f3f5;margin:2px 0}
.e-desc{font-size:14px}
.e-fields{display:grid;gap:6px;margin-top:6px}
.e-fname{font-weight:600;font-size:13px;color:#f2f3f5}
.e-footer{font-size:12px;color:#949ba4;margin-top:6px}
.att-img{display:block;max-width:min(400px,100%);max-height:350px;border-radius:8px;margin:4px 0}
.file{display:flex;flex-wrap:wrap;gap:8px;align-items:baseline;background:#2b2d31;border:1px solid #1e1f22;border-radius:8px;padding:10px 12px;margin:4px 0;max-width:420px}
.f-name{color:#00a8fc;word-break:break-all}
.f-size,.f-note{color:#949ba4;font-size:12px}
.sticker{color:#949ba4;font-style:italic}
.reacts{display:flex;flex-wrap:wrap;gap:4px;margin-top:4px}
.react{background:#2b2d31;border:1px solid #3f4147;border-radius:8px;padding:0 6px;font-size:13px}
.system{color:#949ba4;font-size:14px;padding:4px 16px 4px 72px}
.empty{color:#949ba4;padding:24px 16px}
@media (max-width:700px){body{display:block}.side{width:auto;height:auto;max-height:40vh}main{height:auto}.reply{margin-left:0}.reply:before{display:none}.system{padding-left:16px}}
`;
const JS = `
(function(){var secs=[].slice.call(document.querySelectorAll('.chan'));var items=[].slice.call(document.querySelectorAll('.side-item'));
function show(id){secs.forEach(function(s){s.hidden=s.getAttribute('data-ch')!==id});items.forEach(function(i){i.classList.toggle('active',i.getAttribute('data-ch')===id)});}
items.forEach(function(i){i.addEventListener('click',function(e){e.preventDefault();var id=i.getAttribute('data-ch');show(id);history.replaceState(null,'','#'+id);});});
var h=location.hash.slice(1);var ok=secs.some(function(s){return s.getAttribute('data-ch')===h});
show(ok?h:(secs[0]?secs[0].getAttribute('data-ch'):''));})();
`;
export function renderBackupHtml(data) {
    const total = data.channels.reduce((n, c) => n + c.messages.length, 0);
    const project = esc(data.project);
    const sections = data.channels
        .map((ch) => {
        const where = ch.parent ? `<small>in #${esc(ch.parent)}</small>` : `<small>${esc(ch.category)}</small>`;
        const icon = ch.kind === "voice" ? "🔊" : ch.kind === "thread" ? "↳" : "#";
        return `<section class="chan" data-ch="${esc(ch.id)}"><div class="chan-head">${icon} ${esc(ch.name)} ${where}</div><div class="msgs">\n${messagesHtml(data, ch)}\n</div></section>`;
    })
        .join("\n");
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${project} — message backup</title><style>${CSS}</style></head>
<body>
<aside class="side"><div class="side-head"><div class="proj">${project}</div>
<div class="meta">Message backup · dissolved ${esc(fullTime(data.dissolvedAt))} IST by ${esc(data.dissolvedBy)}</div>
<div class="meta">${plural(data.channels.length, "channel")} · ${plural(total, "message")}</div>
${data.imageFailures ? `<div class="meta">${plural(data.imageFailures, "image")} could not be downloaded (shown by name)</div>` : ""}</div>
${sidebarHtml(data)}
</aside>
<main>
${sections || '<div class="empty">This project had no channels.</div>'}
</main>
<script>${JS}</script>
</body></html>
`;
}
//# sourceMappingURL=backupHtml.js.map