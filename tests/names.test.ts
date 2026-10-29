import { describe, it, expect } from "vitest";
import { moduleLabel, moduleShort, roleNames, placeNames, podRepRoleNames } from "../src/lib/names.js";
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

describe("roleNames.podRep (Phase 6)", () => {
  it("uses the short module form, like the pod VC (PR-BOT-09)", () => {
    expect(roleNames.podRep(named, 1, 2)).toBe("CyBreach M1 P2 Representative");
    expect(roleNames.podRep(named, 5, 3)).toBe("CyBreach Team Velocity P3 Representative");
  });
  it("lists one rep role per pod and none for a project without modules (PR-BOT-09/10)", () => {
    const twoByTwo: ProjectDef = { ...plain, key: "dt", name: "DarkTrace", modules: 2, podsPerModule: 2 };
    const noModules: ProjectDef = { ...plain, key: "ai", name: "AI SIEM", modules: 0, podsPerModule: 0 };
    expect(podRepRoleNames(twoByTwo)).toEqual([
      "DarkTrace M1 P1 Representative", "DarkTrace M1 P2 Representative",
      "DarkTrace M2 P1 Representative", "DarkTrace M2 P2 Representative",
    ]);
    expect(podRepRoleNames(noModules)).toEqual([]);
  });
});

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


describe("placeNames (what bootstrap creates)", () => {
  it("names the project/module categories and every VC kind", () => {
    expect(placeNames.projectCategory(named)).toBe("CYBREACH");
    expect(placeNames.moduleCategory(named, 2)).toBe("CyBreach M2");
    expect(placeNames.moduleCategory(named, 5)).toBe("CyBreach Team Velocity");
    expect(placeNames.projectGeneralVc(named)).toBe("CyBreach General VC");
    expect(placeNames.leadershipVc(named)).toBe("CyBreach Leadership VC");
    expect(placeNames.moduleVc(named, 2)).toBe("CyBreach M2 VC");
    expect(placeNames.podVc(named, 2, 3)).toBe("CyBreach M2 P3 VC");
    expect(placeNames.podVc(named, 5, 1)).toBe("CyBreach Team Velocity P1 VC");
  });

  it("allCategories lists project + module categories, respecting moduleNames", () => {
    expect(placeNames.allCategories(named)).toEqual([
      "CYBREACH", "CyBreach M1", "CyBreach M2", "CyBreach M3", "CyBreach M4", "CyBreach Team Velocity",
    ]);
    expect(placeNames.allCategories(plain)).toEqual(["PROJ", "Proj M1", "Proj M2", "Proj M3", "Proj M4"]);
  });
});
