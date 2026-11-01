import { prisma } from "../core/db.js";
import { normProject, projectKeyOf } from "./integrationPayloads.js";
const KEY = "autoWarn";
const CACHE_MS = 60_000;
let cache = null;
export function resetAutoWarnCacheForTests() {
    cache = null;
}
/** Pure. Anything missing or malformed means "nothing disabled". */
export function parseAutoWarn(raw) {
    if (!raw)
        return { disabledProjects: [] };
    try {
        const v = JSON.parse(raw);
        if (v.disabledProjects === "all")
            return { disabledProjects: "all" };
        if (Array.isArray(v.disabledProjects)) {
            return { disabledProjects: [...new Set(v.disabledProjects.filter((k) => typeof k === "string" && k.length > 0))] };
        }
    }
    catch {
        /* fall through */
    }
    return { disabledProjects: [] };
}
/**
 * Pure. True when the bot must not auto-warn / escalate a member of `project`
 * (Member.project holds the project key or name; case and whitespace are ignored).
 * "all" covers every member.
 */
export function autoWarnOff(setting, project, projects) {
    if (setting.disabledProjects === "all")
        return true;
    if (!project)
        return false;
    const key = projectKeyOf(project, projects);
    if (key === null)
        return false;
    const k = normProject(key);
    return setting.disabledProjects.some((d) => normProject(d) === k);
}
/** Current setting, cached for a minute (the sweep runs every 30 min, escalations after each meeting). */
export async function getAutoWarn(now = Date.now()) {
    if (cache && now - cache.at < CACHE_MS)
        return cache.value;
    const row = await prisma.botSetting.findUnique({ where: { key: KEY } });
    const value = parseAutoWarn(row?.value);
    cache = { value, at: now };
    return value;
}
export async function setAutoWarn(value, now = Date.now()) {
    const clean = parseAutoWarn(JSON.stringify(value));
    const json = JSON.stringify(clean);
    await prisma.botSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: json }, update: { value: json } });
    cache = { value: clean, at: now };
    return clean;
}
//# sourceMappingURL=autoWarn.js.map