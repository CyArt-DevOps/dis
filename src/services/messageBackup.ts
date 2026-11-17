import { ChannelType, MessageType, PermissionFlagsBits, type Guild } from "discord.js";
import type { BackupAttachment, BackupAuthor, BackupChannel, BackupData, BackupMessage } from "../lib/backupTypes.js";

/**
 * Reads every message in a project's channels (and their threads) so dissolve can
 * save them before deleting anything. Any channel it cannot read stops the whole
 * backup with a BackupError — the caller then deletes nothing.
 *
 * discord.js objects are used duck-typed (only the fields below), so tests can
 * pass small fakes.
 */

export class BackupError extends Error {}

export type FetchBytes = (url: string, maxBytes: number) => Promise<Buffer | null>;

export interface BackupProgress {
  channel: string;
  index: number;
  total: number;
  /** Messages collected so far, across all channels. */
  messages: number;
}

export interface CollectOptions {
  project: string;
  dissolvedBy: string;
  fetchBytes?: FetchBytes;
  onProgress?: (p: BackupProgress) => void;
}

const MAX_IMAGE = 8 * 1024 * 1024;
const MAX_AVATAR = 1024 * 1024;
const PAGE = 100;

const MESSAGE_TYPES = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildVoice, ChannelType.GuildStageVoice]);
const THREAD_PARENTS = new Set<ChannelType>([ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia]);
const NORMAL_TYPES = new Set<number>([MessageType.Default, MessageType.Reply, MessageType.ChatInputCommand, MessageType.ContextMenuCommand]);

/* eslint-disable @typescript-eslint/no-explicit-any */
type AnyChannel = any;
type AnyMessage = any;

export const defaultFetchBytes: FetchBytes = async (url, maxBytes) => {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return null;
    const len = Number(res.headers.get("content-length") ?? 0);
    if (len > maxBytes) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length <= maxBytes ? buf : null;
  } catch {
    return null;
  }
};

const byPosition = (a: AnyChannel, b: AnyChannel) => (a.position ?? 0) - (b.position ?? 0);
const byId = (a: { id: string }, b: { id: string }) => (BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0);
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface Unit {
  channel: AnyChannel;
  category: string;
  kind: BackupChannel["kind"];
  parent?: string;
}

async function listThreads(ch: AnyChannel): Promise<AnyChannel[]> {
  const found = new Map<string, AnyChannel>();
  try {
    const active = await ch.threads.fetchActive();
    for (const t of active.threads.values()) found.set(t.id, t);
    const kinds: ("public" | "private")[] = ch.type === ChannelType.GuildText ? ["public", "private"] : ["public"];
    for (const type of kinds) {
      let before: AnyChannel | undefined;
      for (;;) {
        const res = await ch.threads.fetchArchived({ type, fetchAll: true, limit: PAGE, ...(before ? { before } : {}) });
        const list = [...res.threads.values()];
        for (const t of list) found.set(t.id, t);
        if (!res.hasMore || list.length === 0) break;
        before = list[list.length - 1];
      }
    }
  } catch (err) {
    throw new BackupError(`Could not list threads of #${ch.name}: ${errText(err)}`);
  }
  return [...found.values()].sort(byId);
}

async function fetchAllMessages(ch: AnyChannel): Promise<AnyMessage[]> {
  const all: AnyMessage[] = [];
  let before: string | undefined;
  try {
    for (;;) {
      const page = await ch.messages.fetch({ limit: PAGE, ...(before ? { before } : {}) });
      const list = [...page.values()];
      all.push(...list);
      if (list.length < PAGE) break;
      before = list.reduce((min, m) => (BigInt(m.id) < BigInt(min.id) ? m : min)).id;
    }
  } catch (err) {
    throw new BackupError(`Could not read #${ch.name}: ${errText(err)}`);
  }
  return all.sort(byId);
}

function displayName(m: AnyMessage): string {
  return m.member?.displayName ?? m.author.globalName ?? m.author.username;
}

function istTime(unixSeconds: string): string {
  return new Date(Number(unixSeconds) * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function replaceMentions(text: string, m: AnyMessage, guild: AnyChannel): string {
  const userName = (id: string) =>
    m.mentions?.members?.get(id)?.displayName ??
    guild.members.cache.get(id)?.displayName ??
    m.mentions?.users?.get(id)?.globalName ??
    m.mentions?.users?.get(id)?.username ??
    "unknown-user";
  return text
    .replace(/<@!?(\d+)>/g, (_s, id: string) => `@${userName(id)}`)
    .replace(/<@&(\d+)>/g, (_s, id: string) => `@${guild.roles.cache.get(id)?.name ?? "deleted-role"}`)
    .replace(/<#(\d+)>/g, (_s, id: string) => `#${guild.channels.cache.get(id)?.name ?? "deleted-channel"}`)
    .replace(/<a?:(\w+):\d+>/g, ":$1:")
    .replace(/<t:(\d+)(?::[tTdDfFR])?>/g, (_s, sec: string) => istTime(sec));
}

function systemLabel(m: AnyMessage, name: string): string | null {
  if (NORMAL_TYPES.has(m.type)) return null;
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

const imageType = (t: unknown) => (typeof t === "string" && /^image\/[\w.+-]+$/.test(t) ? t : null);

async function attachments(m: AnyMessage, fetchBytes: FetchBytes): Promise<BackupAttachment[]> {
  const out: BackupAttachment[] = [];
  for (const a of m.attachments.values()) {
    const name = String(a.name ?? "file");
    const size = Number(a.size ?? 0);
    const type = imageType(a.contentType);
    if (!type) {
      out.push({ name, size });
    } else if (size > MAX_IMAGE) {
      out.push({ name, size, note: "image not saved (over 8 MB)" });
    } else {
      const buf = await fetchBytes(a.url, MAX_IMAGE);
      out.push(buf ? { name, size, dataUri: `data:${type};base64,${buf.toString("base64")}` } : { name, size, note: "image could not be saved" });
    }
  }
  return out;
}

async function author(m: AnyMessage, authors: Record<string, BackupAuthor>, fetchBytes: FetchBytes): Promise<string> {
  const id = String(m.author.id);
  if (!authors[id]) {
    const a: BackupAuthor = { id, name: displayName(m), username: m.author.username, bot: Boolean(m.author.bot) };
    const buf = await fetchBytes(m.author.displayAvatarURL({ extension: "png", size: 64 }), MAX_AVATAR);
    if (buf) a.avatar = `data:image/png;base64,${buf.toString("base64")}`;
    authors[id] = a;
  }
  return id;
}

async function convert(m: AnyMessage, guild: AnyChannel, authors: Record<string, BackupAuthor>, fetchBytes: FetchBytes): Promise<BackupMessage> {
  const authorId = await author(m, authors, fetchBytes);
  const content = replaceMentions(String(m.content ?? ""), m, guild);
  const system = systemLabel(m, authors[authorId]!.name);
  return {
    id: String(m.id),
    authorId,
    createdAt: new Date(m.createdAt).toISOString(),
    editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : null,
    content: system ? "" : content,
    replyTo: m.reference?.messageId ?? null,
    pinned: Boolean(m.pinned),
    embeds: (m.embeds ?? []).map((e: AnyMessage) => ({
      title: e.title ?? undefined,
      url: e.url ?? undefined,
      description: e.description ? replaceMentions(e.description, m, guild) : undefined,
      color: e.color ?? null,
      authorName: e.author?.name ?? undefined,
      footer: e.footer?.text ?? undefined,
      fields: (e.fields ?? []).map((f: AnyMessage) => ({ name: String(f.name), value: replaceMentions(String(f.value), m, guild) })),
    })),
    attachments: await attachments(m, fetchBytes),
    reactions: [...m.reactions.cache.values()].map((r: AnyMessage) => ({
      emoji: r.emoji?.id ? `:${r.emoji.name}:` : String(r.emoji?.name ?? "?"),
      count: Number(r.count ?? 0),
    })),
    stickers: [...m.stickers.values()].map((s: AnyMessage) => String(s.name)),
    system,
  };
}

export async function collectProjectMessages(guild: Guild, categoryNames: Set<string>, opts: CollectOptions): Promise<BackupData> {
  const g = guild as AnyChannel;
  const fetchBytes = opts.fetchBytes ?? defaultFetchBytes;
  const me = g.members.me;
  const all: AnyChannel[] = [...g.channels.cache.values()];
  const categories = all.filter((c) => c.type === ChannelType.GuildCategory && categoryNames.has(c.name)).sort(byPosition);

  const units: Unit[] = [];
  for (const cat of categories) {
    const children = all.filter((c) => c.parentId === cat.id && (MESSAGE_TYPES.has(c.type) || THREAD_PARENTS.has(c.type))).sort(byPosition);
    for (const ch of children) {
      const perms = ch.permissionsFor?.(me);
      if (!perms?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory])) {
        throw new BackupError(`Cannot read #${ch.name}: the bot needs View Channel and Read Message History there.`);
      }
      if (MESSAGE_TYPES.has(ch.type)) {
        const voice = ch.type === ChannelType.GuildVoice || ch.type === ChannelType.GuildStageVoice;
        units.push({ channel: ch, category: cat.name, kind: voice ? "voice" : "text" });
      }
      if (THREAD_PARENTS.has(ch.type)) {
        for (const t of await listThreads(ch)) units.push({ channel: t, category: cat.name, kind: "thread", parent: ch.name });
      }
    }
  }

  const authors: Record<string, BackupAuthor> = {};
  const channels: BackupChannel[] = [];
  let count = 0;
  for (const [i, u] of units.entries()) {
    const raw = await fetchAllMessages(u.channel);
    const messages: BackupMessage[] = [];
    for (const m of raw) messages.push(await convert(m, g, authors, fetchBytes));
    count += messages.length;
    channels.push({ id: String(u.channel.id), name: String(u.channel.name), category: u.category, kind: u.kind, ...(u.parent ? { parent: u.parent } : {}), messages });
    opts.onProgress?.({ channel: String(u.channel.name), index: i + 1, total: units.length, messages: count });
  }

  return { project: opts.project, dissolvedAt: new Date().toISOString(), dissolvedBy: opts.dissolvedBy, channels, authors };
}
