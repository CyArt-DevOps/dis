import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteMany = vi.fn(async () => ({ count: 2 }));
const updateMany = vi.fn(async () => ({ count: 3 }));
const count = vi.fn(async () => 1);
vi.mock("../src/core/db.js", () => ({ prisma: { warn: { deleteMany, updateMany, count } } }));

const { clearWarns } = await import("../src/services/warns.js");

beforeEach(() => {
  deleteMany.mockClear();
  count.mockClear();
});

describe("/warn clear", () => {
  it("deletes drafts, marks issued warns revoked so EMS sees it, and keeps EMS-mirrored ones", async () => {
    expect(await clearWarns("g1", "u1")).toEqual({ cleared: 5, kept: 1 });
    expect(deleteMany).toHaveBeenCalledWith({ where: { guildId: "g1", userId: "u1", NOT: { source: "ems" }, status: "proposed" } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { guildId: "g1", userId: "u1", NOT: { source: "ems" }, status: { notIn: ["revoked", "dismissed"] } },
      data: { status: "revoked", reviewedBy: "clearwarns" },
    });
    expect(count).toHaveBeenCalledWith({ where: { guildId: "g1", userId: "u1", source: "ems", status: { notIn: ["revoked", "dismissed"] } } });
  });
});
