import { describe, it, expect } from "vitest";
import { randomBytes } from "node:crypto";
import { Lockout, generatePassword, hashPassword, readToken, signToken, verifyPassword } from "../src/lib/hrAuth.js";

describe("password hashing", () => {
  it("verifies the right password and rejects others", () => {
    const h = hashPassword("Abcd-efgh-2345-mnpq");
    expect(h.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("Abcd-efgh-2345-mnpq", h)).toBe(true);
    expect(verifyPassword("abcd-efgh-2345-mnpq", h)).toBe(false);
    expect(verifyPassword("", h)).toBe(false);
  });

  it("salts every hash", () => {
    expect(hashPassword("same")).not.toBe(hashPassword("same"));
  });

  it("rejects malformed stored hashes", () => {
    expect(verifyPassword("x", "plaintext")).toBe(false);
  });

  it("generates readable 4x4 passwords", () => {
    expect(generatePassword()).toMatch(/^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/);
  });
});

describe("HR tokens", () => {
  const secret = randomBytes(32);
  it("round-trips valid claims", () => {
    const t = signToken({ id: 3, name: "Priya", exp: Date.now() + 60_000 }, secret);
    expect(readToken(t, secret)?.name).toBe("Priya");
  });
  it("rejects expired, tampered or foreign tokens", () => {
    expect(readToken(signToken({ id: 3, name: "P", exp: Date.now() - 1 }, secret), secret)).toBeNull();
    const t = signToken({ id: 3, name: "P", exp: Date.now() + 60_000 }, secret);
    const forged = Buffer.from(JSON.stringify({ id: 1, name: "Admin", exp: Date.now() + 60_000 })).toString("base64url");
    expect(readToken(`${forged}.${t.split(".")[1]}`, secret)).toBeNull();
    expect(readToken(t, randomBytes(32))).toBeNull();
    expect(readToken("garbage", secret)).toBeNull();
  });
});

describe("Lockout", () => {
  it("locks after max failures and unlocks after the window", () => {
    const l = new Lockout(3, 1000);
    l.fail("k", 0);
    l.fail("k", 10);
    expect(l.lockedFor("k", 20)).toBe(0);
    l.fail("k", 20);
    expect(l.lockedFor("k", 30)).toBeGreaterThan(0);
    expect(l.lockedFor("k", 1100)).toBe(0);
  });
});
