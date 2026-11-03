import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// HA-W*, HA-L*, HA-S1/S8: the bot's side of the HR actions sync against in-memory tables.
const KEY = "k".repeat(40);
const G = "g1";
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const MEMBER = "210000000000000021";
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
type Row = Record<string, any>;
let warns: Row[] = [];
let leaves: Row[] = [];
let next = 1;
const match = (r: Row, w: Row): boolean => Object.entries(w).every(([k, v]: [string, any]) => {
  if (k === "OR") return v.some((o: Row) => match(r, o));
  if (k === "NOT") return !match(r, v);
  if (v instanceof Date) return r[k].getTime() === v.getTime();
  if (v && typeof v === "object") {
    if ("not" in v) return r[k] !== v.not;
    if ("gte" in v) return r[k] >= v.gte;
    if ("gt" in v) return r[k] > v.gt;
  }
  return r[k] === v;
});
const table = (get: () => Row[], key: string) => ({
  findMany: vi.fn(async ({ where, take }: Row) =>
    get().filter((r) => match(r, where)).sort((a, b) => a.updatedAt - b.updatedAt || a.id - b.id).slice(0, take)),
  findUnique: vi.fn(async ({ where }: Row) => get().find((r) => (where.id ? r.id === where.id : r[key] === where[key])) ?? null),
  create: vi.fn(async ({ data }: Row) => { const row = { id: next++, updatedAt: new Date(), ...data }; get().push(row); return row; }),
});
vi.mock("../src/core/db.js", () => ({
  prisma: {
    warn: table(() => warns, "externalUid"),
    leaveRequest: table(() => leaves, "uid"),
    member: { findUnique: vi.fn(async ({ where }: Row) => (where.id === "210000000000000021" ? { guildId: "g1" } : null)) },
  },
}));
const sendWarning = vi.fn(async (id: number) => { warns.find((w) => w.id === id)!.status = "sent"; return { status: "sent" }; });
const revokeWarning = vi.fn(async (id: number) => { warns.find((w) => w.id === id)!.status = "revoked"; return { notified: true }; });
class WarningError extends Error {}
vi.mock("../src/services/warnings.js", () => ({ sendWarning, revokeWarning, WarningError }));
const grantManualLeave = vi.fn(async (_g: string, userId: string, input: Row, opts: Row) => {
  const row = { id: next++, guildId: "g1", uid: opts.uid, userId, type: input.type, status: "approved", approvedDays: input.dates.join(","), startAt: new Date(), endAt: new Date(), reason: input.reason, reviewedById: `dashboard:${input.approvedBy}`, reviewedAt: new Date(), updatedAt: new Date() };
  leaves.push(row);
  return { id: row.id, days: input.dates, excusedMeetings: 0 };
});
const revokeManualLeave = vi.fn(async (_g: string, _u: string, id: number) => { leaves.find((l) => l.id === id)!.status = "revoked"; });
class LeaveInputError extends Error {}
vi.mock("../src/services/manualLeave.js", () => ({
  grantManualLeave, revokeManualLeave, LeaveInputError, EMS_APPROVER: "EMS: ",
  leaveDays: (l: Row) => (l.approvedDays ?? "").split(",").filter(Boolean),
  leaveOrigin: (r: string | null) => (r?.startsWith("dashboard:EMS: ") ? "ems" : r?.startsWith("dashboard:") ? "dashboard" : "discord"),
}));

const { warningsRouter, leavesRouter } = await import("../src/web/v1/hrSync.js");
const { apiKeyGuard } = await import("../src/web/v1/apiKey.js");

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  const guard = apiKeyGuard(() => KEY);
  app.use("/w", guard, warningsRouter);
  app.use("/l", guard, leavesRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => { warns = []; leaves = []; next = 1; vi.clearAllMocks(); });

const auth = { Authorization: `Bearer ${KEY}`, "Content-Type": "application/json" };
const get = (p: string) => fetch(base + p, { headers: auth });
const post = (p: string, b: unknown = {}) => fetch(base + p, { method: "POST", headers: auth, body: JSON.stringify(b) });
const warn = (o: Row = {}) => { const r = { id: next++, guildId: G, externalUid: U1, userId: MEMBER, source: "manual", kind: "other", status: "sent", reason: "Late again", issuedBy: "HR", reviewedBy: null, modId: "x", createdAt: new Date(), sentAt: new Date(), updatedAt: new Date("2026-11-03T00:00:00Z"), ...o }; warns.push(r); return r; };
const leave = (o: Row = {}) => { const r = { id: next++, guildId: G, uid: U1, userId: MEMBER, type: "casual", status: "approved", startAt: new Date(), endAt: new Date(), approvedDays: "2026-11-20", reason: "Family", reviewedById: "dashboard:Anshika", reviewedAt: new Date(), updatedAt: new Date("2026-11-03T00:00:00Z"), ...o }; leaves.push(r); return r; };
const issueBody = { uid: U1, discordUserId: MEMBER, kind: "conduct", reason: "Repeated absence", issuedBy: "Sabitha" };
const grantBody = { uid: U1, discordUserId: MEMBER, type: "sick", days: ["2026-11-20"], reason: "Fever", by: "Sabitha" };

describe("warnings", () => {
  it("HA-S8 needs the API key", async () => {
    expect((await fetch(`${base}/w`)).status).toBe(401);
    expect((await fetch(`${base}/l`)).status).toBe(401);
  });
  it("HA-W1, HA-W13 lists issued warnings, not drafts or ladder mirrors", async () => {
    warn({ uid: "a", status: "proposed", externalUid: "a" });
    warn({ source: "ems", externalUid: "b" });
    warn({ externalUid: "c", source: "command" });
    warn({ externalUid: "d", source: "ems-hr", status: "revoked" });
    const rows = await (await get("/w")).json();
    expect(rows.map((r: Row) => r.uid)).toEqual(["c", "d"]);
  });
  it("HA-S1 pages strictly after (updatedAt, id)", async () => {
    const at = new Date("2026-11-03T00:00:00Z");
    const a = warn({ externalUid: "a", updatedAt: at });
    warn({ externalUid: "b", updatedAt: at });
    warn({ externalUid: "c", updatedAt: new Date("2026-11-04T00:00:00Z") });
    const rows = await (await get(`/w?updatedSince=${at.toISOString()}&afterId=${a.id}`)).json();
    expect(rows.map((r: Row) => r.uid)).toEqual(["b", "c"]);
    expect((await get("/w?updatedSince=nope")).status).toBe(400);
    expect((await get("/w?afterId=x")).status).toBe(400);
  });
  it("HA-W7 issues from EMS as ems-hr and DMs", async () => {
    const res = await post("/w", issueBody);
    expect(res.status).toBe(201);
    expect(warns[0]).toMatchObject({ source: "ems-hr", kind: "conduct", issuedBy: "Sabitha", externalUid: U1, status: "sent" });
    expect(sendWarning).toHaveBeenCalledTimes(1);
  });
  it("HA-W9 a repeated uid sends one DM; an unsent draft is sent", async () => {
    await post("/w", issueBody);
    expect((await post("/w", issueBody)).status).toBe(200);
    expect(sendWarning).toHaveBeenCalledTimes(1);
    warns = [];
    warn({ status: "proposed", source: "ems-hr" });
    expect((await post("/w", issueBody)).status).toBe(201);
    expect(warns).toHaveLength(1);
    expect(sendWarning).toHaveBeenCalledTimes(2);
  });
  it("answers 422 for an unknown member and 503 when the bot cannot send", async () => {
    expect((await post("/w", { ...issueBody, discordUserId: "310000000000000031" })).status).toBe(422);
    sendWarning.mockRejectedValueOnce(new WarningError("offline"));
    expect((await post("/w", issueBody)).status).toBe(503);
    expect((await post("/w", { ...issueBody, reason: "no" })).status).toBe(400);
  });
  it("HA-W10, HA-W11 withdraws, and repeating is success", async () => {
    warn({ source: "ems-hr" });
    const ok = await post(`/w/${U1}/withdraw`, { by: "Sabitha", reason: "Issued in error" });
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("revoked");
    expect((await post(`/w/${U1}/withdraw`, { by: "Sabitha", reason: "Issued in error" })).status).toBe(200);
    expect(revokeWarning).toHaveBeenCalledTimes(1);
  });
  it("HA-W12 refuses a ladder mirror and an unknown uid", async () => {
    warn({ source: "ems" });
    expect((await post(`/w/${U1}/withdraw`, { by: "Sabitha", reason: "Nope nope" })).status).toBe(409);
    expect((await post(`/w/${U2}/withdraw`, { by: "Sabitha", reason: "Nope nope" })).status).toBe(404);
    expect(revokeWarning).not.toHaveBeenCalled();
  });
});

describe("leaves", () => {
  it("HA-L1 lists decided leave with its origin, not pending", async () => {
    leave({ uid: "a", status: "pending" });
    leave({ uid: "b", reviewedById: "9000" });
    leave({ uid: "c", reviewedById: "dashboard:Anshika" });
    leave({ uid: "d", reviewedById: "dashboard:EMS: Sabitha" });
    const rows = await (await get("/l")).json();
    expect(rows.map((r: Row) => [r.uid, r.origin])).toEqual([["b", "discord"], ["c", "dashboard"], ["d", "ems"]]);
    expect(rows[0].days).toEqual(["2026-11-20"]);
  });
  it("HA-L6 grants through grantManualLeave, marked as from EMS", async () => {
    expect((await post("/l", grantBody)).status).toBe(201);
    expect(grantManualLeave).toHaveBeenCalledWith(G, MEMBER, expect.objectContaining({ approvedBy: "EMS: Sabitha", dates: ["2026-11-20"] }), { uid: U1 });
  });
  it("HA-L10 a repeated uid grants once", async () => {
    await post("/l", grantBody);
    expect((await post("/l", grantBody)).status).toBe(200);
    expect(grantManualLeave).toHaveBeenCalledTimes(1);
  });
  it("answers 422 when the bot refuses the dates", async () => {
    grantManualLeave.mockRejectedValueOnce(new LeaveInputError("Too far ahead"));
    expect((await post("/l", grantBody)).status).toBe(422);
  });
  it("HA-L8 revokes EMS and dashboard leave, and repeating is success", async () => {
    leave({ reviewedById: "dashboard:EMS: Sabitha" });
    const ok = await post(`/l/${U1}/revoke`);
    expect(ok.status).toBe(200);
    expect((await ok.json()).status).toBe("revoked");
    expect((await post(`/l/${U1}/revoke`)).status).toBe(200);
    expect(revokeManualLeave).toHaveBeenCalledTimes(1);
  });
  it("HA-L9 refuses to revoke a Discord approval", async () => {
    leave({ reviewedById: "900000000000000090" });
    expect((await post(`/l/${U1}/revoke`)).status).toBe(409);
    expect(revokeManualLeave).not.toHaveBeenCalled();
  });
});
