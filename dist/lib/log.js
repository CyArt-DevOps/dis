import { ChannelType, EmbedBuilder, } from "discord.js";
import { org } from "../config/loader.js";
export async function postLog(guild, channel, embed) {
    const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
        c.name === channel &&
        c.parent?.name === org.categories.logs.name);
    if (!ch)
        return;
    await ch.send({ embeds: [embed] }).catch(() => { });
}
export function logEmbed(title, color = 0x5865f2) {
    return new EmbedBuilder()
        .setTitle(title)
        .setColor(color)
        .setTimestamp(new Date());
}
//# sourceMappingURL=log.js.map