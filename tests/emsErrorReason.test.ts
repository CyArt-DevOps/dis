import { describe, expect, it } from "vitest";
import { EmsHttpError, EmsNotJsonError, describeEmsError, looksLikeChallenge } from "../src/lib/emsErrors.js";

const CHALLENGE = "<html><title>Bot Verification</title><form id=\"lsrecaptcha-form\"></form></html>";

describe("describeEmsError", () => {
  it("names HTTP errors and flags a bot-check page", () => {
    expect(describeEmsError(new EmsHttpError(401, '{"message":"bad signature"}'))).toBe("http_401");
    expect(describeEmsError(new EmsHttpError(403, CHALLENGE))).toBe("http_403_challenge");
  });
  it("names a 200 that is not JSON", () => {
    expect(describeEmsError(new EmsNotJsonError(200, "text/html", true))).toBe("not_json_challenge");
    expect(describeEmsError(new EmsNotJsonError(200, "text/html", false))).toBe("not_json_200");
  });
  it("names timeouts and network failures", () => {
    const t = new Error("timed out");
    t.name = "TimeoutError";
    expect(describeEmsError(t)).toBe("timeout");
    expect(describeEmsError(new TypeError("fetch failed", { cause: { code: "ECONNRESET" } }))).toBe("network_ECONNRESET");
    expect(describeEmsError(new TypeError("fetch failed"))).toBe("network_fetch_failed");
    expect(describeEmsError(new Error("EMS integration is not configured"))).toBe("disabled");
  });
  it("never includes response text", () => {
    expect(describeEmsError(new EmsHttpError(500, '{"password":"leak"}'))).toBe("http_500");
  });
  it("spots challenge pages only", () => {
    expect(looksLikeChallenge(CHALLENGE)).toBe(true);
    expect(looksLikeChallenge('{"status":"credentials"}')).toBe(false);
  });
});
