import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

const KEY = "k".repeat(40);
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn() } }));

const memberFindMany = vi.fn();
const attendanceFindMany = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: { member: { findMany: memberFindMany }, attendance: { findMany: attendanceFindMany } },
}));

let guild: unknown = null;
vi.mock("../src/core/botClient.js", () => ({ botGuild: () => guild }));

vi.mock("../src/config/loader.js", () => ({
  org: { projects: [{ key: "alpha", name: "Alpha Project", modules: 1, podsPerModule: 1, active: true }] },
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
});
