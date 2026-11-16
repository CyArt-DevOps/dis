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
import { prisma } from "../core/db.js";
import { TENURE_IDS, parseTenureForm, saveTenure } from "../services/tenure.js";

const idOf = (i: Interaction) => (i.isButton() || i.isModalSubmit() ? i.customId : undefined);

function tenureModal(defaultName: string): ModalBuilder {
  const row = (input: TextInputBuilder) => new ActionRowBuilder<TextInputBuilder>().addComponents(input);
  return new ModalBuilder()
    .setCustomId(TENURE_IDS.form)
    .setTitle("Internship tenure completed")
    .addComponents(
      row(new TextInputBuilder().setCustomId("name").setLabel("Full name").setStyle(TextInputStyle.Short)
        .setRequired(true).setMinLength(2).setMaxLength(100).setValue(defaultName.slice(0, 100))),
      row(new TextInputBuilder().setCustomId("email").setLabel("Email").setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(191).setPlaceholder("The email you gave in the intern form")),
      row(new TextInputBuilder().setCustomId("phone").setLabel("Phone number").setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(20).setPlaceholder("10-digit mobile number")),
      row(new TextInputBuilder().setCustomId("handover").setLabel("Project handover done? (Yes / No)").setStyle(TextInputStyle.Short)
        .setRequired(true).setMaxLength(3).setPlaceholder("Yes or No")),
      row(new TextInputBuilder().setCustomId("date").setLabel("Date of handover (DD-MM-YYYY)").setStyle(TextInputStyle.Short)
        .setRequired(false).setMaxLength(10).setPlaceholder("Required if handover is done, e.g. 14-11-2026"))
    );
}

/** Button on the announcement → private confirmation. */
const startHandler: InteractionHandler = {
  id: "tenure:start",
  ack: "reply",
  matches: (i) => i.isButton() && idOf(i) === TENURE_IDS.start,
  async handle(i) {
    if (!i.isButton()) return;
    const existing = await prisma.tenureCompletion.findUnique({ where: { userId: i.user.id }, select: { updatedAt: true } });
    const note = existing
      ? `\n\nYou already submitted this on **${existing.updatedAt.toISOString().slice(0, 10)}**. Submitting again replaces your earlier details.`
      : "";
    await i.editReply({
      content:
        "**Please confirm:** your internship tenure with CyArt is complete.\n" +
        "If so, you don't need to set up EMS access. You'll be asked for your name, email, phone number and project handover details." +
        note,
      components: [
        new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(TENURE_IDS.confirm).setLabel("Yes, my tenure is complete").setStyle(ButtonStyle.Success)
        ),
      ],
    });
  },
};

/** Confirm → the form. showModal must be the first response, so no defer here. */
const confirmHandler: InteractionHandler = {
  id: "tenure:confirm",
  ack: "self",
  matches: (i) => i.isButton() && idOf(i) === TENURE_IDS.confirm,
  async handle(i) {
    if (!i.isButton()) return;
    const name = i.inCachedGuild() ? i.member.displayName : i.user.globalName ?? i.user.username;
    await i.showModal(tenureModal(name));
  },
};

/** Form submitted → validate and record. */
const formHandler: InteractionHandler = {
  id: "tenure:form",
  ack: "reply",
  matches: (i) => i.isModalSubmit() && idOf(i) === TENURE_IDS.form,
  async handle(i) {
    if (!i.isModalSubmit()) return;
    if (!i.inCachedGuild()) {
      await i.editReply({ content: "Please use the button in the server." });
      return;
    }
    const f = (k: string) => i.fields.getTextInputValue(k) ?? "";
    const parsed = parseTenureForm({ name: f("name"), email: f("email"), phone: f("phone"), handover: f("handover"), date: f("date") });
    if (!parsed.ok) {
      await i.editReply({ content: `${parsed.error}\nPlease click **Tenure Completed** again to resubmit.` });
      return;
    }
    try {
      await saveTenure(i.member, parsed.value);
    } catch (err) {
      logger.warn({ err, user: i.user.id }, "Tenure save failed");
      await i.editReply({ content: "Something went wrong while saving. Please try again in a few minutes." });
      return;
    }
    const v = parsed.value;
    await i.editReply({
      content: [
        "**Thank you. Your details have been recorded for HR.**",
        `Name: ${v.name}`,
        `Email: ${v.email}`,
        `Phone: ${v.phone}`,
        `Project handover done: ${v.handoverDone ? "Yes" : "No"}${v.handoverDate ? ` (${v.handoverDate})` : ""}`,
        "",
        "Made a mistake? Click **Tenure Completed** again to resubmit.",
      ].join("\n"),
    });
  },
};

export const tenureHandlers: InteractionHandler[] = [startHandler, confirmHandler, formHandler];
