import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// RC-DIS-01 / 02 / 05: POST / DELETE /api/v1/reps against a fake guild (roles { id, name }; members record add / remove).
const KEY = "k".repeat(40);
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock("../src/lib/log.js", () => ({
  postLog: vi.fn(async () => {}),
  logEmbed: () => ({ setDescription() { return this; }, addFields() { return this; } }),
}));
const projects = [{ key: "cybreach", name: "CyBreach", modules: 2, podsPerModule: 2, active: true }];
vi.mock("../src/config/loader.js", () => ({
  findProject: (k: string) => projects.find((p) => p.key === k.toLowerCase()),
  org: { projects },
}));

type Role = { id: string; name: string };
const roleList: Role[] = ["CyBreach", "CyBreach Module 1", "CyBreach Module 1 Pod 1", "CyBreach M1 P1 Representative", "CyBreach M1 P2 Representative"]
  .map((name, i) => ({ id: `r${i}`, name }));
const rolesCache = (list: Role[]) => {
  const m = new Map(list.map((r) => [r.id, r]));
  return Object.assign(m, { find: (f: (r: Role) => boolean) => [...m.values()].find(f) });
};
let guild: { roles: { cache: ReturnType<typeof rolesCache> }; members: { cache: Map<string, unknown>; fetch: ReturnType<typeof vi.fn> } } | null;
function addMember(id: string, held: string[] = [], failRemove = false) {
  const member = {
    id, displayName: `Name ${id.slice(-2)}`, user: { tag: id }, guild,
    roles: {
      cache: rolesCache(roleList.filter((r) => held.includes(r.name))),
      add: vi.fn(async (r: Role) => { member.roles.cache.set(r.id, r); }),
      remove: vi.fn(async (r: Role) => { if (failRemove) throw new Error("Missing Permissions"); member.roles.cache.delete(r.id); }),
    },
  };
  guild!.members.cache.set(id, member);
  return member;
}
vi.mock("../src/core/botClient.js", () => ({ botGuild: () => guild }));

const { repsRouter } = await import("../src/web/v1/reps.js");
const { apiKeyGuard } = await import("../src/web/v1/apiKey.js");

const A = "210000000000000021";
const OLD = "260000000000000026";
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1/reps", apiKeyGuard(() => KEY), repsRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/reps`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  guild = { roles: { cache: rolesCache(roleList) }, members: { cache: new Map(), fetch: vi.fn() } };
  guild.members.fetch.mockImplementation(async (id: string) => {
    const m = guild!.members.cache.get(id);
    if (!m) throw Object.assign(new Error("Unknown Member"), { code: 10007 });
    return m;
  });
});
const send = (method: string, body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${KEY}` }) =>
  fetch(base, { method, headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const names = (m: ReturnType<typeof addMember>) => [...m.roles.cache.values()].map((r) => r.name).sort();
const assign = { discordUserId: A, projectKey: "cybreach", moduleNum: 1, podNum: 1, actor: { emsUserId: 8, name: "Lena" } };

describe("POST /api/v1/reps", () => {
  it("RC-DIS-05: no or wrong API key → 401", async () => {
    expect((await send("POST", assign, {})).status).toBe(401);
    expect((await send("POST", assign, { Authorization: "Bearer nope" })).status).toBe(401);
  });
  it("RC-DIS-01: a free pod → the rep role plus membership roles; leadership in the answer", async () => {
    const a = addMember(A);
    const res = await send("POST", assign);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, replaced: [], replacedLeadership: [], leadership: { podRepOf: [{ project: "cybreach", module: 1, pod: 1 }] } });
    expect(body.applied).toContain("CyBreach M1 P1 Representative");
    expect(names(a)).toEqual(["CyBreach", "CyBreach M1 P1 Representative", "CyBreach Module 1", "CyBreach Module 1 Pod 1"]);
  });
  it("RC-DIS-02: an occupied pod without replace → 409 with the holder, nothing changed", async () => {
    const old = addMember(OLD, ["CyBreach M1 P1 Representative"]);
    const a = addMember(A);
    const res = await send("POST", assign);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "pod_has_rep", message: "CyBreach M1 P1 already has a representative.", current: [{ discordUserId: OLD, name: "Name 26" }] });
    expect(names(old)).toEqual(["CyBreach M1 P1 Representative"]);
    expect(a.roles.add).not.toHaveBeenCalled();
  });
  it("RC-DIS-02: replace → old role removed, new added; both leaderships reported", async () => {
    const old = addMember(OLD, ["CyBreach M1 P1 Representative"]);
    const a = addMember(A);
    const res = await send("POST", { ...assign, replace: true });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.replaced).toEqual([OLD]);
    expect(body.replacedLeadership).toEqual([{ discordUserId: OLD, leadership: { teamLeadOf: [], coLeadOf: [], podRepOf: [] } }]);
    expect(names(old)).toEqual([]);
    expect(names(a)).toContain("CyBreach M1 P1 Representative");
  });
  it("400 on a bad body; 422 unknown pod / not in the server / rep role missing; 503 bot offline", async () => {
    addMember(A);
    expect((await send("POST", { ...assign, discordUserId: "x" })).status).toBe(400);
    let res = await send("POST", { ...assign, podNum: 9 });
    expect([res.status, (await res.json()).error]).toEqual([422, "unknown_pod"]);
    res = await send("POST", { ...assign, discordUserId: "999999999999999999" });
    expect([res.status, (await res.json()).error]).toEqual([422, "not_in_guild"]);
    res = await send("POST", { ...assign, moduleNum: 2, podNum: 2 });
    expect([res.status, (await res.json()).error]).toEqual([422, "rep_role_missing"]);
    guild = null;
    expect((await send("POST", assign)).status).toBe(503);
  });
});

describe("DELETE /api/v1/reps", () => {
  const remove = { discordUserId: A, projectKey: "cybreach", moduleNum: 1, podNum: 1, reason: "Moved to another pod", actor: { name: "Lena" } };
  it("removes that pod's rep role only and reports the new leadership", async () => {
    const a = addMember(A, ["CyBreach", "CyBreach M1 P1 Representative", "CyBreach M1 P2 Representative"]);
    const res = await send("DELETE", remove);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, removed: ["CyBreach M1 P1 Representative"], leadership: { teamLeadOf: [], coLeadOf: [], podRepOf: [{ project: "cybreach", module: 1, pod: 2 }] } });
    expect(names(a)).toEqual(["CyBreach", "CyBreach M1 P2 Representative"]);
  });
  it("needs a reason (400); a refused removal → 502; RC-DIS-05 key → 401", async () => {
    addMember(A, ["CyBreach M1 P1 Representative"]);
    expect((await send("DELETE", { ...remove, reason: "" })).status).toBe(400);
    expect((await send("DELETE", remove, {})).status).toBe(401);
    addMember("270000000000000027", ["CyBreach M1 P1 Representative"], true);
    const res = await send("DELETE", { ...remove, discordUserId: "270000000000000027" });
    expect([res.status, (await res.json()).error]).toEqual([502, "role_change_failed"]);
  });
});
