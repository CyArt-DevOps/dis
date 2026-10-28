import { describe, it, expect, vi } from "vitest";

const enqueue = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: { member: { findUnique: vi.fn(async () => null), upsert: vi.fn(async () => ({})) } },
}));
vi.mock("../src/services/emsOutbox.js", () => ({ enqueueEvent: (...a: unknown[]) => enqueue(...a) }));
vi.mock("../src/lib/log.js", () => ({ logEmbed: vi.fn(), postLog: vi.fn(async () => {}) }));
vi.mock("../src/config/loader.js", async (orig) => {
  const real = await orig<typeof import("../src/config/loader.js")>();
  const alpha = { key: "alpha", name: "Alpha", modules: 1, podsPerModule: 1, active: true };
  return {
    ...real,
    findProject: (key: string) => (key.toLowerCase() === "alpha" ? alpha : undefined),
    activeProjects: () => [alpha],
    org: { ...real.org, projects: [alpha] },
  };
});

const { assignRoles } = await import("../src/services/onboarding.js");

function fakeMember() {
  const none = { filter: () => new Map(), has: () => false, find: () => undefined };
  return {
    id: "m1",
    displayName: "Ravi",
    user: { tag: "ravi" },
    guild: { id: "g1", roles: { cache: none } },
    roles: { cache: none, add: vi.fn(), remove: vi.fn() },
    setNickname: vi.fn(async () => {}),
  };
}

describe("assignRoles → member.assigned event", () => {
  it("sends the project's stored (lowercase) key even when the assignment carries an older mixed-case key", async () => {
    await assignRoles(fakeMember() as never, { batch: "B1", projectKey: "Alpha", moduleNum: null, podNum: null } as never);
    const call = enqueue.mock.calls.find((c) => c[0] === "member.assigned");
    expect(call?.[1]).toMatchObject({ id: "m1", project: "alpha" });
  });
});
