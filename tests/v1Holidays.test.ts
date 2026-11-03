import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from "vitest";
import express from "express";
import { readFile } from "node:fs/promises";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";

// HS-D1..D10: /api/v1/holidays against an in-memory Holiday table. botClient is never imported by these routes.
const KEY = "k".repeat(40);
vi.mock("../src/config/env.js", () => ({ env: { DIS_API_KEY: "k".repeat(40), DISCORD_GUILD_ID: "g1" } }));
vi.mock("../src/config/loader.js", () => ({ org: { attendancePolicy: { workdays: [1, 2, 3, 4, 5] } } }));
type Row = { id: number; guildId: string; day: string; name: string; addedBy: string | null };
let rows: Row[] = [];
let nextId = 1;
vi.mock("../src/core/db.js", () => ({
  prisma: {
    holiday: {
      findMany: vi.fn(async ({ where }: { where: { guildId: string; day?: { gte: string } } }) =>
        rows
          .filter((r) => r.guildId === where.guildId && (!where.day || r.day >= where.day.gte))
          .sort((a, b) => a.day.localeCompare(b.day))),
      findUnique: vi.fn(async ({ where }: { where: { guildId_day: { guildId: string; day: string } } }) =>
        rows.find((r) => r.guildId === where.guildId_day.guildId && r.day === where.guildId_day.day) ?? null),
      create: vi.fn(async ({ data }: { data: Omit<Row, "id"> }) => {
        const row = { id: nextId++, ...data };
        rows.push(row);
        return row;
      }),
      deleteMany: vi.fn(async ({ where }: { where: { guildId: string; day: string } }) => {
        const before = rows.length;
        rows = rows.filter((r) => !(r.guildId === where.guildId && r.day === where.day));
        return { count: before - rows.length };
      }),
    },
  },
}));

const { holidaysRouter } = await import("../src/web/v1/holidays.js");
const { apiKeyGuard } = await import("../src/web/v1/apiKey.js");
const { holidayMap, clearHolidayCache } = await import("../src/services/holidays.js");

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use("/api/v1/holidays", apiKeyGuard(() => KEY), holidaysRouter);
  await new Promise<void>((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/holidays`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));
beforeEach(() => {
  rows = [];
  nextId = 1;
  clearHolidayCache();
});

const auth = { Authorization: `Bearer ${KEY}` };
const post = (body: unknown) =>
  fetch(base, { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(body) });
const seed = (guildId: string, day: string, name: string) =>
  rows.push({ id: nextId++, guildId, day, name, addedBy: null });

describe("/api/v1/holidays", () => {
  it("HS-D1 refuses every route without the API key", async () => {
    expect((await fetch(`${base}?from=2026-11-01`)).status).toBe(401);
    expect((await fetch(base, { method: "POST" })).status).toBe(401);
    expect((await fetch(`${base}/2026-11-04`, { method: "DELETE" })).status).toBe(401);
  });

  it("HS-D2 lists rows on or after from, this guild only", async () => {
    seed("g1", "2026-11-03", "Before");
    seed("g1", "2026-11-04", "On");
    seed("g1", "2026-11-05", "After");
    seed("g2", "2026-11-06", "Other guild");
    const res = await fetch(`${base}?from=2026-11-04`, { headers: auth });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { day: "2026-11-04", name: "On" },
      { day: "2026-11-05", name: "After" },
    ]);
  });

  it("HS-D3 rejects a missing or impossible from", async () => {
    expect((await fetch(base, { headers: auth })).status).toBe(400);
    expect((await fetch(`${base}?from=2026-02-31`, { headers: auth })).status).toBe(400);
  });

  it("HS-D4 adds a new date as EMS sync and holidayMap shows it at once", async () => {
    await holidayMap("g1");
    const res = await post({ day: "2026-11-04", name: "Diwali Leave" });
    expect(res.status).toBe(201);
    expect(rows[0]).toMatchObject({ guildId: "g1", day: "2026-11-04", name: "Diwali Leave", addedBy: "EMS sync" });
    expect((await holidayMap("g1")).get("2026-11-04")).toBe("Diwali Leave");
  });

  it("HS-D5 keeps the existing name when the date already exists", async () => {
    seed("g1", "2026-11-04", "Original");
    const res = await post({ day: "2026-11-04", name: "New" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ day: "2026-11-04", name: "Original" });
    expect(rows).toHaveLength(1);
  });

  it("HS-D6 rejects a bad day or name", async () => {
    expect((await post({ day: "2026-02-31", name: "Nope" })).status).toBe(400);
    expect((await post({ day: "2026-11-04", name: "" })).status).toBe(400);
    expect(rows).toHaveLength(0);
  });

  it("accepts a one-character name, as EMS does", async () => {
    expect((await post({ day: "2026-11-04", name: "X" })).status).toBe(201);
  });

  it("HS-D7 removes a date and holidayMap drops it at once", async () => {
    seed("g1", "2026-11-04", "Diwali Leave");
    expect((await holidayMap("g1")).has("2026-11-04")).toBe(true);
    const res = await fetch(`${base}/2026-11-04`, { method: "DELETE", headers: auth });
    expect(res.status).toBe(204);
    expect((await holidayMap("g1")).has("2026-11-04")).toBe(false);
  });

  it("HS-D8 treats a missing date as already removed", async () => {
    expect((await fetch(`${base}/2026-11-04`, { method: "DELETE", headers: auth })).status).toBe(204);
  });

  it("HS-D9 leaves another guild's row alone", async () => {
    seed("g2", "2026-11-04", "Other guild");
    await fetch(`${base}/2026-11-04`, { method: "DELETE", headers: auth });
    expect(rows).toHaveLength(1);
  });

  it("HS-D10 does not depend on the Discord connection", async () => {
    const source = await readFile("src/web/v1/holidays.ts", "utf8");
    expect(source).not.toContain("botClient");
  });
});
