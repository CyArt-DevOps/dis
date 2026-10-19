import { ChannelType, type CategoryChannel, type Guild } from "discord.js";
import { org } from "../config/loader.js";
import { logger } from "../core/logger.js";

/**
 * Discord caps a category at 50 channels. Tickets, leave channels and private
 * meeting channels all live under TICKETS, so a busy HR queue fills it and
 * channel creation starts failing ("Maximum number of channels in category
 * reached"). Overflow goes to "TICKETS 2", "TICKETS 3", … created on demand
 * with the base category's permissions, so nothing ever fails for space.
 */

const LIMIT = 50;
// Keep one slot free so a race between two creations can't hit the hard cap.
const HEADROOM = 1;

function base(): string {
  return org.categories.tickets.name;
}

/** Overflow index for a category name: 1 for "TICKETS", n for "TICKETS n", else null. */
export function ticketsIndex(name: string): number | null {
  if (name === base()) return 1;
  const m = new RegExp(`^${base().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} (\\d+)$`).exec(name);
  return m ? Number(m[1]) : null;
}

export function isTicketsCategory(name: string): boolean {
  return ticketsIndex(name) !== null;
}

function ticketCategories(guild: Guild): CategoryChannel[] {
  return [...guild.channels.cache.values()]
    .filter((c): c is CategoryChannel => c.type === ChannelType.GuildCategory && isTicketsCategory(c.name))
    .sort((a, b) => ticketsIndex(a.name)! - ticketsIndex(b.name)!);
}

function childCount(guild: Guild, cat: CategoryChannel): number {
  return guild.channels.cache.filter((c) => c.parentId === cat.id).size;
}

/** The base TICKETS category (for permission templates and lookups). */
export function baseTicketsCategory(guild: Guild): CategoryChannel | undefined {
  return ticketCategories(guild).find((c) => c.name === base());
}

/**
 * A TICKETS category with room for `needed` more channels, creating the next
 * overflow category if all are full. Undefined only if the base is missing.
 */
export async function ticketsCategoryWithRoom(guild: Guild, needed = 1): Promise<CategoryChannel | undefined> {
  const cats = ticketCategories(guild);
  const root = cats.find((c) => c.name === base());
  if (!root) return undefined;
  const free = cats.find((c) => childCount(guild, c) + needed <= LIMIT - HEADROOM);
  if (free) return free;

  const next = Math.max(...cats.map((c) => ticketsIndex(c.name)!)) + 1;
  const last = cats[cats.length - 1]!;
  const created = await guild.channels.create({
    name: `${base()} ${next}`,
    type: ChannelType.GuildCategory,
    permissionOverwrites: root.permissionOverwrites.cache.map((o) => ({
      id: o.id,
      type: o.type,
      allow: o.allow.bitfield,
      deny: o.deny.bitfield,
    })),
    position: last.position + 1,
    reason: "TICKETS category full: overflow",
  });
  logger.info({ category: created.name }, "Created overflow tickets category");
  return created;
}

/** Remove empty overflow categories so the server doesn't accumulate them. */
export async function pruneEmptyOverflow(guild: Guild): Promise<void> {
  for (const c of ticketCategories(guild)) {
    if (c.name === base()) continue;
    if (childCount(guild, c) === 0) {
      await c.delete("Overflow tickets category empty").catch(() => {});
      logger.info({ category: c.name }, "Removed empty overflow tickets category");
    }
  }
}
