/**
 * Read-only: export every message in a project's categories to a standalone
 * HTML archive (plus raw JSON and downloaded attachments).
 *
 *   npx tsx scripts/export-project.ts <project-key>
 *
 * Covers text channels, voice-channel chat, announcement channels, forum
 * posts and all threads (active + archived, public + private). Attachments are
 * downloaded because Discord CDN links expire and die with the channel.
 * Output: data/exports/<key>-<timestamp>/index.html
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ChannelType,
  Collection,
  Events,
  type AnyThreadChannel,
  type Guild,
  type GuildBasedChannel,
  type Message,
} from "discord.js";
import { env } from "../src/config/env.js";
import { org } from "../src/config/loader.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";

type ExportedMessage = {
  id: string;
  at: string;
  editedAt: string | null;
  authorId: string;
  author: string;
  username: string;
  bot: boolean;
  content: string;
  replyTo: string | null;
  attachments: { name: string; file: string | null; url: string; size: number }[];
  embeds: {
    title: string | null;
    description: string | null;
    url: string | null;
    fields: { name: string; value: string }[];
    footer: string | null;
  }[];
  reactions: { emoji: string; count: number }[];
  system: boolean;
};

type ExportedChannel = {
  id: string;
  name: string;
  kind: string;
  category: string;
  parent: string | null;
  messages: ExportedMessage[];
};

const KIND: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: "text",
  [ChannelType.GuildVoice]: "voice",
  [ChannelType.GuildAnnouncement]: "announcement",
  [ChannelType.GuildForum]: "forum",
  [ChannelType.GuildStageVoice]: "stage",
  [ChannelType.PublicThread]: "thread",
  [ChannelType.PrivateThread]: "private thread",
  [ChannelType.AnnouncementThread]: "thread",
};

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safeFile(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
}

async function fetchAll(channel: { messages: { fetch: Function } }): Promise<Message[]> {
  const out: Message[] = [];
  let before: string | undefined;
  for (;;) {
    const batch = (await channel.messages.fetch({ limit: 100, before })) as Collection<
      string,
      Message
    >;
    if (batch.size === 0) break;
    out.push(...batch.values());
    before = batch.last()!.id;
    if (batch.size < 100) break;
  }
  return out.sort((a, b) => a.createdTimestamp - b.createdTimestamp);
}

async function threadsOf(guild: Guild, parent: GuildBasedChannel): Promise<AnyThreadChannel[]> {
  if (!("threads" in parent)) return [];
  const found = new Map<string, AnyThreadChannel>();
  const active = await guild.channels.fetchActiveThreads().catch(() => null);
  active?.threads.forEach((t) => t.parentId === parent.id && found.set(t.id, t));
  for (const type of ["public", "private"] as const) {
    if (type === "private" && parent.type === ChannelType.GuildForum) continue;
    let before: string | undefined;
    for (;;) {
      const res = await parent.threads
        .fetchArchived({ type, before, limit: 100 })
        .catch(() => null);
      if (!res || res.threads.size === 0) break;
      res.threads.forEach((t) => found.set(t.id, t));
      if (!res.hasMore) break;
      before = res.threads.last()!.id;
    }
  }
  return [...found.values()];
}

async function main() {
  const key = process.argv[2];
  const project = org.projects.find((p) => p.key === key);
  if (!project) {
    console.error(`Usage: tsx scripts/export-project.ts <key>. Unknown key '${key}'.`);
    process.exit(1);
  }

  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.channels.fetch();
    await guild.members.fetch().catch(() => {});

    const upper = project.name.toUpperCase();
    const cats = guild.channels.cache.filter(
      (ch) =>
        ch.type === ChannelType.GuildCategory &&
        (ch.name.toUpperCase() === upper ||
          ch.name.toUpperCase() === `ARCH-${upper}` ||
          ch.name.startsWith(`${project.name} `) ||
          ch.name.startsWith(`ARCH-${project.name} `))
    );
    if (cats.size === 0) {
      console.error(`No categories found for ${project.name}`);
      client.destroy();
      process.exit(1);
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outDir = resolve(process.cwd(), "data", "exports", `${key}-${stamp}`);
    const attDir = resolve(outDir, "attachments");
    mkdirSync(attDir, { recursive: true });

    const names = new Map<string, string>();
    const nameOf = (id: string, fallback: string) =>
      names.get(id) ?? guild.members.cache.get(id)?.displayName ?? fallback;

    const exported: ExportedChannel[] = [];
    let attCount = 0;
    let attFailed = 0;

    const exportOne = async (
      ch: GuildBasedChannel,
      category: string,
      parent: string | null
    ) => {
      const msgs = "messages" in ch ? await fetchAll(ch as never) : [];
      const rows: ExportedMessage[] = [];
      for (const m of msgs) {
        const author = m.member?.displayName ?? m.author.globalName ?? m.author.username;
        names.set(m.author.id, author);
        const attachments: ExportedMessage["attachments"] = [];
        for (const a of m.attachments.values()) {
          const file = `${m.id}-${safeFile(a.name)}`;
          try {
            const res = await fetch(a.url);
            if (!res.ok) throw new Error(String(res.status));
            writeFileSync(resolve(attDir, file), Buffer.from(await res.arrayBuffer()));
            attachments.push({ name: a.name, file, url: a.url, size: a.size });
            attCount++;
          } catch {
            attachments.push({ name: a.name, file: null, url: a.url, size: a.size });
            attFailed++;
          }
        }
        rows.push({
          id: m.id,
          at: m.createdAt.toISOString(),
          editedAt: m.editedAt?.toISOString() ?? null,
          authorId: m.author.id,
          author,
          username: m.author.username,
          bot: m.author.bot,
          content: m.content,
          replyTo: m.reference?.messageId ?? null,
          attachments,
          embeds: m.embeds.map((e) => ({
            title: e.title,
            description: e.description,
            url: e.url,
            fields: e.fields.map((f) => ({ name: f.name, value: f.value })),
            footer: e.footer?.text ?? null,
          })),
          reactions: m.reactions.cache.map((r) => ({
            emoji: r.emoji.name ?? "?",
            count: r.count,
          })),
          system: m.system,
        });
      }
      exported.push({
        id: ch.id,
        name: ch.name,
        kind: KIND[ch.type] ?? String(ch.type),
        category,
        parent,
        messages: rows,
      });
      console.log(`  ${parent ? "  └ " : ""}[${KIND[ch.type] ?? ch.type}] ${ch.name}: ${rows.length} msgs`);
    };

    for (const cat of cats
      .sort(
        (a, b) =>
          ((a as { position?: number }).position ?? 0) -
          ((b as { position?: number }).position ?? 0)
      )
      .values()) {
      console.log(`\n=== CATEGORY: ${cat.name} (${cat.id}) ===`);
      const children = guild.channels.cache
        .filter((ch) => ch.parentId === cat.id)
        .sort(
          (a, b) =>
            ((a as { position?: number }).position ?? 0) -
            ((b as { position?: number }).position ?? 0)
        );
      for (const ch of children.values()) {
        await exportOne(ch, cat.name, null);
        for (const t of await threadsOf(guild, ch)) await exportOne(t, cat.name, ch.name);
      }
    }

    // Resolve <@id> mentions now that every author name is known.
    const mention = (s: string) =>
      s
        .replace(/&lt;@!?(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(nameOf(id, id))}</span>`)
        .replace(/&lt;@&amp;(\d+)&gt;/g, (_, id) => `<span class="mention">@${esc(guild.roles.cache.get(id)?.name ?? id)}</span>`)
        .replace(/&lt;#(\d+)&gt;/g, (_, id) => `<span class="mention">#${esc(guild.channels.cache.get(id)?.name ?? id)}</span>`)
        .replace(/&lt;t:(\d+)(?::[a-zA-Z])?&gt;/g, (_, s) => `<time datetime="${new Date(Number(s) * 1000).toISOString()}">${new Date(Number(s) * 1000).toISOString()}</time>`)
        .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');

    const total = exported.reduce((n, ch) => n + ch.messages.length, 0);
    const byId = new Map(exported.flatMap((ch) => ch.messages.map((m) => [m.id, m] as const)));

    const section = (ch: ExportedChannel) => {
      const msgs = ch.messages
        .map((m) => {
          const reply = m.replyTo ? byId.get(m.replyTo) : undefined;
          const atts = m.attachments
            .map((a) => {
              const href = a.file ? `attachments/${encodeURIComponent(a.file)}` : a.url;
              const img = a.file && /\.(png|jpe?g|gif|webp)$/i.test(a.name)
                ? `<img src="${href}" alt="${esc(a.name)}" loading="lazy">` : "";
              return `<div class="att">${img}<a href="${href}" target="_blank">📎 ${esc(a.name)}</a>${a.file ? "" : " <em>(download failed)</em>"}</div>`;
            })
            .join("");
          const embeds = m.embeds
            .filter((e) => e.title || e.description || e.fields.length)
            .map((e) => `<div class="embed">${e.title ? `<b>${esc(e.title)}</b>` : ""}${e.description ? `<div class="body">${mention(esc(e.description))}</div>` : ""}${e.fields.map((f) => `<div class="field"><b>${esc(f.name)}</b><div class="body">${mention(esc(f.value))}</div></div>`).join("")}${e.footer ? `<div class="foot">${esc(e.footer)}</div>` : ""}</div>`)
            .join("");
          const reacts = m.reactions.length
            ? `<div class="reacts">${m.reactions.map((r) => `<span>${esc(r.emoji)} ${r.count}</span>`).join("")}</div>`
            : "";
          return `<div class="msg${m.system ? " sys" : ""}" id="m${m.id}">
<div class="head"><span class="author" title="${esc(m.username)}">${esc(m.author)}</span>${m.bot ? '<span class="bot">BOT</span>' : ""}<time datetime="${m.at}">${m.at.replace("T", " ").slice(0, 19)} UTC</time>${m.editedAt ? `<span class="edited" title="${m.editedAt}">(edited)</span>` : ""}</div>
${reply ? `<a class="reply" href="#m${reply.id}">↪ ${esc(reply.author)}: ${esc(reply.content.slice(0, 80))}</a>` : ""}
<div class="body">${mention(esc(m.content))}</div>${atts}${embeds}${reacts}</div>`;
        })
        .join("\n");
      const title = ch.parent ? `${ch.parent} › ${ch.name}` : ch.name;
      return `<section id="c${ch.id}"><h2>${ch.kind === "voice" ? "🔊" : "#"} ${esc(title)} <small>${ch.kind} · ${ch.messages.length} messages</small></h2>
${msgs || '<p class="empty">No messages.</p>'}</section>`;
    };

    const toc = exported
      .map((ch) => `<li${ch.parent ? ' class="sub"' : ""}><a href="#c${ch.id}">${esc(ch.parent ? `└ ${ch.name}` : ch.name)}</a> <small>${ch.messages.length}</small></li>`)
      .join("");

    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(project.name)} archive</title>
<style>
:root{--bg:#f7f7f8;--card:#fff;--fg:#1d1d1f;--muted:#6b6b72;--line:#e3e3e8;--accent:#5865f2}
@media (prefers-color-scheme:dark){:root{--bg:#1e1f22;--card:#2b2d31;--fg:#e8e8ea;--muted:#9a9aa3;--line:#3a3c42;--accent:#8891f2}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:24px 16px;border-bottom:1px solid var(--line);background:var(--card)}header h1{margin:0 0 4px}header p{margin:0;color:var(--muted)}
.wrap{display:flex;max-width:1200px;margin:0 auto}nav{width:260px;flex-shrink:0;padding:16px;position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid var(--line)}
nav ul{list-style:none;padding:0;margin:0}nav li{padding:3px 0}nav li.sub{padding-left:12px;font-size:13px}nav a{color:var(--fg);text-decoration:none}nav a:hover{color:var(--accent)}nav small{color:var(--muted)}
main{flex:1;min-width:0;padding:16px}section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:20px}
h2{margin:0 0 12px;font-size:18px}h2 small{font-weight:400;color:var(--muted);font-size:13px;margin-left:6px}
.msg{padding:8px 0;border-top:1px solid var(--line)}.msg:first-of-type{border-top:0}.msg.sys{opacity:.7;font-style:italic}
.head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}.author{font-weight:600}.bot{background:var(--accent);color:#fff;font-size:10px;padding:0 4px;border-radius:3px}
time,.edited{color:var(--muted);font-size:12px}.body{white-space:pre-wrap;word-wrap:break-word}.mention{color:var(--accent);font-weight:500}
.reply{display:block;font-size:12px;color:var(--muted);text-decoration:none;margin:2px 0}.att{margin-top:4px}.att img{display:block;max-width:360px;max-height:280px;border-radius:6px;margin-bottom:2px}
.embed{border-left:3px solid var(--accent);padding:4px 10px;margin-top:4px;font-size:14px}.reacts span{display:inline-block;border:1px solid var(--line);border-radius:10px;padding:0 6px;margin:4px 4px 0 0;font-size:12px}
.field{margin-top:4px}.foot{color:var(--muted);font-size:12px;margin-top:4px}.empty{color:var(--muted)}a{color:var(--accent)}
@media (max-width:760px){.wrap{display:block}nav{position:static;width:auto;height:auto;border-right:0;border-bottom:1px solid var(--line)}.att img{max-width:100%}}
</style></head><body>
<header><h1>${esc(project.name)} — Discord archive</h1>
<p>${cats.map((c) => esc(c.name)).join(", ")} · ${exported.length} channels · ${total} messages · exported ${new Date().toISOString().replace("T", " ").slice(0, 19)} UTC · times shown in your local timezone</p></header>
<div class="wrap"><nav><ul>${toc}</ul></nav><main>
${exported.map(section).join("\n")}
</main></div>
<script>
document.querySelectorAll("time").forEach(function(t){var d=new Date(t.getAttribute("datetime"));if(!isNaN(d))t.textContent=d.toLocaleString(undefined,{dateStyle:"medium",timeStyle:"short"});t.title=t.getAttribute("datetime");});
</script></body></html>`;

    writeFileSync(resolve(outDir, "index.html"), html);
    writeFileSync(
      resolve(outDir, "raw.json"),
      JSON.stringify({ project, categories: cats.map((c) => ({ id: c.id, name: c.name })), exportedAt: new Date().toISOString(), channels: exported }, null, 2)
    );

    console.log(`\nChannels: ${exported.length}  Messages: ${total}  Attachments: ${attCount} saved, ${attFailed} failed`);
    console.log(`Output: ${outDir}`);
    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}

main().catch((err) => {
  logger.error({ err }, "export fatal");
  process.exit(1);
});
