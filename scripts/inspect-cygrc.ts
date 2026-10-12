/** Read-only: list every channel in CyGRC categories with its overwrites. */
import { ChannelType, Events } from "discord.js";
import { env } from "../src/config/env.js";
import { createClient } from "../src/core/client.js";
import { logger } from "../src/core/logger.js";

async function main() {
  const client = createClient();
  client.once(Events.ClientReady, async (c) => {
    const guild = await (await c.guilds.fetch(env.DISCORD_GUILD_ID)).fetch();
    await guild.channels.fetch();
    await guild.roles.fetch();

    const roleName = (id: string) =>
      id === guild.roles.everyone.id
        ? "@everyone"
        : guild.roles.cache.get(id)?.name ?? `<${id}>`;

    const cats = guild.channels.cache.filter(
      (ch) =>
        ch.type === ChannelType.GuildCategory &&
        (ch.name === "CYGRC" || ch.name.startsWith("CyGRC"))
    );

    for (const cat of cats.values()) {
      console.log(`\n=== CATEGORY: ${cat.name} (${cat.id}) ===`);
      const children = guild.channels.cache
        .filter((ch) => ch.parentId === cat.id)
        .sort((a, b) => a.name.localeCompare(b.name));
      for (const ch of children.values()) {
        const kind = ch.type === ChannelType.GuildVoice ? "VC" : "TXT";
        console.log(`  [${kind}] ${ch.name} (${ch.id})`);
        if ("permissionOverwrites" in ch) {
          for (const ow of ch.permissionOverwrites.cache.values()) {
            const allow = ow.allow.toArray().join(",") || "-";
            const deny = ow.deny.toArray().join(",") || "-";
            console.log(`        ${roleName(ow.id)}: allow=[${allow}] deny=[${deny}]`);
          }
        }
      }
    }

    // Also list any channel anywhere whose name starts with grc- (old key)
    console.log("\n=== ORPHAN grc-* channels (old key) ===");
    for (const ch of guild.channels.cache.values()) {
      if (ch.type === ChannelType.GuildCategory) continue;
      if (/^grc-/.test(ch.name) || /^lead-grc-/.test(ch.name)) {
        const parent = ch.parentId ? guild.channels.cache.get(ch.parentId)?.name : "(none)";
        console.log(`  ${ch.name}  in  ${parent}`);
      }
    }

    // CyGRC roles
    console.log("\n=== CyGRC roles ===");
    for (const r of guild.roles.cache.values()) {
      if (/cygrc|CyGRC/i.test(r.name)) console.log(`  ${r.name}`);
    }

    client.destroy();
    process.exit(0);
  });
  await client.login(env.DISCORD_TOKEN);
}
main().catch((err) => {
  logger.error({ err }, "inspect fatal");
  process.exit(1);
});
