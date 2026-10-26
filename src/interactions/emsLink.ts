import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type Interaction,
} from "discord.js";
import type { InteractionHandler } from "../core/registry.js";
import { logger } from "../core/logger.js";
import { LINK_IDS, confirmLink, confirmMessage, startLink, startMessage } from "../services/emsLink.js";

export function linkButtonRow() {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(LINK_IDS.begin).setLabel("Link EMS account").setStyle(ButtonStyle.Success)
  );
}

export function detailsModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(LINK_IDS.details)
    .setTitle("Link your CyArt portal account")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("email").setLabel("Email you applied with").setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(191).setPlaceholder("name@example.com")
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("hrName").setLabel("Your HR's full name").setStyle(TextInputStyle.Short)
          .setRequired(true).setMaxLength(100).setPlaceholder("The HR who sent your offer")
      )
    );
}

function codeModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(LINK_IDS.code)
    .setTitle("Enter your link code")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId("code").setLabel("6-digit code from the email").setStyle(TextInputStyle.Short)
          .setRequired(true).setMinLength(6).setMaxLength(6)
      )
    );
}

const idOf = (i: Interaction) => (i.isButton() || i.isModalSubmit() ? i.customId : undefined);

const beginHandler: InteractionHandler = {
  id: "emslink:begin",
  matches: (i) => i.isButton() && idOf(i) === LINK_IDS.begin,
  async handle(i) {
    if (i.isButton()) await i.showModal(detailsModal());
  },
};

const detailsHandler: InteractionHandler = {
  id: "emslink:details",
  ack: "reply",
  matches: (i) => i.isModalSubmit() && idOf(i) === LINK_IDS.details,
  async handle(i) {
    if (!i.isModalSubmit()) return;
    try {
      const r = await startLink(i.user.id, i.fields.getTextInputValue("email"), i.fields.getTextInputValue("hrName"));
      const components =
        r.status === "code_sent"
          ? [new ActionRowBuilder<ButtonBuilder>().addComponents(
              new ButtonBuilder().setCustomId(LINK_IDS.enterCode).setLabel("Enter code").setStyle(ButtonStyle.Primary)
            )]
          : [];
      await i.editReply({ content: startMessage(r), components });
    } catch (err) {
      logger.warn({ err, user: i.user.id }, "EMS link start failed");
      await i.editReply({ content: startMessage({ status: "error" }) });
    }
  },
};

const enterCodeHandler: InteractionHandler = {
  id: "emslink:entercode",
  matches: (i) => i.isButton() && idOf(i) === LINK_IDS.enterCode,
  async handle(i) {
    if (i.isButton()) await i.showModal(codeModal());
  },
};

const codeHandler: InteractionHandler = {
  id: "emslink:code",
  ack: "reply",
  matches: (i) => i.isModalSubmit() && idOf(i) === LINK_IDS.code,
  async handle(i) {
    if (!i.isModalSubmit()) return;
    try {
      const r = await confirmLink(i.user.id, i.fields.getTextInputValue("code"));
      await i.editReply({ content: confirmMessage(r) });
    } catch (err) {
      logger.warn({ err, user: i.user.id }, "EMS link confirm failed");
      await i.editReply({ content: confirmMessage({ status: "error" }) });
    }
  },
};

export const emsLinkHandlers: InteractionHandler[] = [beginHandler, detailsHandler, enterCodeHandler, codeHandler];
