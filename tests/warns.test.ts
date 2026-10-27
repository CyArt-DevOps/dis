import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn(async () => ({ count: 2 }));
const count = vi.fn(async () => 1);
vi.mock("../src/core/db.js", () => ({ prisma: { warn: { deleteMany, count } } }));

const { clearWarns } = await import("../src/services/warns.js");

beforeEach(() => {
  deleteMany.mockClear();
  count.mockClear();
});

describe("/warn clear", () => {
  it("deletes only the bot's own warns and reports how many EMS-mirrored ones were kept", async () => {
    expect(await clearWarns("g1", "u1")).toEqual({ cleared: 2, kept: 1 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { guildId: "g1", userId: "u1", NOT: { source: "ems" } } });
    expect(count).toHaveBeenCalledWith({ where: { guildId: "g1", userId: "u1", source: "ems" } });
  });
});
