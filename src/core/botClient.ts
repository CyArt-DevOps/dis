import type { Client, Guild } from "discord.js";

/**
 * The live Discord client, when this process is the bot. The dashboard runs
 * inside the bot in production (startDashboard on ClientReady) and can then DM
 * or remove members; `npm run web` runs it standalone, where these actions are
 * unavailable and say so instead of failing halfway.
 */
let client: Client | null = null;

export function setBotClient(c: Client): void {
  client = c;
}

export function botClient(): Client | null {
  return client?.isReady() ? client : null;
}

export function botGuild(guildId: string): Guild | null {
  return botClient()?.guilds.cache.get(guildId) ?? null;
}
