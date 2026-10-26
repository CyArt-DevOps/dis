import { describe, it, expect, vi } from "vitest";
import { apiKeyGuard } from "../src/web/v1/apiKey.js";

function run(key: string | undefined, header: string | undefined) {
  const res = { statusCode: 200, body: undefined as unknown, status(c: number) { this.statusCode = c; return this; }, json(b: unknown) { this.body = b; return this; } };
  const next = vi.fn();
  apiKeyGuard(() => key)({ headers: header ? { authorization: header } : {} } as never, res as never, next);
  return { res, next };
}

describe("apiKeyGuard", () => {
  const KEY = "k".repeat(40);
  it("503s when the integration is not configured", () => {
    expect(run(undefined, `Bearer ${KEY}`).res.statusCode).toBe(503);
  });
  it("401s with a missing or wrong key", () => {
    expect(run(KEY, undefined).res.statusCode).toBe(401);
    expect(run(KEY, "Bearer nope").res.statusCode).toBe(401);
  });
  it("passes the right key through", () => {
    const { next, res } = run(KEY, `Bearer ${KEY}`);
    expect(next).toHaveBeenCalledOnce();
    expect(res.statusCode).toBe(200);
  });
});
