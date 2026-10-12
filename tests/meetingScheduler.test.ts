import { describe, it, expect } from "vitest";
import { audienceLabel, resolveAudienceRole } from "../src/services/meetingScheduler.js";
import type { Guild } from "discord.js";

describe("people audience", () => {
  it("labels a people meeting with its member count", () => {
    const m = { audienceType: "people", audienceMemberIds: "1,2,3", audienceProject: null } as any;
    expect(audienceLabel(m)).toBe("Specific people (3)");
  });

  it("labels a people meeting with zero parsed members as (0)", () => {
    const m = { audienceType: "people", audienceMemberIds: null, audienceProject: null } as any;
    expect(audienceLabel(m)).toBe("Specific people (0)");
  });

  it("resolveAudienceRole returns undefined for people audience without touching the guild", () => {
    const m = { audienceType: "people" } as any;
    expect(resolveAudienceRole({} as Guild, m)).toBeUndefined();
  });
});
