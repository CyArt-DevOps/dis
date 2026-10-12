import { Client, GatewayIntentBits, Partials } from "discord.js";
export function createClient() {
    return new Client({
        intents: [
            GatewayIntentBits.Guilds,
            GatewayIntentBits.GuildMembers,
            GatewayIntentBits.GuildMessages,
            GatewayIntentBits.GuildVoiceStates,
            GatewayIntentBits.MessageContent,
        ],
        partials: [Partials.GuildMember, Partials.Channel],
    });
}
//# sourceMappingURL=client.js.map