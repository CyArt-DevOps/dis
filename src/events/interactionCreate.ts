import { Events, MessageFlags, type Client, type Interaction } from "discord.js";
import { registry, type AckMode } from "../core/registry.js";
import { logger } from "../core/logger.js";

// Discord's "Unknown interaction" — the token was already dead when we tried to
// respond (usually a gateway disconnect+resume replaying buffered interaction
// events). Nothing to do: the user's client already timed the interaction out.
const UNKNOWN_INTERACTION = 10062;

/** Acknowledge the interaction up front so slow handlers never blow the 3s window. */
async function acknowledge(interaction: Interaction, mode: AckMode): Promise<void> {
  if (mode === "self" || !interaction.isRepliable()) return;
  if (interaction.deferred || interaction.replied) return;
  if (mode === "update" && interaction.isMessageComponent()) {
    await interaction.deferUpdate();
  } else {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  }
}

/**
 * Discord discards an interaction that is not acknowledged within 3 seconds and
 * the user sees "The application didn't respond in time".
 *
 * What matters is time to ACKNOWLEDGEMENT, not total handler time. A handler
 * that defers first has 15 minutes afterwards, so a deferred command taking 3s
 * is slow but perfectly safe — warning about it buries the real failures in
 * noise. Only an unacknowledged interaction is in danger.
 */
const ACK_DANGER_MS = 2000;
/** Total runtime worth a note, well clear of anything user-visible. */
const SLOW_TOTAL_MS = 10_000;

export function registerInteractionCreate(client: Client): void {
  client.on(Events.InteractionCreate, async (interaction: Interaction) => {
    const startedAt = Date.now();
    const warnIfSlow = (name: string) => {
      const ms = Date.now() - startedAt;
      const acked =
        interaction.isRepliable() && (interaction.deferred || interaction.replied);
      if (!acked && ms >= ACK_DANGER_MS) {
        // This one really can hit "didn't respond in time".
        logger.warn(
          { handler: name, ms },
          "Interaction ran this long WITHOUT acknowledging — close to the 3s limit"
        );
      } else if (ms >= SLOW_TOTAL_MS) {
        logger.info({ handler: name, ms, acked }, "Slow interaction (already acknowledged)");
      }
    };
    try {
      if (interaction.isChatInputCommand()) {
        const cmd = registry.commands.get(interaction.commandName);
        if (!cmd) return;
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
    } catch (err) {
      // Dead token (gateway replay) — can't respond, and it's not our bug. Drop it.
      if ((err as { code?: number })?.code === UNKNOWN_INTERACTION) return;
      logger.error(
        {
          err,
          type: interaction.type,
          user: "user" in interaction ? interaction.user?.id : undefined,
        },
        "Interaction handler failed"
      );
      // Generic message only — never surface internal error text to users.
      if (interaction.isRepliable()) {
        const msg = { content: "Something went wrong. Please try again.", flags: MessageFlags.Ephemeral } as const;
        try {
          if (interaction.replied || interaction.deferred) {
            await interaction.followUp(msg);
          } else {
            await interaction.reply(msg);
          }
        } catch {
          /* interaction already expired */
        }
      }
    }
  });
}
