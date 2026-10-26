import { ChannelType, EmbedBuilder, PermissionFlagsBits, type Client, type Guild, type TextChannel } from "discord.js";
import { org, activeProjects, type ProjectDef } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { readState, updateState } from "../core/state.js";
import { tzDateKey, tzDayStartUtc } from "../lib/time.js";
import { placeNames } from "../lib/names.js";
import { buildCalendars, type MemberCalendar } from "./calendar.js";
import { holidayMap, isWorkingDay } from "./holidays.js";

/**
 * Daily voice-hours list, posted once each working day at 17:50 (org time).
 *
 * Each member is listed in the most specific group they belong to: their pod
 * chat if they have a pod, otherwise their module chat, otherwise the
 * project's #general. One message per channel, sorted by time served, with a
 * clear marker for met / late / short / absent / on leave. Replaces the
 * per-session posts: one predictable post a day instead of a message every
 * time someone leaves voice.
 */

const STATE_KEY = "lastHoursDigest";
// Don't post a stale list if the bot was down at 17:50 and comes back much later.
const LATE_LIMIT_MIN = 40;

function cfg() {
  return org.hoursDigest;
}

function hm(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

function textChannel(guild: Guild, name: string, parentName?: string): TextChannel | undefined {
  const parent = parentName
    ? guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === parentName)
    : undefined;
  const ch = guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildText && c.name === name && (!parent || c.parentId === parent.id)
  ) as TextChannel | undefined;
  const me = guild.members.me;
  if (!ch || (me && !ch.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages]))) return undefined;
  return ch;
}

/** Where a member's line goes: pod chat, else module chat, else project #general. */
function targetFor(guild: Guild, p: ProjectDef, m: MemberCalendar): { channel: TextChannel; label: string } | null {
  if (m.module && m.pod) {
    const ch = textChannel(guild, `${p.key}-m${m.module}-p${m.pod}-chat`);
    if (ch) return { channel: ch, label: `${p.name} · Module ${m.module} · Pod ${m.pod}` };
  }
  if (m.module) {
    const ch = textChannel(guild, `${p.key}-m${m.module}-chat`) ?? textChannel(guild, `${p.key}-m${m.module}-info`);
    if (ch) return { channel: ch, label: `${p.name} · Module ${m.module}` };
  }
  const general = textChannel(guild, "general", placeNames.projectCategory(p));
  return general ? { channel: general, label: p.name } : null;
}

function line(m: MemberCalendar, required: number, loginByMin: number, day: string): { order: number; text: string } {
  const d = m.days[0]!;
  if (d.status === "leave") return { order: 4, text: `🟧 **${m.fullName}** · on leave` };
  if (d.status === "missing" || (!d.firstJoinAt && d.seconds === 0)) return { order: 5, text: `❌ **${m.fullName}** · 0h 00m (not joined)` };
  const joinMin = d.firstJoinAt ? Math.round((d.firstJoinAt.getTime() - tzDayStartUtc(day).getTime()) / 60_000) : null;
  const late = joinMin !== null && joinMin > loginByMin ? joinMin - loginByMin : 0;
  const met = d.seconds >= required;
  const icon = met && !late ? "✅" : met ? "⚠️" : "⏳";
  const extra = [
    late ? `late by ${late} min` : null,
    met ? null : `${hm(required - d.seconds)} short`,
  ].filter(Boolean);
  return {
    order: met && !late ? 1 : met ? 2 : 3,
    text: `${icon} **${m.fullName}** · ${hm(d.seconds)}${extra.length ? ` (${extra.join(", ")})` : ""}`,
  };
}

export async function postHoursDigest(guild: Guild, day = tzDateKey(new Date())): Promise<number> {
  const holidays = await holidayMap(guild.id);
  if (!isWorkingDay(day, holidays)) return 0;
  const p = org.attendancePolicy;
  const required = Math.round(p.minHours * 3600);
  const loginByMin = minutesOf(p.loginBy);
  const calendars = await buildCalendars(guild.id, {}, day, day);
  const byProject = new Map<string, MemberCalendar[]>();
  for (const c of calendars) if (c.project) byProject.set(c.project, [...(byProject.get(c.project) ?? []), c]);

  let posted = 0;
  const dateLabel = new Date(day + "T00:00:00Z").toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", timeZone: "UTC" });
  for (const proj of activeProjects()) {
    const members = byProject.get(proj.name) ?? [];
    if (!members.length) continue;
    // Group members by their target channel.
    const groups = new Map<string, { channel: TextChannel; label: string; rows: { order: number; text: string; secs: number }[] }>();
    for (const m of members) {
      const t = targetFor(guild, proj, m);
      if (!t) continue;
      const g = groups.get(t.channel.id) ?? { ...t, rows: [] };
      g.rows.push({ ...line(m, required, loginByMin, day), secs: m.days[0]?.seconds ?? 0 });
      groups.set(t.channel.id, g);
    }
    for (const g of groups.values()) {
      g.rows.sort((a, b) => a.order - b.order || b.secs - a.secs);
      const met = g.rows.filter((r) => r.order <= 2).length;
      const absent = g.rows.filter((r) => r.order === 5).length;
      // Discord embeds hold 4096 characters; split long groups across embeds.
      const chunks: string[] = [];
      let cur = "";
      for (const r of g.rows) {
        if ((cur + r.text + "\n").length > 3800) {
          chunks.push(cur);
          cur = "";
        }
        cur += r.text + "\n";
      }
      if (cur) chunks.push(cur);
      const embeds = chunks.slice(0, 10).map((text, i) =>
        new EmbedBuilder()
          .setColor(0x5865f2)
          .setTitle(i === 0 ? `Voice hours today · ${g.label}` : `${g.label} (continued)`)
          .setDescription(text)
          .setFooter(
            i === chunks.length - 1
              ? { text: `${dateLabel} · ${met} of ${g.rows.length} met the ${p.minHours}h target · ${absent} not joined · join by ${p.loginBy}. Type /hours to check yours privately.` }
              : null
          )
      );
      await g.channel
        .send({ embeds })
        .then(() => {
          posted++;
        })
        .catch((err) => logger.warn({ err, channel: g.channel.name }, "Hours digest post failed"));
    }
  }
  logger.info({ day, posted }, "Daily hours digest posted");
  return posted;
}

let timer: NodeJS.Timeout | null = null;

export function startHoursDigest(client: Client): void {
  if (timer) clearInterval(timer);
  const tick = async () => {
    if (!cfg().enabled) return;
    const now = new Date();
    const day = tzDateKey(now);
    const minutesNow = Math.round((now.getTime() - tzDayStartUtc(day).getTime()) / 60_000);
    const at = minutesOf(cfg().time);
    if (minutesNow < at || minutesNow > at + LATE_LIMIT_MIN) return;
    if (readState()[STATE_KEY] === day) return;
    updateState(STATE_KEY, day); // mark first so two ticks can't double-post
    for (const g of client.guilds.cache.values()) {
      await postHoursDigest(g, day).catch((err) => logger.error({ err, guild: g.id }, "Hours digest failed"));
    }
  };
  timer = setInterval(() => void tick(), 60_000);
  logger.info({ time: cfg().time }, "Daily hours digest scheduled");
}

export function stopHoursDigest(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

