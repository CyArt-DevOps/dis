import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const KEY = "k".repeat(40);
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../src/config/loader.js", () => ({ org: { timezone: "Asia/Kolkata", projects: [{ key: "alpha", name: "Alpha" }] } }));

const warnFindUnique = vi.fn();
const warnCreate = vi.fn();
const warnUpdate = vi.fn();
const noteCreate = vi.fn(async () => ({}));
vi.mock("../src/core/db.js", () => ({
  prisma: { warn: { findUnique: warnFindUnique, create: warnCreate, update: warnUpdate }, warnNote: { create: noteCreate } },
}));
let paused = false;
const pauseDms = vi.fn();
vi.mock("../src/services/notify.js", () => ({ dmPaused: () => paused, pauseDms }));
const getAutoWarn = vi.fn(async () => ({ disabledProjects: [] as string[] | "all" }));
const setAutoWarn = vi.fn(async (v: unknown) => v);
vi.mock("../src/services/autoWarn.js", () => ({ getAutoWarn, setAutoWarn }));

const memberSend = vi.fn();
const membersFetch = vi.fn();
let online = true;
vi.mock("../src/core/botClient.js", () => ({
  botClient: () => (online ? {} : null),
  botGuild: () => (online ? { members: { fetch: membersFetch } } : null),
}));

const { ladderRouter, resetDmThrottleForTests, setDmSendTimeoutForTests } = await import("../src/web/v1/ladder.js");
const { apiKeyGuard } = await import("../src/web/v1/apiKey.js");

const UID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const DID = "200000000000000001";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1", apiKeyGuard(() => KEY), ladderRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  for (const f of [warnFindUnique, warnCreate, warnUpdate, noteCreate, memberSend, membersFetch, getAutoWarn, setAutoWarn, pauseDms]) f.mockClear();
  resetDmThrottleForTests();
  setDmSendTimeoutForTests(12_000);
  membersFetch.mockResolvedValue({ send: memberSend });
  memberSend.mockResolvedValue({});
  paused = false;
  online = true;
});
const headers = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const send = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });

describe("POST /dm", () => {
  it("needs the Bearer key", async () => {
    expect((await fetch(`${base}/dm`, { method: "POST" })).status).toBe(401);
  });
  it("delivers a plain DM with no pings → 200 { ok: true }", async () => {
    const res = await send("POST", "/dm", { discordUserId: DID, content: "  Hello @everyone  " });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(memberSend).toHaveBeenCalledWith({ content: "Hello @everyone", allowedMentions: { parse: [] } });
  });
  it("400 on a bad id or a body over 2000 characters", async () => {
    expect((await send("POST", "/dm", { discordUserId: "x", content: "hi" })).status).toBe(400);
    const res = await send("POST", "/dm", { discordUserId: DID, content: "a".repeat(2001) });
    expect(res.status).toBe(400);
    expect((await res.json()).issues[0]).toMatch(/^content:/);
  });
  it("422 dm_failed with a reason: closed DMs, not in the server, DMs paused", async () => {
    memberSend.mockRejectedValueOnce(Object.assign(new Error("Cannot send messages to this user"), { code: 50007 }));
    let res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "dms_closed" });
    expect(pauseDms).not.toHaveBeenCalled(); // closed DMs are one person's setting, not a bot-wide problem
    resetDmThrottleForTests();
    membersFetch.mockRejectedValueOnce(Object.assign(new Error("Unknown Member"), { code: 10007 }));
    res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "not_in_guild" });
    membersFetch.mockRejectedValueOnce(Object.assign(new Error("Unknown User"), { code: 10013 }));
    res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "unknown_user" });
    paused = true;
    res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "dm_paused" });
  });
  it("503 bot_unavailable when Discord fails for another reason (EMS may retry)", async () => {
    membersFetch.mockRejectedValueOnce(Object.assign(new Error("Service Unavailable"), { status: 503 }));
    const res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "bot_unavailable", message: expect.stringMatching(/Service Unavailable/) });
    expect(memberSend).not.toHaveBeenCalled();
  });
  it("a quarantine error (20026) pauses the bot's DMs like notify does", async () => {
    memberSend.mockRejectedValueOnce(Object.assign(new Error("flagged"), { code: 20026 }));
    const res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "bot_quarantined" });
    expect(pauseDms).toHaveBeenCalledTimes(1);
  });
  it("one DM per person per 30 s → 429 rate_limited; other people are unaffected", async () => {
    expect((await send("POST", "/dm", { discordUserId: DID, content: "hi" })).status).toBe(200);
    const res = await send("POST", "/dm", { discordUserId: DID, content: "hi again" });
    expect(res.status).toBe(429);
    expect(await res.json()).toMatchObject({ error: "rate_limited" });
    expect(res.headers.get("retry-after")).toMatch(/^\d+$/);
    expect((await send("POST", "/dm", { discordUserId: "200000000000000002", content: "hi" })).status).toBe(200);
    expect(memberSend).toHaveBeenCalledTimes(2);
  });
  it("a send that hangs → 503 send_timeout (it may still arrive; the throttle stops a quick duplicate)", async () => {
    setDmSendTimeoutForTests(30);
    memberSend.mockImplementationOnce(() => new Promise(() => {}));
    const res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ error: "send_timeout" });
    expect((await send("POST", "/dm", { discordUserId: DID, content: "hi" })).status).toBe(429);
  });
  it("503 bot_offline without the gateway", async () => {
    online = false;
    expect((await send("POST", "/dm", { discordUserId: DID, content: "hi" })).status).toBe(503);
  });
});

describe("/settings/auto-warn", () => {
  it("PUT stores a list (unknown keys reported) or 'all'; GET reads it back", async () => {
    let res = await send("PUT", "/settings/auto-warn", { disabledProjects: ["alpha", "ghost"] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ disabledProjects: ["alpha", "ghost"], unknown: ["ghost"] });
    expect(setAutoWarn).toHaveBeenCalledWith({ disabledProjects: ["alpha", "ghost"] });
    res = await send("PUT", "/settings/auto-warn", { disabledProjects: "all" });
    expect(await res.json()).toEqual({ disabledProjects: "all", unknown: [] });
    getAutoWarn.mockResolvedValueOnce({ disabledProjects: "all" });
    expect(await (await send("GET", "/settings/auto-warn")).json()).toEqual({ disabledProjects: "all" });
  });
  it("400 on anything else", async () => {
    expect((await send("PUT", "/settings/auto-warn", { disabledProjects: "some" })).status).toBe(400);
    expect((await send("PUT", "/settings/auto-warn", {})).status).toBe(400);
  });
});

describe("/warns mirror", () => {
  const body = { uid: UID, discordUserId: DID, reason: "Formal warning: 3 strikes this week", kind: "conduct" };
  it("POST creates a sent Warn with source ems and the uid → 201", async () => {
    warnFindUnique.mockResolvedValue(null);
    warnCreate.mockResolvedValue({ id: 9, externalUid: UID, status: "sent" });
    const res = await send("POST", "/warns", body);
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ id: 9, uid: UID, status: "sent" });
    expect(warnCreate.mock.calls[0]![0].data).toMatchObject({
      guildId: "g1", userId: DID, source: "ems", status: "sent", kind: "conduct", externalUid: UID, modId: "ems",
    });
  });
  it("the same uid again → 200, no second row (also when a racing insert wins)", async () => {
    warnFindUnique.mockResolvedValue({ id: 9, externalUid: UID, status: "sent" });
    expect((await send("POST", "/warns", body)).status).toBe(200);
    expect(warnCreate).not.toHaveBeenCalled();
    warnFindUnique.mockReset();
    warnFindUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 9, externalUid: UID, status: "sent" });
    warnCreate.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "P2002" }));
    expect((await send("POST", "/warns", body)).status).toBe(200);
  });
  it("DELETE revokes once, keeps a note, and is idempotent; 404 for an unknown uid", async () => {
    warnFindUnique.mockReset();
    warnFindUnique.mockResolvedValueOnce({ id: 9, externalUid: UID, status: "sent" });
    warnUpdate.mockResolvedValue({ id: 9, externalUid: UID, status: "revoked" });
    let res = await send("DELETE", `/warns/${UID}`, { reason: "Excuse accepted" });
    expect(await res.json()).toEqual({ id: 9, uid: UID, status: "revoked" });
    expect(warnUpdate).toHaveBeenCalledWith({ where: { id: 9 }, data: { status: "revoked", reviewedBy: "ems" } });
    expect(noteCreate.mock.calls[0]![0].data).toMatchObject({ warnId: 9, kind: "revoke", body: "Excuse accepted" });
    warnFindUnique.mockResolvedValueOnce({ id: 9, externalUid: UID, status: "revoked" });
    res = await send("DELETE", `/warns/${UID}`);
    expect(res.status).toBe(200);
    expect(warnUpdate).toHaveBeenCalledTimes(1);
    warnFindUnique.mockResolvedValueOnce({ id: 9, externalUid: UID, status: "dismissed" });
    res = await send("DELETE", `/warns/${UID}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: 9, uid: UID, status: "dismissed" });
    expect(warnUpdate).toHaveBeenCalledTimes(1);
    expect(noteCreate).toHaveBeenCalledTimes(1);
    warnFindUnique.mockResolvedValueOnce(null);
    expect((await send("DELETE", `/warns/${UID}`)).status).toBe(404);
    expect((await send("DELETE", "/warns/nope")).status).toBe(400);
  });
});
