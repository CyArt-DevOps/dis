import { ChannelType, MessageType, PermissionFlagsBits } from "discord.js";
/**
 * Reads every message in a project's channels (and their threads) so dissolve can
 * save them before deleting anything. Any channel it cannot read stops the whole
 * backup with a BackupError — the caller then deletes nothing.
 *
 * discord.js objects are used duck-typed (only the fields below), so tests can
 * pass small fakes.
 */
export class BackupError extends Error {
}
const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_AVATAR = 1024 * 1024;
const PAGE = 100;
const MESSAGE_TYPES = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const THREAD_PARENTS = new Set([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
const NORMAL_TYPES = new Set([MessageType.Default, MessageType.Reply, MessageType.ChatInputCommand, MessageType.ContextMenuCommand]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Download with up to 3 tries (honours Retry-After on 429/5xx); null when it can't be saved. */
export const defaultFetchBytes = async (url, maxBytes) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
            if (res.status === 429 || res.status >= 500) {
                const wait = Math.min(Number(res.headers.get("retry-after") ?? 0) * 1000 || attempt * 1000, 10_000);
                await sleep(wait);
                continue;
            }
            if (!res.ok)
                return null;
            const len = Number(res.headers.get("content-length") ?? 0);
            if (len > maxBytes)
                return null;
            const buf = Buffer.from(await res.arrayBuffer());
            return buf.length <= maxBytes ? buf : null;
        }
        catch {
            await sleep(attempt * 1000);
        }
    }
    return null;
};
/** Only raster types Discord shows inline; SVG is never embedded. */
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
/** Total embedded image bytes per backup, so a huge project still fits in memory. */
const MAX_TOTAL_IMAGES = 200 * 1024 * 1024;
const byPosition = (a, b) => (a.position ?? 0) - (b.position ?? 0);
const byId = (a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const errText = (err) => (err instanceof Error ? err.message : String(err));
async function listThreads(ch) {
    const found = new Map();
    try {
        const active = await ch.threads.fetchActive();
        for (const t of active.threads.values())
            found.set(t.id, t);
        const kinds = ch.type === ChannelType.GuildText ? ["public", "private"] : ["public"];
        for (const type of kinds) {
            let before;
            for (;;) {
                const res = await ch.threads.fetchArchived({ type, fetchAll: true, limit: PAGE, ...(before ? { before } : {}) });
                const list = [...res.threads.values()];
                const fresh = list.filter((t) => !found.has(t.id));
                for (const t of list)
                    found.set(t.id, t);
                // Stop when Discord says so, or when a page brings nothing new (guards an endless loop).
                if (!res.hasMore || fresh.length === 0)
                    break;
                const oldest = list.reduce((min, t) => ((t.archivedAt?.getTime?.() ?? Infinity) < (min.archivedAt?.getTime?.() ?? Infinity) ? t : min));
                if (!oldest.archivedAt)
                    break;
                before = oldest.archivedAt.toISOString();
            }
        }
    }
    catch (err) {
        throw new BackupError(`Could not list threads of #${ch.name}: ${errText(err)}`);
    }
    return [...found.values()].sort(byId);
}
async function fetchAllMessages(ch) {
    const all = [];
    let before;
    try {
        for (;;) {
            const page = await ch.messages.fetch({ limit: PAGE, cache: false, ...(before ? { before } : {}) });
            const list = [...page.values()];
            all.push(...list);
            if (list.length < PAGE)
                break;
            before = list.reduce((min, m) => (BigInt(m.id) < BigInt(min.id) ? m : min)).id;
        }
    }
    catch (err) {
        throw new BackupError(`Could not read #${ch.name}: ${errText(err)}`);
    }
    return all.sort(byId);
}
function displayName(m) {
    return m.member?.displayName ?? m.author.globalName ?? m.author.username;
}
function istTime(unixSeconds) {
    return new Date(Number(unixSeconds) * 1000).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata",
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
    });
}
function replaceMentions(text, m, guild) {
    const userName = (id) => m.mentions?.members?.get(id)?.displayName ??
        guild.members.cache.get(id)?.displayName ??
        m.mentions?.users?.get(id)?.globalName ??
        m.mentions?.users?.get(id)?.username ??
        "unknown-user";
    return text
        .replace(/<@!?(\d+)>/g, (_s, id) => `@${userName(id)}`)
        .replace(/<@&(\d+)>/g, (_s, id) => `@${guild.roles.cache.get(id)?.name ?? "deleted-role"}`)
        .replace(/<#(\d+)>/g, (_s, id) => `#${guild.channels.cache.get(id)?.name ?? "deleted-channel"}`)
        .replace(/<a?:(\w+):\d+>/g, ":$1:")
        .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_s, sec) => istTime(sec));
}
function systemLabel(m, name) {
    if (NORMAL_TYPES.has(m.type))
        return null;
    switch (m.type) {
        case MessageType.UserJoin:
            return `${name} joined the server`;
        case MessageType.ChannelPinnedMessage:
            return `${name} pinned a message`;
        case MessageType.ThreadCreated:
            return `${name} started a thread: ${m.content}`;
        case MessageType.GuildBoost:
        case MessageType.GuildBoostTier1:
        case MessageType.GuildBoostTier2:
        case MessageType.GuildBoostTier3:
            return `${name} boosted the server`;
        case MessageType.ChannelNameChange:
            return `${name} changed the channel name: ${m.content}`;
        case MessageType.RecipientAdd:
            return `${name} added someone to the thread`;
        case MessageType.RecipientRemove:
            return `${name} removed someone from the thread`;
        default: {
            const label = (MessageType[m.type] ?? "System message").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
            return `${name}: ${label}${m.content ? ` — ${m.content}` : ""}`;
        }
    }
}
const imageType = (t) => {
    const type = typeof t === "string" ? t.split(";")[0].trim().toLowerCase() : "";
    return IMAGE_TYPES.has(type) ? type : null;
};
async function attachments(m, run) {
    const out = [];
    for (const a of m.attachments.values()) {
        const name = String(a.name ?? "file");
        const size = Number(a.size ?? 0);
        const type = imageType(a.contentType);
        if (!type) {
            out.push({ name, size });
        }
        else if (size > MAX_IMAGE) {
            out.push({ name, size, note: "image not saved (over 8 MB)" });
        }
        else if (run.imageBytes + size > MAX_TOTAL_IMAGES) {
            out.push({ name, size, note: "image not saved (backup image limit of 200 MB reached)" });
        }
        else {
            const buf = await run.fetchBytes(a.url, MAX_IMAGE);
            if (buf) {
                run.imageBytes += buf.length;
                out.push({ name, size, dataUri: `data:${type};base64,${buf.toString("base64")}` });
            }
            else {
                run.imageFailures++;
                out.push({ name, size, note: "image could not be saved" });
            }
        }
    }
    return out;
}
/** Polls and forwarded messages carry no `content`; turn them into readable text. */
function extraText(m) {
    const parts = [];
    const poll = m.poll;
    if (poll?.question?.text) {
        const answers = [...(poll.answers?.values?.() ?? [])].map((a) => `- ${a.text ?? a.emoji?.name ?? "?"} (${Number(a.voteCount ?? 0)} votes)`);
        parts.push(`📊 Poll: ${poll.question.text}${answers.length ? `\n${answers.join("\n")}` : ""}`);
    }
    for (const snap of m.messageSnapshots?.values?.() ?? []) {
        const text = snap?.content ?? snap?.message?.content;
        const files = [...(snap?.attachments?.values?.() ?? [])].map((a) => a.name).filter(Boolean);
        parts.push(`↪ Forwarded: ${text || ""}${files.length ? ` [files: ${files.join(", ")}]` : ""}`.trim());
    }
    return parts.join("\n");
}
async function author(m, run) {
    const id = String(m.author.id);
    if (!run.authors[id]) {
        const a = { id, name: displayName(m), username: m.author.username, bot: Boolean(m.author.bot) };
        const buf = await run.fetchBytes(m.author.displayAvatarURL({ extension: "png", size: 64 }), MAX_AVATAR);
        if (buf)
            a.avatar = `data:image/png;base64,${buf.toString("base64")}`;
        run.authors[id] = a;
    }
    return id;
}
async function convert(m, guild, run) {
    const authorId = await author(m, run);
    const extra = extraText(m);
    const content = replaceMentions([String(m.content ?? ""), extra].filter(Boolean).join("\n"), m, guild);
    const system = systemLabel(m, run.authors[authorId].name);
    return {
        id: String(m.id),
        authorId,
        createdAt: new Date(m.createdAt).toISOString(),
        editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : null,
        content: system ? "" : content,
        replyTo: m.reference?.messageId ?? null,
        pinned: Boolean(m.pinned),
        embeds: (m.embeds ?? []).map((e) => ({
            title: e.title ?? undefined,
            url: e.url ?? undefined,
            description: e.description ? replaceMentions(e.description, m, guild) : undefined,
            color: e.color ?? null,
            authorName: e.author?.name ?? undefined,
            footer: e.footer?.text ?? undefined,
            fields: (e.fields ?? []).map((f) => ({ name: String(f.name), value: replaceMentions(String(f.value), m, guild) })),
        })),
        attachments: await attachments(m, run),
        reactions: [...m.reactions.cache.values()].map((r) => ({
            emoji: r.emoji?.id ? `:${r.emoji.name}:` : String(r.emoji?.name ?? "?"),
            count: Number(r.count ?? 0),
        })),
        stickers: [...m.stickers.values()].map((s) => String(s.name)),
        system,
    };
}
export async function collectProjectMessages(guild, categoryNames, opts) {
    const g = guild;
    const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
    const me = g.members.me;
    const all = [...g.channels.cache.values()];
    const categories = all.filter((c) => c.type === ChannelType.GuildCategory && categoryNames.has(c.name)).sort(byPosition);
    const units = [];
    for (const cat of categories) {
        const children = all.filter((c) => c.parentId === cat.id && (MESSAGE_TYPES.has(c.type) || THREAD_PARENTS.has(c.type))).sort(byPosition);
        for (const ch of children) {
            const perms = ch.permissionsFor?.(me);
            if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
                throw new BackupError(`Cannot read #${ch.name}: the bot needs View Channel and Read Message History there.`);
            }
            // Archived private threads are only listed with Manage Threads.
            if (ch.type === ChannelType.GuildText && !perms.has(PermissionFlagsBits.ManageThreads)) {
                throw new BackupError(`Cannot read private threads of #${ch.name}: the bot needs Manage Threads there.`);
            }
            if (MESSAGE_TYPES.has(ch.type)) {
                const voice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
                units.push({ channel: ch, category: cat.name, kind: voice ? "voice" : "text" });
            }
            if (THREAD_PARENTS.has(ch.type)) {
                for (const t of await listThreads(ch))
                    units.push({ channel: t, category: cat.name, kind: "thread", parent: ch.name });
            }
        }
    }
    const run = { fetchBytes, authors: {}, imageBytes: 0, imageFailures: 0 };
    const channels = [];
    let count = 0;
    for (const [i, u] of units.entries()) {
        const raw = await fetchAllMessages(u.channel);
        const messages = [];
        for (const m of raw)
            messages.push(await convert(m, g, run));
        count += messages.length;
        channels.push({ id: String(u.channel.id), name: String(u.channel.name), category: u.category, kind: u.kind, ...(u.parent ? { parent: u.parent } : {}), messages });
        opts.onProgress?.({ channel: String(u.channel.name), index: i + 1, total: units.length, messages: count });
    }
    return {
        project: opts.project,
        dissolvedAt: new Date().toISOString(),
        dissolvedBy: opts.dissolvedBy,
        channels,
        authors: run.authors,
        imageFailures: run.imageFailures,
    };
}
//# sourceMappingURL=messageBackup.js.map