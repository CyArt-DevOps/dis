import { describe, it, expect } from "vitest";
import { panelNeedsEdit } from "../src/lib/panelRefresh.js";

// A posted panel keeps its message (so pinned links survive) but its text must follow the
// current build: e.g. the #leave-request panel gaining the Half day line (EMS spec 2026-11-07 §7).
const want = { title: "Leave Requests", description: "Casual...\n**Half day**: one date..." };

describe("panelNeedsEdit", () => {
  it("edits a panel with no embed or a suppressed embed (old repair rule)", () => {
    expect(panelNeedsEdit([], false, want)).toBe(true);
    expect(panelNeedsEdit([want], true, want)).toBe(true);
  });

  it("edits a panel whose description is out of date", () => {
    expect(panelNeedsEdit([{ title: "Leave Requests", description: "Casual..." }], false, want)).toBe(true);
  });

  it("edits a panel whose title changed", () => {
    expect(panelNeedsEdit([{ title: "Leave", description: want.description }], false, want)).toBe(true);
  });

  it("leaves an up-to-date panel alone", () => {
    expect(panelNeedsEdit([{ title: want.title, description: want.description }], false, want)).toBe(false);
  });

  it("treats missing title/description as empty strings", () => {
    expect(panelNeedsEdit([{ title: null, description: null }], false, { title: null, description: null })).toBe(false);
  });
});
