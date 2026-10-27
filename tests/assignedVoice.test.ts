import { describe, it, expect } from "vitest";
import type { ProjectDef } from "../src/config/loader.js";
import { assignedChannelIds, indexChannels, meetingVoiceChannelId, voiceDay, type ChannelLite } from "../src/services/assignedVoice.js";

const alpha: ProjectDef = { key: "alpha", name: "Alpha", modules: 2, podsPerModule: 2, active: true };
const PROJECTS = [alpha];
const cat = (id: string, name: string): ChannelLite => ({ id, name, kind: "category", parentId: null });
const vc = (id: string, name: string, parentId: string | null): ChannelLite => ({ id, name, kind: "voice", parentId });
const GUILD: ChannelLite[] = [
  cat("c-p", "ALPHA"), vc("v-gen", "Alpha General VC", "c-p"), vc("v-lead", "Alpha Leadership VC", "c-p"),
  cat("c-m1", "Alpha M1"), vc("v-m1", "Alpha M1 VC", "c-m1"), vc("v-m1p1", "Alpha M1 P1 VC", "c-m1"), vc("v-m1p2", "Alpha M1 P2 VC", "c-m1"),
  cat("c-m2", "Alpha M2"), vc("v-m2", "Alpha M2 VC", "c-m2"),
  cat("c-x", "ARCHIVE"), vc("v-fake", "Alpha M1 P1 VC", "c-x"), // same name, wrong category
  { id: "t-gen", name: "general", kind: "other", parentId: "c-p" },
];
const idx = indexChannels(GUILD);
const ids = (s: Set<string>) => [...s].sort();

describe("assignedChannelIds", () => {
  it("pod member: project General VC + module VC + own pod VC, matched under the right category", () => {
    expect(ids(assignedChannelIds(idx, PROJECTS, { project: "Alpha", module: 1, pod: 1, leadOf: [] }))).toEqual(["v-gen", "v-m1", "v-m1p1"]);
  });
  it("accepts the project key as well as the display name", () => {
    expect(ids(assignedChannelIds(idx, PROJECTS, { project: "alpha", module: 2, pod: null, leadOf: [] }))).toEqual(["v-gen", "v-m2"]);
  });
  it("adds the Leadership VC only for leads of that project", () => {
    expect(ids(assignedChannelIds(idx, PROJECTS, { project: "Alpha", module: null, pod: null, leadOf: ["alpha"] }))).toEqual(["v-gen", "v-lead"]);
    expect(ids(assignedChannelIds(idx, PROJECTS, { project: "Alpha", module: null, pod: null, leadOf: ["beta"] }))).toEqual(["v-gen"]);
  });
  it("an unknown project gives nothing; out-of-range module/pod add nothing", () => {
    expect(assignedChannelIds(idx, PROJECTS, { project: "Gone", module: 1, pod: 1, leadOf: [] }).size).toBe(0);
    expect(ids(assignedChannelIds(idx, PROJECTS, { project: "Alpha", module: 9, pod: 1, leadOf: [] }))).toEqual(["v-gen"]);
    expect(ids(assignedChannelIds(idx, PROJECTS, { project: "Alpha", module: 1, pod: 7, leadOf: [] }))).toEqual(["v-gen", "v-m1"]);
  });
});

// IST day 2026-10-27 = [2026-10-26T18:30Z, 2026-10-27T18:30Z)
const D27 = { start: new Date("2026-10-26T18:30:00Z"), end: new Date("2026-10-27T18:30:00Z") };
const D26 = { start: new Date("2026-10-25T18:30:00Z"), end: new Date("2026-10-26T18:30:00Z") };
const s = (channelId: string, from: string, to: string | null) => ({ channelId, joinedAt: new Date(from), leftAt: to ? new Date(to) : null });
const ASSIGNED = new Set(["v-m1p1", "v-m1"]);
const LATE = new Date("2026-10-28T00:00:00Z");

describe("voiceDay", () => {
  it("splits a session across IST midnight between the two days", () => {
    const sess = [s("v-m1p1", "2026-10-26T17:30:00Z", "2026-10-26T19:30:00Z")];
    expect(voiceDay(sess, D26.start, D26.end, LATE, ASSIGNED)).toEqual({ secondsAssigned: 3600, firstJoinAt: new Date("2026-10-26T17:30:00Z") });
    expect(voiceDay(sess, D27.start, D27.end, LATE, ASSIGNED)).toEqual({ secondsAssigned: 3600, firstJoinAt: new Date("2026-10-26T18:30:00Z") });
  });
  it("channel moves: only time in assigned channels counts; first join is in any channel", () => {
    const sess = [
      s("v-other", "2026-10-27T04:00:00Z", "2026-10-27T04:30:00Z"),
      s("v-m1p1", "2026-10-27T04:30:00Z", "2026-10-27T06:00:00Z"),
      s("v-gen-not-assigned", "2026-10-27T06:00:00Z", "2026-10-27T06:30:00Z"),
      s("v-m1", "2026-10-27T06:30:00Z", "2026-10-27T07:00:00Z"),
    ];
    expect(voiceDay(sess, D27.start, D27.end, LATE, ASSIGNED)).toEqual({ secondsAssigned: 5400 + 1800, firstJoinAt: new Date("2026-10-27T04:00:00Z") });
  });
  it("an open session counts up to now", () => {
    const now = new Date("2026-10-27T06:00:00Z");
    expect(voiceDay([s("v-m1p1", "2026-10-27T05:00:00Z", null)], D27.start, D27.end, now, ASSIGNED).secondsAssigned).toBe(3600);
  });
  it("unknown assignment → null seconds, first join still known; no sessions → 0 and null", () => {
    expect(voiceDay([s("v-m1p1", "2026-10-27T05:00:00Z", "2026-10-27T06:00:00Z")], D27.start, D27.end, LATE, null))
      .toEqual({ secondsAssigned: null, firstJoinAt: new Date("2026-10-27T05:00:00Z") });
    expect(voiceDay([], D27.start, D27.end, LATE, ASSIGNED)).toEqual({ secondsAssigned: 0, firstJoinAt: null });
  });
});

describe("meetingVoiceChannelId (EMS-made meetings, Phase 3)", () => {
  const a = (audienceType: string, audienceModule: number | null = null, audiencePod: number | null = null) =>
    ({ audienceType, audienceProject: "alpha", audienceModule, audiencePod });
  it("project → General VC, module → module VC, pod → pod VC (right category only)", () => {
    expect(meetingVoiceChannelId(idx, PROJECTS, a("project"))).toBe("v-gen");
    expect(meetingVoiceChannelId(idx, PROJECTS, a("module", 1))).toBe("v-m1");
    expect(meetingVoiceChannelId(idx, PROJECTS, a("pod", 1, 1))).toBe("v-m1p1");
  });
  it("null for a missing channel, an unknown project or a non-project audience", () => {
    expect(meetingVoiceChannelId(idx, PROJECTS, a("pod", 2, 1))).toBeNull();
    expect(meetingVoiceChannelId(idx, PROJECTS, { ...a("project"), audienceProject: "nope" })).toBeNull();
    expect(meetingVoiceChannelId(idx, PROJECTS, a("org"))).toBeNull();
  });
});
