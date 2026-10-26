import { describe, it, expect, vi } from "vitest";
import { sanitizeIntegrationEnv } from "../src/config/envHelpers.js";

const LONG = "x".repeat(32);

describe("sanitizeIntegrationEnv", () => {
  it("keeps valid values", () => {
    const warn = vi.fn();
    const out = sanitizeIntegrationEnv({ DIS_API_KEY: LONG, INTEGRATION_SECRET: LONG, EMS_API_URL: "http://localhost:5000" }, warn);
    expect(out).toEqual({ DIS_API_KEY: LONG, INTEGRATION_SECRET: LONG, EMS_API_URL: "http://localhost:5000" });
    expect(warn).not.toHaveBeenCalled();
  });
  it("treats short secrets as unset and warns by name only", () => {
    const warn = vi.fn();
    const out = sanitizeIntegrationEnv({ DIS_API_KEY: "short-secret-value", INTEGRATION_SECRET: "y".repeat(31) }, warn);
    expect(out.DIS_API_KEY).toBeUndefined();
    expect(out.INTEGRATION_SECRET).toBeUndefined();
    const msgs = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(msgs).toContain("DIS_API_KEY");
    expect(msgs).toContain("INTEGRATION_SECRET");
    expect(msgs).not.toContain("short-secret-value");
  });
  it("treats an invalid EMS_API_URL as unset", () => {
    const warn = vi.fn();
    expect(sanitizeIntegrationEnv({ EMS_API_URL: "not a url" }, warn).EMS_API_URL).toBeUndefined();
    expect(warn).toHaveBeenCalledOnce();
    expect(String(warn.mock.calls[0]![0])).not.toContain("not a url");
  });
  it("stays silent for unset or empty values", () => {
    const warn = vi.fn();
    const out = sanitizeIntegrationEnv({ DIS_API_KEY: "", EMS_API_URL: undefined }, warn);
    expect(out.DIS_API_KEY).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });
});
