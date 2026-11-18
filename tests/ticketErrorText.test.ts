import { describe, it, expect, vi } from "vitest";

vi.mock("../src/core/db.js", () => ({ prisma: {} }));
vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const { errorText } = await import("../src/interactions/tickets.js");

describe("ticket errorText", () => {
  it("hides Prisma detail behind a busy message", () => {
    const err = new Error("\nInvalid `prisma.ticket.findUnique()` invocation:\n\nTimed out fetching a new connection");
    err.name = "PrismaClientKnownRequestError";
    expect(errorText(err)).toBe("the database is busy right now. Please try again in a minute.");
  });

  it("keeps our own short messages", () => {
    expect(errorText(new Error("Already closed."))).toBe("Already closed.");
  });

  it("handles non-Error throws", () => {
    expect(errorText("x")).toBe("unknown error. Please try again.");
  });
});
