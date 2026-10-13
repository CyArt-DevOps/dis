import { Events, MessageFlags } from "discord.js";
import { registry } from "../core/registry.js";
import { logger } from "../core/logger.js";
// Discord's "Unknown interaction" — the token was already dead when we tried to
// respond (usually a gateway disconnect+resume replaying buffered interaction
// events). Nothing to do: the user's client already timed the interaction out.
const UNKNOWN_INTERACTION = 10062;
/** Acknowledge the interaction up front so slow handlers never blow the 3s window. */
async function acknowledge(interaction, mode) {
    if (mode === "self" || !interaction.isRepliable())
        return;
    if (interaction.deferred || interaction.replied)
        return;
    if (mode === "update" && interaction.isMessageComponent()) {
        await interaction.deferUpdate();
    }
    else {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    }
}
/**
 * Discord discards an interaction that is not acknowledged within 3 seconds and
 * the user sees "The application didn't respond in time". Since the database
 * moved to TiDB every query costs a network round trip, so handlers that were
 * comfortably fast against a local file are no longer obviously so. Log the
 * ones that get close, with the name of the handler, so a recurrence points
 * straight at the culprit instead of needing a reproduction.
 */
const SLOW_HANDLER_MS = 2000;
export function registerInteractionCreate(client) {
    client.on(Events.InteractionCreate, async (interaction) => {
        const startedAt = Date.now();
        const warnIfSlow = (name) => {
            const ms = Date.now() - startedAt;
            if (ms >= SLOW_HANDLER_MS) {
                logger.warn({ handler: name, ms }, "Interaction handler close to the 3s limit");
            }
        };
        try {
            if (interaction.isChatInputCommand()) {
                const cmd = registry.commands.get(interaction.commandName);
                if (!cmd)
                    return;
                await cmd.execute(interaction);
                warnIfSlow(`/${interaction.commandName}`);
                return;
            }
            for (const h of registry.handlers) {
                if (h.matches(interaction)) {
                    await acknowledge(interaction, h.ack ?? "self");
                    await h.handle(interaction);
                    warnIfSlow(h.id);
                    return;
                }
            }
        }
        catch (err) {
            // Dead token (gateway replay) — can't respond, and it's not our bug. Drop it.
            if (err?.code === UNKNOWN_INTERACTION)
                return;
            logger.error({
                err,
                type: interaction.type,
                user: "user" in interaction ? interaction.user?.id : undefined,
            }, "Interaction handler failed");
            // Generic message only — never surface internal error text to users.
            if (interaction.isRepliable()) {
                const msg = { content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral };
                try {
                    if (interaction.replied || interaction.deferred) {
                        await interaction.followUp(msg);
                    }
                    else {
                        await interaction.reply(msg);
                    }
                }
                catch {
                    /* interaction already expired */
                }
            }
        }
    });
}
//# sourceMappingURL=interactionCreate.js.map