import { describe, it, expect } from "vitest";
import { channelNames, moduleLabel, moduleShort, roleNames } from "../src/lib/names.js";
import type { ProjectDef } from "../src/config/loader.js";

const plain: ProjectDef = {
  key: "proj",
  name: "Proj",
  modules: 4,
  podsPerModule: 4,
  active: true,
};

const named: ProjectDef = {
  ...plain,
  key: "cybreach",
  name: "CyBreach",
  modules: 5,
  moduleNames: { "5": "Team Velocity" },
};

describe("module naming", () => {
  it("defaults to Module N / MN without overrides", () => {
    expect(moduleLabel(plain, 3)).toBe("Module 3");
    expect(moduleShort(plain, 3)).toBe("M3");
  });

  it("uses the custom name for an overridden module only", () => {
    expect(moduleLabel(named, 5)).toBe("Team Velocity");
    expect(moduleShort(named, 5)).toBe("Team Velocity");
    // Non-overridden modules keep default naming (existing roles/categories must not shift)
    expect(moduleLabel(named, 4)).toBe("Module 4");
    expect(moduleShort(named, 4)).toBe("M4");
  });

  it("builds role names from the label", () => {
    expect(roleNames.module(named, 5)).toBe("CyBreach Team Velocity");
    expect(roleNames.module(named, 1)).toBe("CyBreach Module 1");
    expect(roleNames.pod(named, 5, 2)).toBe("CyBreach Team Velocity Pod 2");
    expect(roleNames.pod(named, 1, 2)).toBe("CyBreach Module 1 Pod 2");
  });
});

describe("voice activity channel name", () => {
  it("is one per project, keyed by the stable project key", () => {
    expect(channelNames.voiceActivity("darktrace")).toBe("darktrace-voice-activity");
    expect(channelNames.voiceActivity("chain-discovery")).toBe("chain-discovery-voice-activity");
  });
});
