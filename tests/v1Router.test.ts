import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { ChannelType } from "discord.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const KEY = "k".repeat(40);
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const memberFindMany = vi.fn();
const attendanceFindMany = vi.fn();
const voiceFindMany = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: { member: { findMany: memberFindMany }, attendance: { findMany: attendanceFindMany }, voiceSession: { findMany: voiceFindMany } },
}));

let guild: unknown = null;
vi.mock("../src/core/botClient.js", () => ({ botGuild: () => guild }));

vi.mock("../src/config/loader.js", () => ({
  org: { timezone: "Asia/Kolkata", projects: [{ key: "alpha", name: "Alpha Project", modules: 1, podsPerModule: 1, active: true }] },
}));

const { markMembersReady, resetMemberCacheForTests } = await import("../src/services/memberCache.js");
const { v1Router } = await import("../src/web/v1/router.js");

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1", v1Router);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  memberFindMany.mockReset();
  attendanceFindMany.mockReset();
  voiceFindMany.mockReset();
  voiceFindMany.mockResolvedValue([]);
  guild = null;
  resetMemberCacheForTests();
  markMembersReady();
});

const auth = { Authorization: `Bearer ${KEY}` };

const row = {
  id: "u1", fullName: "Ada", displayName: null, tag: "ada", batch: "B1", project: "Alpha Project",
  module: 1, pod: 1, status: "active", verificationStatus: "verified", updatedAt: new Date("2026-01-01T00:00:00Z"),
};

describe("v1Router", () => {
  it("/health reports when this process started (EMS outage guard)", async () => {
    const body = await (await fetch(`${base}/health`, { headers: auth })).json();
    expect(body.ok).toBe(true);
    expect(Date.parse(body.startedAt)).toBeLessThanOrEqual(Date.now());
    expect(Date.parse(body.startedAt)).toBeGreaterThan(Date.now() - 3600_000);
  });
  it("401s without a key", async () => {
    expect((await fetch(`${base}/org`)).status).toBe(401);
  });
  it("accepts a lowercase bearer scheme", async () => {
    const res = await fetch(`${base}/org`, { headers: { Authorization: `bearer ${KEY}` } });
    expect(res.status).toBe(200);
  });
  it("503s /members when the bot is offline", async () => {
    const res = await fetch(`${base}/members`, { headers: auth });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "bot offline — leadership unknown" });
  });
  it("503s /members while the member cache is warming, 200 once ready", async () => {
    memberFindMany.mockResolvedValue([]);
    guild = { members: { cache: { get: () => undefined } } };
    resetMemberCacheForTests();
    const res = await fetch(`${base}/members`, { headers: auth });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "member cache warming" });
    markMembersReady();
    expect((await fetch(`${base}/members`, { headers: auth })).status).toBe(200);
  });
  it("maps stored project name to key and leadership from role names", async () => {
    memberFindMany.mockResolvedValue([row]);
    guild = { members: { cache: { get: () => ({ roles: { cache: { map: (f: (r: { name: string }) => string) => [{ name: "Alpha Project Team Lead" }].map(f) } } }) } } };
    const res = await fetch(`${base}/members`, { headers: auth });
    expect(res.status).toBe(200);
    const [m] = (await res.json()) as { project: string; leadership: unknown }[];
    expect(m!.project).toBe("alpha");
    expect(m!.leadership).toEqual({ teamLeadOf: ["alpha"], coLeadOf: [] });
  });
  it("nulls module and pod when the project no longer exists", async () => {
    memberFindMany.mockResolvedValue([{ ...row, project: "Gone" }]);
    guild = { members: { cache: { get: () => undefined } } };
    const [m] = (await (await fetch(`${base}/members`, { headers: auth })).json()) as { project: unknown; module: unknown; pod: unknown }[];
    expect([m!.project, m!.module, m!.pod]).toEqual([null, null, null]);
  });
  it("400s /members on an invalid updatedSince", async () => {
    guild = { members: { cache: { get: () => undefined } } };
    const res = await fetch(`${base}/members?updatedSince=garbage`, { headers: auth });
    expect(res.status).toBe(400);
  });
  it("400s /attendance on impossible dates", async () => {
    const res = await fetch(`${base}/attendance?from=2026-13-45&to=2026-13-46`, { headers: auth });
    expect(res.status).toBe(400);
    expect(attendanceFindMany).not.toHaveBeenCalled();
  });
  it("serves /attendance for a valid range", async () => {
    attendanceFindMany.mockResolvedValue([{ userId: "u1", day: "2026-01-02", seconds: 60 }]);
    const res = await fetch(`${base}/attendance?from=2026-01-01&to=2026-01-31`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
  });
  it("adds secondsAssigned (assigned VCs only, clipped to the IST day) and firstJoinAt", async () => {
    attendanceFindMany.mockResolvedValue([{ userId: "u1", day: "2026-01-02", seconds: 9000 }]);
    memberFindMany.mockResolvedValue([{ id: "u1", project: "Alpha Project", module: 1, pod: 1 }]);
    const ch = (id: string, name: string, type: number, parentId: string | null) => [id, { id, name, type, parentId }] as const;
    guild = {
      channels: { cache: new Map([
        ch("c1", "ALPHA PROJECT", ChannelType.GuildCategory, null),
        ch("v1", "Alpha Project General VC", ChannelType.GuildVoice, "c1"),
        ch("c2", "Alpha Project M1", ChannelType.GuildCategory, null),
        ch("v2", "Alpha Project M1 P1 VC", ChannelType.GuildVoice, "c2"),
        ch("v9", "Random VC", ChannelType.GuildVoice, null),
      ]) },
      members: { cache: { get: () => ({ roles: { cache: { map: () => [] } } }) } },
    };
    // IST day 2026-01-02 = [2026-01-01T18:30Z, 2026-01-02T18:30Z)
    voiceFindMany.mockResolvedValue([
      { userId: "u1", channelId: "v2", joinedAt: new Date("2026-01-01T18:00:00Z"), leftAt: new Date("2026-01-01T19:30:00Z") }, // 1h inside the day
      { userId: "u1", channelId: "v9", joinedAt: new Date("2026-01-02T05:00:00Z"), leftAt: new Date("2026-01-02T06:00:00Z") }, // not assigned
      { userId: "u1", channelId: "v1", joinedAt: new Date("2026-01-02T06:00:00Z"), leftAt: new Date("2026-01-02T06:30:00Z") }, // 30 min
    ]);
    const res = await fetch(`${base}/attendance?from=2026-01-02&to=2026-01-02`, { headers: auth });
    expect(await res.json()).toEqual([{ userId: "u1", day: "2026-01-02", seconds: 9000, secondsAssigned: 5400, firstJoinAt: "2026-01-01T18:30:00.000Z" }]);
  });
  it("reports secondsAssigned null while the bot is offline", async () => {
    attendanceFindMany.mockResolvedValue([{ userId: "u1", day: "2026-01-02", seconds: 60 }]);
    const [row] = (await (await fetch(`${base}/attendance?from=2026-01-02&to=2026-01-02`, { headers: auth })).json()) as { secondsAssigned: unknown; firstJoinAt: unknown }[];
    expect(row!.secondsAssigned).toBeNull();
    expect(row!.firstJoinAt).toBeNull();
  });
  it("caps secondsAssigned at the row's capped seconds", async () => {
    attendanceFindMany.mockResolvedValue([{ userId: "u1", day: "2026-01-02", seconds: 1800 }]);
    memberFindMany.mockResolvedValue([{ id: "u1", project: "Alpha Project", module: 1, pod: 1 }]);
    const ch = (id: string, name: string, type: number, parentId: string | null) => [id, { id, name, type, parentId }] as const;
    guild = {
      channels: { cache: new Map([
        ch("c1", "ALPHA PROJECT", ChannelType.GuildCategory, null),
        ch("v1", "Alpha Project General VC", ChannelType.GuildVoice, "c1"),
      ]) },
      members: { cache: { get: () => ({ roles: { cache: { map: () => [] } } }) } },
    };
    voiceFindMany.mockResolvedValue([
      { userId: "u1", channelId: "v1", joinedAt: new Date("2026-01-02T06:00:00Z"), leftAt: new Date("2026-01-02T08:00:00Z") }, // 2h raw
    ]);
    const [r] = (await (await fetch(`${base}/attendance?from=2026-01-02&to=2026-01-02`, { headers: auth })).json()) as { secondsAssigned: number }[];
    expect(r!.secondsAssigned).toBe(1800);
  });
  it("reports secondsAssigned null (firstJoinAt still set) while the member cache is warming", async () => {
    attendanceFindMany.mockResolvedValue([{ userId: "u1", day: "2026-01-02", seconds: 3600 }]);
    memberFindMany.mockResolvedValue([{ id: "u1", project: "Alpha Project", module: 1, pod: 1 }]);
    guild = { channels: { cache: new Map() }, members: { cache: { get: () => undefined } } };
    voiceFindMany.mockResolvedValue([
      { userId: "u1", channelId: "v1", joinedAt: new Date("2026-01-02T06:00:00Z"), leftAt: new Date("2026-01-02T07:00:00Z") },
    ]);
    resetMemberCacheForTests();
    const [r] = (await (await fetch(`${base}/attendance?from=2026-01-02&to=2026-01-02`, { headers: auth })).json()) as { secondsAssigned: unknown; firstJoinAt: unknown }[];
    expect(r!.secondsAssigned).toBeNull();
    expect(r!.firstJoinAt).toBe("2026-01-02T06:00:00.000Z");
  });
  it("allows exactly 31 inclusive days and rejects 32", async () => {
    attendanceFindMany.mockResolvedValue([]);
    expect((await fetch(`${base}/attendance?from=2026-01-01&to=2026-01-31`, { headers: auth })).status).toBe(200);
    const res = await fetch(`${base}/attendance?from=2026-01-01&to=2026-02-01`, { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "range too large (max 31 days)" });
  });
});
