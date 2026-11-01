import { placeNames } from "../lib/names.js";
import { projectKeyOf } from "./integrationPayloads.js";
function push(m, k, v) {
    const list = m.get(k);
    if (list)
        list.push(v);
    else
        m.set(k, [v]);
}
/** Build once per request ("per sweep") from the live guild channel cache. */
export function indexChannels(channels) {
    const categories = new Map();
    const voice = new Map();
    for (const c of channels) {
        if (c.kind === "category")
            push(categories, c.name, c.id);
        else if (c.kind === "voice")
            push(voice, `${c.parentId ?? ""}|${c.name}`, c.id);
    }
    return { categories, voice };
}
function voiceUnder(idx, categoryName, vcName) {
    return (idx.categories.get(categoryName) ?? []).flatMap((catId) => idx.voice.get(`${catId}|${vcName}`) ?? []);
}
/** Pod VC, module VC, project General VC, and the Leadership VC for leads (meeting VCs: Phase 3). */
export function assignedChannelIds(idx, projects, m) {
    const out = new Set();
    const key = projectKeyOf(m.project, projects);
    const p = projects.find((x) => x.key === key);
    if (!p)
        return out;
    const add = (ids) => ids.forEach((id) => out.add(id));
    const projectCat = placeNames.projectCategory(p);
    add(voiceUnder(idx, projectCat, placeNames.projectGeneralVc(p)));
    if (m.leadOf.includes(p.key))
        add(voiceUnder(idx, projectCat, placeNames.leadershipVc(p)));
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
 * Voice channel for a meeting EMS created (Phase 3 §3.3): the project General VC,
 * the module VC or the pod VC. Null when the audience is not a project one or the
 * channel does not exist (EMS then gets a 422).
 */
export function meetingVoiceChannelId(idx, projects, a) {
    // Keys are lowercased on load; EMS may still send a key it stored before that.
    const want = a.audienceProject?.trim().toLowerCase();
    const p = projects.find((x) => x.key === want);
    if (!p)
        return null;
    let ids = [];
    if (a.audienceType === "project")
        ids = voiceUnder(idx, placeNames.projectCategory(p), placeNames.projectGeneralVc(p));
    else if (a.audienceType === "module" && a.audienceModule) {
        ids = voiceUnder(idx, placeNames.moduleCategory(p, a.audienceModule), placeNames.moduleVc(p, a.audienceModule));
    }
    else if (a.audienceType === "pod" && a.audienceModule && a.audiencePod) {
        ids = voiceUnder(idx, placeNames.moduleCategory(p, a.audienceModule), placeNames.podVc(p, a.audienceModule, a.audiencePod));
    }
    return ids[0] ?? null;
}
/**
 * One member's day: seconds in assigned channels (sessions clipped to the day
 * and to `now`), and the first moment they were in any voice channel that day.
 * `assigned` null = channels unknown (bot offline) → secondsAssigned null, never a guessed 0.
 * firstJoinAt is clipped to the IST day start: a session spanning midnight reports
 * the day's 00:00 (not its real earlier join) as that day's first join.
 */
export function voiceDay(sessions, dayStart, dayEnd, now, assigned) {
    const from = dayStart.getTime();
    const to = Math.min(dayEnd.getTime(), now.getTime());
    let ms = 0;
    let first = null;
    for (const s of sessions) {
        const a = Math.max(s.joinedAt.getTime(), from);
        const b = Math.min((s.leftAt ?? now).getTime(), to);
        if (b <= a)
            continue;
        if (first === null || a < first)
            first = a;
        if (assigned?.has(s.channelId))
            ms += b - a;
    }
    return { secondsAssigned: assigned ? Math.floor(ms / 1000) : null, firstJoinAt: first === null ? null : new Date(first) };
}
//# sourceMappingURL=assignedVoice.js.map