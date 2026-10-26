import type { ProjectDef } from "../config/loader.js";
import { placeNames } from "../lib/names.js";
import { projectKeyOf } from "./integrationPayloads.js";

/**
 * Assigned voice channels and per-day voice time for the EMS sync (Phase 2 §8).
 * Pure: the router hands in the guild's channel list and VoiceSession rows.
 */
export interface ChannelLite {
  id: string;
  name: string;
  kind: "voice" | "category" | "other";
  parentId: string | null;
}
export interface ChannelIndex {
  categories: Map<string, string[]>; // category name → ids (duplicates tolerated)
  voice: Map<string, string[]>; // `${parentId}|${name}` → voice channel ids
}
export interface Placement {
  project: string | null; // Member.project (display name or key)
  module: number | null;
  pod: number | null;
  leadOf: string[]; // project keys where the member is Team Lead or Co-Lead
}
export interface SessionLite {
  channelId: string;
  joinedAt: Date;
  leftAt: Date | null;
}

type ProjectLike = Pick<ProjectDef, "key" | "name" | "modules" | "podsPerModule" | "active" | "moduleNames">;

function push(m: Map<string, string[]>, k: string, v: string): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/** Build once per request ("per sweep") from the live guild channel cache. */
export function indexChannels(channels: ChannelLite[]): ChannelIndex {
  const categories = new Map<string, string[]>();
  const voice = new Map<string, string[]>();
  for (const c of channels) {
    if (c.kind === "category") push(categories, c.name, c.id);
    else if (c.kind === "voice") push(voice, `${c.parentId ?? ""}|${c.name}`, c.id);
  }
  return { categories, voice };
}

function voiceUnder(idx: ChannelIndex, categoryName: string, vcName: string): string[] {
  return (idx.categories.get(categoryName) ?? []).flatMap((catId) => idx.voice.get(`${catId}|${vcName}`) ?? []);
}

/** Pod VC, module VC, project General VC, and the Leadership VC for leads (meeting VCs: Phase 3). */
export function assignedChannelIds(idx: ChannelIndex, projects: ProjectLike[], m: Placement): Set<string> {
  const out = new Set<string>();
  const key = projectKeyOf(m.project, projects);
  const p = projects.find((x) => x.key === key) as ProjectDef | undefined;
  if (!p) return out;
  const add = (ids: string[]) => ids.forEach((id) => out.add(id));
  const projectCat = placeNames.projectCategory(p);
  add(voiceUnder(idx, projectCat, placeNames.projectGeneralVc(p)));
  if (m.leadOf.includes(p.key)) add(voiceUnder(idx, projectCat, placeNames.leadershipVc(p)));
  if (m.module != null && m.module >= 1 && m.module <= p.modules) {
    const modCat = placeNames.moduleCategory(p, m.module);
    add(voiceUnder(idx, modCat, placeNames.moduleVc(p, m.module)));
    if (m.pod != null && m.pod >= 1 && m.pod <= p.podsPerModule) {
      add(voiceUnder(idx, modCat, placeNames.podVc(p, m.module, m.pod)));
    }
  }
  return out;
}

/**
 * One member's day: seconds in assigned channels (sessions clipped to the day
 * and to `now`), and the first moment they were in any voice channel that day.
 * `assigned` null = channels unknown (bot offline) → secondsAssigned null, never a guessed 0.
 */
export function voiceDay(
  sessions: SessionLite[],
  dayStart: Date,
  dayEnd: Date,
  now: Date,
  assigned: Set<string> | null
): { secondsAssigned: number | null; firstJoinAt: Date | null } {
  const from = dayStart.getTime();
  const to = Math.min(dayEnd.getTime(), now.getTime());
  let ms = 0;
  let first: number | null = null;
  for (const s of sessions) {
    const a = Math.max(s.joinedAt.getTime(), from);
    const b = Math.min((s.leftAt ?? now).getTime(), to);
    if (b <= a) continue;
    if (first === null || a < first) first = a;
    if (assigned?.has(s.channelId)) ms += b - a;
  }
  return { secondsAssigned: assigned ? Math.floor(ms / 1000) : null, firstJoinAt: first === null ? null : new Date(first) };
}
