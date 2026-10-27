import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { ChannelType } from "discord.js";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const KEY = "k".repeat(40);
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config/loader.js", () => ({
  org: { timezone: "Asia/Kolkata", projects: [{ key: "alpha", name: "Alpha", modules: 1, podsPerModule: 1, active: true }] },
}));

const meetingFindUnique = vi.fn();
const meetingFindMany = vi.fn();
const meetingUpdate = vi.fn();
const meetingUpdateMany = vi.fn();
const attendanceFindMany = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: {
    meeting: { findUnique: meetingFindUnique, findMany: meetingFindMany, update: meetingUpdate, updateMany: meetingUpdateMany },
    meetingAttendance: { findMany: attendanceFindMany },
  },
}));

let guild: unknown = null;
vi.mock("../src/core/botClient.js", () => ({ botGuild: () => guild }));
let ready = true;
vi.mock("../src/services/memberCache.js", () => ({ membersReady: () => ready }));
vi.mock("../src/services/meeting.js", () => ({ getOfficeVoiceChannel: () => ({ id: "v-office" }) }));

const scheduleMeeting = vi.fn();
const cancelMeeting = vi.fn();
const renotifyMeeting = vi.fn(async () => "x");
let roleFound = true;
vi.mock("../src/services/meetingScheduler.js", () => ({
  scheduleMeeting, cancelMeeting, renotifyMeeting,
  resolveAudienceRole: () => (roleFound ? { id: "r1" } : undefined),
}));

const { meetingsRouter } = await import("../src/web/v1/meetings.js");
const { apiKeyGuard } = await import("../src/web/v1/apiKey.js");

const UID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const row = (over: Record<string, unknown> = {}) => ({
  id: 7, guildId: "g1", title: "Sprint review", description: null, organizerId: "100000000000000001",
  startAt: new Date(Date.now() + 86_400_000), durationMin: 30, audienceType: "project", audienceBatch: null,
  audienceProject: "alpha", audienceModule: null, audiencePod: null, audienceMemberIds: null, office: null,
  notifyChannelId: null, voiceChannelId: "v-gen", mandatory: true, attendanceWindowMin: 10, reminderIntervalMin: null,
  remindersSent: "", status: "scheduled", createdAt: new Date("2026-10-27T00:00:00Z"),
  uid: UID, source: "ems", updatedAt: new Date("2026-10-27T01:00:00Z"), recurrenceUid: null, ...over,
});
const ch = (id: string, name: string, type: number, parentId: string | null) => [id, { id, name, type, parentId }] as const;
const fakeGuild = {
  client: { user: { id: "999999999999999999" } },
  channels: { cache: new Map([ch("c1", "ALPHA", ChannelType.GuildCategory, null), ch("v-gen", "Alpha General VC", ChannelType.GuildVoice, "c1")]) },
  members: { cache: new Map([["100000000000000002", {}]]) },
};

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1", apiKeyGuard(() => KEY));
  app.use("/api/v1/meetings", meetingsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/meetings`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  for (const f of [meetingFindUnique, meetingFindMany, meetingUpdate, meetingUpdateMany, attendanceFindMany, scheduleMeeting, cancelMeeting, renotifyMeeting]) f.mockReset();
  guild = fakeGuild;
  ready = true;
  roleFound = true;
});

const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
const createBody = (over: Record<string, unknown> = {}) => ({
  uid: UID, title: "Sprint review", organizerDiscordId: "100000000000000001",
  startAt: new Date(Date.now() + 86_400_000).toISOString(), durationMin: 30,
  audienceType: "project", audienceProject: "alpha", mandatory: true, updatedAt: "2026-10-27T01:00:00.000Z", ...over,
});

describe("POST /meetings", () => {
  it("creates with source ems, the project General VC and the given uid → 201", async () => {
    meetingFindUnique.mockResolvedValue(null);
    scheduleMeeting.mockResolvedValue(row());
    const res = await send("POST", "", createBody());
    expect(res.status).toBe(201);
    expect((await res.json()).uid).toBe(UID);
    expect(scheduleMeeting.mock.calls[0]![0]).toMatchObject({ uid: UID, source: "ems", voiceChannelId: "v-gen", audienceProject: "alpha", attendanceWindowMin: 10 });
  });
  it("same uid again → 200 with the stored meeting, no second create", async () => {
    meetingFindUnique.mockResolvedValue(row());
    const res = await send("POST", "", createBody());
    expect(res.status).toBe(200);
    expect(scheduleMeeting).not.toHaveBeenCalled();
  });
  it("a racing duplicate (unique clash) also answers 200", async () => {
    meetingFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(row());
    scheduleMeeting.mockRejectedValue(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await send("POST", "", createBody())).status).toBe(200);
  });
  it("422 start_in_past", async () => {
    meetingFindUnique.mockResolvedValue(null);
    const res = await send("POST", "", createBody({ startAt: "2020-01-01T00:00:00Z" }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe("start_in_past");
  });
  it("422 audience_unresolved when no role matches, or a person is not in the server", async () => {
    meetingFindUnique.mockResolvedValue(null);
    roleFound = false;
    expect((await (await send("POST", "", createBody())).json()).error).toBe("audience_unresolved");
    const res = await send("POST", "", createBody({ audienceType: "people", audienceProject: null, audienceMemberIds: ["100000000000000002", "100000000000000003"] }));
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "audience_unresolved", missing: ["100000000000000003"] });
  });
  it("people meetings use the office VC and pass the office", async () => {
    meetingFindUnique.mockResolvedValue(null);
    scheduleMeeting.mockResolvedValue(row({ audienceType: "people" }));
    await send("POST", "", createBody({ audienceType: "people", audienceProject: null, audienceMemberIds: ["100000000000000002"], office: "hr" }));
    expect(scheduleMeeting.mock.calls[0]![0]).toMatchObject({ voiceChannelId: "v-office", office: "hr", audienceMemberIds: "100000000000000002" });
  });
  it("422 voice_channel_missing when the module VC does not exist", async () => {
    meetingFindUnique.mockResolvedValue(null);
    expect((await (await send("POST", "", createBody({ audienceType: "module", audienceModule: 1 }))).json()).error).toBe("voice_channel_missing");
  });
  it("400 invalid with issues when an audience field is missing", async () => {
    const res = await send("POST", "", createBody({ audienceType: "pod", audienceModule: 1 }));
    expect(res.status).toBe(400);
    expect((await res.json()).issues).toContain("audiencePod: required for audience pod");
  });
  it("400 when startAt or updatedAt has no explicit offset", async () => {
    const local = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "");
    const res = await send("POST", "", createBody({ startAt: local }));
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0]).toMatch(/^startAt: /);
    expect((await send("POST", "", createBody({ updatedAt: "2026-10-27T01:00:00" }))).status).toBe(400);
    meetingFindUnique.mockResolvedValue(null);
    scheduleMeeting.mockResolvedValue(row());
    const withOffset = new Date(Date.now() + 86_400_000).toISOString().replace("Z", "+05:30");
    expect((await send("POST", "", createBody({ startAt: withOffset }))).status).toBe(201);
  });
  it("503 bot_offline without the guild", async () => {
    meetingFindUnique.mockResolvedValue(null);
    guild = null;
    expect((await send("POST", "", createBody())).status).toBe(503);
  });
});

describe("PATCH /meetings/:uid", () => {
  it("applies the edit with EMS's updatedAt and re-arms reminders on a new time", async () => {
    const startAt = new Date(Date.now() + 2 * 86_400_000).toISOString();
    meetingFindUnique
      .mockResolvedValueOnce(row())
      .mockResolvedValueOnce(row({ startAt: new Date(startAt), updatedAt: new Date("2026-10-27T02:00:00Z") }));
    meetingUpdateMany.mockResolvedValue({ count: 1 });
    const res = await send("PATCH", `/${UID}`, { startAt, updatedAt: "2026-10-27T02:00:00.000Z" });
    expect(res.status).toBe(200);
    expect((await res.json()).updatedAt).toBe("2026-10-27T02:00:00.000Z");
    const call = meetingUpdateMany.mock.calls[0]![0];
    expect(call.where).toEqual({ id: 7, status: "scheduled", updatedAt: new Date("2026-10-27T01:00:00Z") });
    expect(call.data).toMatchObject({ startAt: new Date(startAt), remindersSent: "", updatedAt: new Date("2026-10-27T02:00:00Z") });
    expect(renotifyMeeting).toHaveBeenCalled();
  });
  it("409 when the sweep started it (not_scheduled) or another edit landed (stale) between read and write", async () => {
    meetingUpdateMany.mockResolvedValue({ count: 0 });
    meetingFindUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "monitoring" }));
    let res = await send("PATCH", `/${UID}`, { title: "New", updatedAt: "2026-10-27T02:00:00.000Z" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_scheduled");
    meetingFindUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ updatedAt: new Date("2026-10-27T01:30:00Z") }));
    res = await send("PATCH", `/${UID}`, { title: "New", updatedAt: "2026-10-27T02:00:00.000Z" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("stale");
    expect(renotifyMeeting).not.toHaveBeenCalled();
  });
  it("409 stale when the edit is older than the stored meeting", async () => {
    meetingFindUnique.mockResolvedValue(row());
    const res = await send("PATCH", `/${UID}`, { title: "Old", updatedAt: "2026-10-27T00:30:00.000Z" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("stale");
    expect(meetingUpdate).not.toHaveBeenCalled();
  });
  it("409 not_scheduled once the meeting started", async () => {
    meetingFindUnique.mockResolvedValue(row({ status: "monitoring" }));
    const res = await send("PATCH", `/${UID}`, { title: "New", updatedAt: "2026-10-27T03:00:00.000Z" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("not_scheduled");
  });
  it("404 for an unknown uid", async () => {
    meetingFindUnique.mockResolvedValue(null);
    expect((await send("PATCH", `/${UID}`, { title: "x", updatedAt: "2026-10-27T03:00:00.000Z" })).status).toBe(404);
  });
});

describe("POST /meetings/:uid/cancel", () => {
  it("cancels a scheduled meeting without echo (source ems)", async () => {
    meetingFindUnique.mockResolvedValue(row());
    cancelMeeting.mockResolvedValue(row({ status: "cancelled" }));
    const res = await send("POST", `/${UID}/cancel`, { updatedAt: "2026-10-27T02:00:00.000Z" });
    expect(res.status).toBe(200);
    expect(cancelMeeting).toHaveBeenCalledWith(7, { source: "ems", updatedAt: new Date("2026-10-27T02:00:00Z") });
  });
  it("409 already_started once monitoring; 200 no-op when already cancelled", async () => {
    meetingFindUnique.mockResolvedValue(row({ status: "monitoring" }));
    expect((await send("POST", `/${UID}/cancel`, {})).status).toBe(409);
    meetingFindUnique.mockResolvedValue(row({ status: "cancelled" }));
    expect((await send("POST", `/${UID}/cancel`, {})).status).toBe(200);
    expect(cancelMeeting).not.toHaveBeenCalled();
  });
  it("409 already_started when the sweep starts it between the read and the write", async () => {
    meetingFindUnique.mockResolvedValueOnce(row()).mockResolvedValueOnce(row({ status: "monitoring" }));
    cancelMeeting.mockResolvedValue(null);
    const res = await send("POST", `/${UID}/cancel`, {});
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe("already_started");
  });
});

describe("GET /meetings and attendance", () => {
  it("lists changes since updatedSince, oldest first, max 500", async () => {
    meetingFindMany.mockResolvedValue([row()]);
    const res = await send("GET", "?updatedSince=2026-10-27T00:00:00.000Z");
    expect(res.status).toBe(200);
    expect(await res.json()).toHaveLength(1);
    expect(meetingFindMany.mock.calls[0]![0]).toMatchObject({
      where: { guildId: "g1", updatedAt: { gte: new Date("2026-10-27T00:00:00Z") } }, take: 500,
    });
  });
  it("orders by (updatedAt, uid) and pages strictly after (updatedSince, afterId)", async () => {
    meetingFindMany.mockResolvedValue([]);
    await send("GET", `?updatedSince=2026-10-27T00:00:00.000Z&afterId=${UID}`);
    const since = new Date("2026-10-27T00:00:00Z");
    expect(meetingFindMany.mock.calls[0]![0]).toEqual({
      where: { guildId: "g1", OR: [{ updatedAt: { gt: since } }, { updatedAt: since, uid: { gt: UID } }] },
      orderBy: [{ updatedAt: "asc" }, { uid: "asc" }],
      take: 500,
    });
    expect((await send("GET", "?updatedSince=2026-10-27T00:00:00.000Z&afterId=7")).status).toBe(400);
  });
  it("400 on a bad updatedSince", async () => {
    expect((await send("GET", "?updatedSince=nope")).status).toBe(400);
  });
  it("409 not_final until the meeting is completed", async () => {
    for (const status of ["scheduled", "monitoring", "cancelled"]) {
      meetingFindUnique.mockResolvedValue(row({ status }));
      const res = await send("GET", `/${UID}/attendance`);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: "not_final", status });
    }
    expect(attendanceFindMany).not.toHaveBeenCalled();
  });
  it("returns the final attendance rows", async () => {
    meetingFindUnique.mockResolvedValue(row({ status: "completed" }));
    attendanceFindMany.mockResolvedValue([{ userId: "u1", status: "left_early", minutesLate: 0, secondsAttended: 700 }]);
    const res = await send("GET", `/${UID}/attendance`);
    expect(await res.json()).toEqual({ uid: UID, status: "completed", rows: [{ discordUserId: "u1", status: "left_early", minutesLate: 0, secondsAttended: 700 }] });
  });
  it("401 without the key", async () => {
    expect((await fetch(`${base}`)).status).toBe(401);
  });
});
