import { describe, it, expect } from "vitest";
import { signRequest, verifyRequest } from "../src/lib/signing.js";

const VECTOR = "6a63ce58f89293febc88dc44921d8eb00278d65bca03fe1ef92c45ee0cee2e51";

describe("signRequest", () => {
  it("matches the shared EMS test vector", () => {
    expect(signRequest("test-secret", "1700000000000", "POST", "/api/integrations/dis/events", '{"a":1}')).toBe(VECTOR);
  });
});

describe("verifyRequest", () => {
  const now = 1700000000000;
  const base = { secret: "test-secret", method: "POST", path: "/api/integrations/dis/events", body: '{"a":1}' };
  it("accepts a fresh, correct signature", () => {
    expect(verifyRequest({ ...base, timestamp: String(now), signature: VECTOR, now })).toBe(true);
  });
  it("rejects a tampered body", () => {
    expect(verifyRequest({ ...base, body: '{"a":2}', timestamp: String(now), signature: VECTOR, now })).toBe(false);
  });
  it("rejects timestamps more than 5 minutes off", () => {
    expect(verifyRequest({ ...base, timestamp: String(now), signature: VECTOR, now: now + 5 * 60_000 + 1 })).toBe(false);
  });
  it("rejects missing or malformed signatures without throwing", () => {
    expect(verifyRequest({ ...base, timestamp: String(now), signature: "", now })).toBe(false);
    expect(verifyRequest({ ...base, timestamp: "abc", signature: VECTOR, now })).toBe(false);
  });
});
