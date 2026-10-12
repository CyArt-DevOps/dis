import type {
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  SlashCommandOptionsOnlyBuilder,
  SlashCommandSubcommandsOnlyBuilder,
  Interaction,
} from "discord.js";

export type SlashBuilder =
  | SlashCommandBuilder
  | SlashCommandOptionsOnlyBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | Omit<SlashCommandBuilder, "addSubcommand" | "addSubcommandGroup">;

export interface SlashCommand {
  data: SlashBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<void>;
}

/**
 * How the dispatcher should acknowledge the interaction BEFORE calling `handle`.
 * Discord gives ~3s for the first response; deferring buys 15 minutes.
 *  - "self"   (default): handler owns its first response. Use for anything that
 *             calls `showModal`, `i.update()`, or conditionally acks. No magic.
 *  - "reply"  : dispatcher `deferReply({ephemeral})`. Handler must use editReply.
 *  - "update" : dispatcher `deferUpdate()` (component only). Handler uses editReply.
 */
export type AckMode = "self" | "reply" | "update";

export interface InteractionHandler {
  id: string;
  ack?: AckMode;
  matches(interaction: Interaction): boolean;
  handle(interaction: Interaction): Promise<void>;
}

class Registry {
  readonly commands = new Map<string, SlashCommand>();
  readonly handlers: InteractionHandler[] = [];

  registerCommand(cmd: SlashCommand): void {
    this.commands.set(cmd.data.name, cmd);
  }

  registerHandler(handler: InteractionHandler): void {
    this.handlers.push(handler);
  }
}

export const registry = new Registry();
