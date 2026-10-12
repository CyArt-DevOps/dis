import { MessageFlags, type Interaction } from "discord.js";
import type { InteractionHandler } from "../core/registry.js";
import { PROJECT_WIZARD_ID } from "../commands/project.js";
import { isStaff } from "../lib/rbac.js";
import { findProject } from "../config/loader.js";
import { createProject } from "../services/projectMgmt.js";

function slugify(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export const projectWizardHandler: InteractionHandler = {
  id: "project:wizard",
  matches(i: Interaction) {
    return i.isModalSubmit() && i.customId === PROJECT_WIZARD_ID;
  },
  async handle(i) {
    if (!i.isModalSubmit() || !i.inCachedGuild()) return;
    const actor = await i.guild.members.fetch(i.user.id);
    if (!isStaff(actor)) {
      await i.reply({ content: "Staff only.", flags: MessageFlags.Ephemeral });
      return;
    }

    const name = i.fields.getTextInputValue("name").trim();
    const key = slugify(i.fields.getTextInputValue("key") || name);
    const modules = Number(i.fields.getTextInputValue("modules"));
    const pods = Number(i.fields.getTextInputValue("pods"));

    if (!name || !key) {
      await i.reply({ content: "Name and key are required.", flags: MessageFlags.Ephemeral });
      return;
    }
    if (!Number.isInteger(modules) || !Number.isInteger(pods) || modules < 0 || pods < 0) {
      await i.reply({
        content: "Modules and pods must be whole numbers.",
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (findProject(key)) {
      await i.reply({ content: `Project key '${key}' already exists.`, flags: MessageFlags.Ephemeral });
      return;
    }

    await i.reply({
      content: `Creating **${name}** (${modules} modules × ${pods} pods)...`,
      flags: MessageFlags.Ephemeral,
    });
    try {
      await createProject(i.guild, {
        key,
        name,
        modules,
        podsPerModule: pods,
        active: true,
      });
      await i.editReply(`Project **${name}** created with key \`${key}\`.`);
    } catch (err) {
      await i.editReply(
        `Failed: ${err instanceof Error ? err.message : "unknown error"}`
      );
    }
  },
};
