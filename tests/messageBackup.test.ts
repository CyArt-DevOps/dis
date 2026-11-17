import { describe, it, expect, vi } from "vitest";
import { ChannelType, MessageType } from "discord.js";
import { BackupError, collectProjectMessages } from "../src/services/messageBackup.js";

// The collector reads discord.js objects duck-typed; these fakes carry only what it touches.

type FakeMsg = Record<string, unknown>;
let seq = 1000n;

function fakeMsg(over: Partial<{ id: string; authorId: string; content: string; at: string; attachments: unknown[]; type: number; reply: string; pinned: boolean }> = {}): FakeMsg {
  const authorId = over.authorId ?? "u1";
  const id = over.id ?? String(seq++);
  return {
    id,
    author: {
      id: authorId,
      username: `user${authorId}`,
      globalName: null,
      bot: false,
      displayAvatarURL: () => `https://cdn.test/avatars/${authorId}.png`,
    },
    member: { displayName: authorId === "u1" ? "Ravi Kumar" : "Asha" },
    content: over.content ?? `message ${id}`,
    createdAt: new Date(over.at ?? "2026-11-17T05:00:00Z"),
    editedAt: null,
    reference: over.reply ? { messageId: over.reply } : null,
    pinned: over.pinned ?? false,
    embeds: [],
    attachments: new Map((over.attachments ?? []).map((a, i) => [String(i), a])),
    reactions: { cache: new Map() },
    stickers: new Map(),
    mentions: { users: new Map(), members: new Map() },
    type: over.type ?? MessageType.Default,
    system: (over.type ?? 0) !== MessageType.Default && (over.type ?? 0) !== MessageType.Reply,
  };
}

/** Channel whose history is `msgs` (oldest first); fetch returns newest-first pages like Discord. */
function fakeChannel(o: { id: string; name: string; type?: ChannelType; parentId?: string; position?: number; msgs?: FakeMsg[]; readable?: boolean; threads?: unknown[]; archived?: unknown[] }) {
  const msgs = o.msgs ?? [];
  const fetch = vi.fn(async ({ limit, before }: { limit: number; before?: string }) => {
    const older = msgs.filter((m) => !before || BigInt(m.id as string) < BigInt(before));
    const page = older.slice(-limit).reverse();
    return new Map(page.map((m) => [m.id as string, m]));
  });
  return {
    id: o.id,
    name: o.name,
    type: o.type ?? ChannelType.GuildText,
    parentId: o.parentId ?? null,
    position: o.position ?? 0,
    createdTimestamp: Number(o.id),
    permissionsFor: () => ({ has: () => o.readable !== false }),
    messages: { fetch },
    threads: {
      fetchActive: vi.fn(async () => ({ threads: new Map((o.threads ?? []).map((t) => [(t as { id: string }).id, t])) })),
      fetchArchived: vi.fn(async () => ({ threads: new Map((o.archived ?? []).map((t) => [(t as { id: string }).id, t])), hasMore: false })),
    },
  };
}

function fakeGuild(channels: unknown[]) {
  const cache = new Map(channels.map((c) => [(c as { id: string }).id, c]));
  return {
    members: { me: { id: "bot" }, cache: new Map([["222", { displayName: "Asha" }]]) },
    roles: { cache: new Map([["333", { name: "CyBreach Team Lead" }]]) },
    channels: { cache },
  } as never;
}

const category = (id: string, name: string, position = 0) => ({ id, name, type: ChannelType.GuildCategory, position, parentId: null });

const bytes = vi.fn(async (url: string, _max: number) => (url.includes("fail") ? null : Buffer.from("img")));

async function run(channels: unknown[], names = ["CyBreach M1"]) {
  return collectProjectMessages(fakeGuild(channels), new Set(names), { project: "CyBreach", dissolvedBy: "founder", fetchBytes: bytes });
}

describe("collectProjectMessages", () => {
  it("reads full history across pages, oldest first", async () => {
    const msgs = Array.from({ length: 250 }, (_, i) => fakeMsg({ id: String(5000 + i) }));
    const ch = fakeChannel({ id: "10", name: "m1-general", parentId: "1", msgs });
    const data = await run([category("1", "CyBreach M1"), ch]);
    expect(ch.messages.fetch).toHaveBeenCalledTimes(3);
    expect(data.channels).toHaveLength(1);
    expect(data.channels[0]!.messages).toHaveLength(250);
    expect(data.channels[0]!.messages[0]!.id).toBe("5000");
    expect(data.channels[0]!.messages[249]!.id).toBe("5249");
    expect(data.project).toBe("CyBreach");
    expect(data.dissolvedBy).toBe("founder");
  });

  it("only includes channels under the project's categories, in position order", async () => {
    const data = await run([
      category("1", "CyBreach M1"),
      category("2", "Other"),
      fakeChannel({ id: "11", name: "second", parentId: "1", position: 2 }),
      fakeChannel({ id: "10", name: "first", parentId: "1", position: 1 }),
      fakeChannel({ id: "20", name: "elsewhere", parentId: "2" }),
      fakeChannel({ id: "12", name: "vc", parentId: "1", position: 3, type: ChannelType.GuildVoice }),
    ]);
    expect(data.channels.map((c) => c.name)).toEqual(["first", "second", "vc"]);
    expect(data.channels[2]!.kind).toBe("voice");
    expect(data.channels[0]!.category).toBe("CyBreach M1");
  });

  it("replaces mentions, roles, channels and custom emoji with names", async () => {
    const m = fakeMsg({ content: "hi <@222> <@!999> <@&333> <#10> <:pepe:123>" });
    const data = await run([category("1", "CyBreach M1"), fakeChannel({ id: "10", name: "general", parentId: "1", msgs: [m] })]);
    expect(data.channels[0]!.messages[0]!.content).toBe("hi @Asha @unknown-user @CyBreach Team Lead #general :pepe:");
  });

  it("stores authors once with display name and embedded avatar", async () => {
    bytes.mockClear();
    const data = await run([
      category("1", "CyBreach M1"),
      fakeChannel({ id: "10", name: "g", parentId: "1", msgs: [fakeMsg(), fakeMsg(), fakeMsg({ authorId: "u2" })] }),
    ]);
    expect(Object.keys(data.authors).sort()).toEqual(["u1", "u2"]);
    expect(data.authors.u1).toMatchObject({ name: "Ravi Kumar", username: "useru1", bot: false });
    expect(data.authors.u1!.avatar).toBe(`data:image/png;base64,${Buffer.from("img").toString("base64")}`);
    expect(bytes.mock.calls.filter(([u]) => u.includes("/avatars/u1")).length).toBe(1);
  });

  it("embeds images up to 8 MB, lists other files and over-size or failed images by name", async () => {
    const m = fakeMsg({
      attachments: [
        { name: "a.png", size: 1000, contentType: "image/png", url: "https://cdn.test/a.png" },
        { name: "big.jpg", size: 9 * 1024 * 1024, contentType: "image/jpeg", url: "https://cdn.test/big.jpg" },
        { name: "lost.png", size: 10, contentType: "image/png", url: "https://cdn.test/fail.png" },
        { name: "doc.pdf", size: 500, contentType: "application/pdf", url: "https://cdn.test/doc.pdf" },
      ],
    });
    const data = await run([category("1", "CyBreach M1"), fakeChannel({ id: "10", name: "g", parentId: "1", msgs: [m] })]);
    const [a, big, lost, doc] = data.channels[0]!.messages[0]!.attachments;
    expect(a!.dataUri).toMatch(/^data:image\/png;base64,/);
    expect(big).toEqual({ name: "big.jpg", size: 9 * 1024 * 1024, note: "image not saved (over 8 MB)" });
    expect(lost).toEqual({ name: "lost.png", size: 10, note: "image could not be saved" });
    expect(doc).toEqual({ name: "doc.pdf", size: 500 });
    expect(bytes.mock.calls.some(([u]) => u.includes("big.jpg"))).toBe(false);
  });

  it("keeps replies and pinned flags, and labels system messages", async () => {
    const data = await run([
      category("1", "CyBreach M1"),
      fakeChannel({
        id: "10",
        name: "g",
        parentId: "1",
        msgs: [fakeMsg({ id: "1" }), fakeMsg({ id: "2", reply: "1", pinned: true }), fakeMsg({ id: "3", type: MessageType.ChannelPinnedMessage, content: "" })],
      }),
    ]);
    const [, reply, sys] = data.channels[0]!.messages;
    expect(reply).toMatchObject({ replyTo: "1", pinned: true, system: null });
    expect(sys!.system).toBe("Ravi Kumar pinned a message");
  });

  it("collects active and archived threads under their parent, and forum posts", async () => {
    const t1 = fakeChannel({ id: "30", name: "bug-1", type: ChannelType.PublicThread, msgs: [fakeMsg()] });
    const t2 = fakeChannel({ id: "31", name: "old-bug", type: ChannelType.PublicThread, msgs: [fakeMsg()] });
    const post = fakeChannel({ id: "40", name: "post-1", type: ChannelType.PublicThread, msgs: [fakeMsg()] });
    const data = await run([
      category("1", "CyBreach M1"),
      fakeChannel({ id: "10", name: "general", parentId: "1", position: 1, threads: [t1], archived: [t2] }),
      fakeChannel({ id: "11", name: "ideas", parentId: "1", position: 2, type: ChannelType.GuildForum, threads: [post] }),
    ]);
    expect(data.channels.map((c) => [c.name, c.kind, c.parent ?? null])).toEqual([
      ["general", "text", null],
      ["bug-1", "thread", "general"],
      ["old-bug", "thread", "general"],
      ["post-1", "thread", "ideas"],
    ]);
  });

  it("throws BackupError when a channel cannot be read", async () => {
    await expect(
      run([category("1", "CyBreach M1"), fakeChannel({ id: "10", name: "secret", parentId: "1", readable: false })])
    ).rejects.toThrow(BackupError);
  });

  it("throws BackupError when a fetch fails", async () => {
    const ch = fakeChannel({ id: "10", name: "g", parentId: "1" });
    ch.messages.fetch.mockRejectedValueOnce(new Error("Missing Access"));
    await expect(run([category("1", "CyBreach M1"), ch])).rejects.toThrow(/Could not read #g: Missing Access/);
  });

  it("reports progress per channel", async () => {
    const onProgress = vi.fn();
    await collectProjectMessages(
      fakeGuild([category("1", "CyBreach M1"), fakeChannel({ id: "10", name: "a", parentId: "1", msgs: [fakeMsg()] }), fakeChannel({ id: "11", name: "b", parentId: "1", position: 1 })]),
      new Set(["CyBreach M1"]),
      { project: "CyBreach", dissolvedBy: "f", fetchBytes: bytes, onProgress }
    );
    expect(onProgress).toHaveBeenCalledWith({ channel: "a", index: 1, total: 2, messages: 1 });
    expect(onProgress).toHaveBeenCalledWith({ channel: "b", index: 2, total: 2, messages: 1 });
  });
});
