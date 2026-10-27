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
vi.mock("../src/services/notify.js", () => ({ dmPaused: () => paused }));
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

const { ladderRouter } = await import("../src/web/v1/ladder.js");
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
  for (const f of [warnFindUnique, warnCreate, warnUpdate, noteCreate, memberSend, membersFetch, getAutoWarn, setAutoWarn]) f.mockClear();
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
    membersFetch.mockRejectedValueOnce(new Error("Unknown Member"));
    res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "not_in_guild" });
    paused = true;
    res = await send("POST", "/dm", { discordUserId: DID, content: "hi" });
    expect(await res.json()).toMatchObject({ error: "dm_failed", reason: "dm_paused" });
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
    warnFindUnique.mockResolvedValueOnce(null);
    expect((await send("DELETE", `/warns/${UID}`)).status).toBe(404);
    expect((await send("DELETE", "/warns/nope")).status).toBe(400);
  });
});
