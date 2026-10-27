import { prisma } from "../core/db.js";

/**
 * The bot's own automatic warnings — the hours-warning sweep (warnings.ts, source
 * "auto"), its strict-mode termination, and the absence escalations (escalation.ts) —
 * are switched off for projects whose interns the EMS strictness ladder handles live
 * (Phase 4 §8). EMS sets the list with PUT /api/v1/settings/auto-warn. Manual /warn
 * and dashboard warnings are never affected.
 *
 * Stored in BotSetting "autoWarn" as JSON { disabledProjects: [projectKey…] | "all" }.
 */
export interface AutoWarnSetting {
  disabledProjects: string[] | "all";
}

const KEY = "autoWarn";
const CACHE_MS = 60_000;
let cache: { value: AutoWarnSetting; at: number } | null = null;

export function resetAutoWarnCacheForTests(): void {
  cache = null;
}

/** Pure. Anything missing or malformed means "nothing disabled". */
export function parseAutoWarn(raw: string | null | undefined): AutoWarnSetting {
  if (!raw) return { disabledProjects: [] };
  try {
    const v = JSON.parse(raw) as { disabledProjects?: unknown };
    if (v.disabledProjects === "all") return { disabledProjects: "all" };
    if (Array.isArray(v.disabledProjects)) {
      return { disabledProjects: [...new Set(v.disabledProjects.filter((k): k is string => typeof k === "string" && k.length > 0))] };
    }
  } catch {
    /* fall through */
  }
  return { disabledProjects: [] };
}

/**
 * Pure. True when the bot must not auto-warn / escalate a member of `project`
 * (Member.project holds the project key or name). "all" covers every member.
 */
export function autoWarnOff(setting: AutoWarnSetting, project: string | null, projects: { key: string; name: string }[]): boolean {
  if (setting.disabledProjects === "all") return true;
  if (!project) return false;
  const key = projects.find((p) => p.key === project || p.name === project)?.key ?? null;
  return key !== null && setting.disabledProjects.includes(key);
}

/** Current setting, cached for a minute (the sweep runs every 30 min, escalations after each meeting). */
export async function getAutoWarn(now = Date.now()): Promise<AutoWarnSetting> {
  if (cache && now - cache.at < CACHE_MS) return cache.value;
  const row = await prisma.botSetting.findUnique({ where: { key: KEY } });
  const value = parseAutoWarn(row?.value);
  cache = { value, at: now };
  return value;
}

export async function setAutoWarn(value: AutoWarnSetting, now = Date.now()): Promise<AutoWarnSetting> {
  const clean = parseAutoWarn(JSON.stringify(value));
  const json = JSON.stringify(clean);
  await prisma.botSetting.upsert({ where: { key: KEY }, create: { key: KEY, value: json }, update: { value: json } });
  cache = { value: clean, at: now };
  return clean;
}
