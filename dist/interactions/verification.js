import { MessageFlags } from "discord.js";
import { IDS, assignRoles, batchMenu, isVerified, moduleMenu, nameModal, podMenu, projectMenu, savePendingName, validateFullName, } from "../services/onboarding.js";
import { findProject } from "../config/loader.js";
import { moduleLabel } from "../lib/names.js";
function customId(i) {
    if (i.isButton() || i.isStringSelectMenu() || i.isModalSubmit())
        return i.customId;
    return undefined;
}
export const beginHandler = {
    id: "verification:begin",
    matches(i) {
        return i.isButton() && customId(i) === IDS.begin;
    },
    async handle(i) {
        if (!i.isButton() || !i.inCachedGuild())
            return;
        // `showModal` IS the acknowledgement and cannot be deferred, so everything
        // before it competes with Discord's 3s window. Discord already sends the
        // member (roles included) with the interaction, so use it rather than
        // spending a REST round trip re-fetching what we were just handed.
        const member = i.member;
        if (isVerified(member)) {
            await i.reply({
                content: "You're already verified. If your batch/project/module/pod needs to change, ask a staff member to update it with `/assign`.",
                flags: MessageFlags.Ephemeral,
            });
            return;
        }
        // Step 1: ask for full name via a modal.
        await i.showModal(nameModal());
    },
};
export const nameModalHandler = {
    id: "verification:name",
    // savePendingName + member fetch run before the reply — defer first.
    ack: "reply",
    matches(i) {
        return i.isModalSubmit() && customId(i) === IDS.name;
    },
    async handle(i) {
        if (!i.isModalSubmit() || !i.inCachedGuild())
            return;
        const raw = i.fields.getTextInputValue("fullName");
        const result = validateFullName(raw);
        if (!result.ok) {
            await i.editReply({
                content: `${result.reason} Please click **Begin Verification** again.`,
            });
            return;
        }
        const member = await i.guild.members.fetch(i.user.id);
        const { duplicate } = await savePendingName(member, result.value);
        const dupNote = duplicate
            ? "\n\nNote: this name matches an existing member and has been flagged for HR review. You can continue."
            : "";
        await i.editReply({
            content: `Name saved: **${result.value}**.${dupNote}\n\nStep 2 of 5: select your batch.`,
            components: [batchMenu()],
        });
    },
};
export const batchHandler = {
    id: "verification:batch",
    matches(i) {
        return i.isStringSelectMenu() && customId(i) === IDS.batch;
    },
    async handle(i) {
        if (!i.isStringSelectMenu())
            return;
        const batch = i.values[0];
        if (!batch) {
            await i.reply({ content: "No batch selected.", flags: MessageFlags.Ephemeral });
            return;
        }
        await i.update({
            content: `Batch: **${batch}**. Step 3 of 5: select your project.`,
            components: [projectMenu(batch)],
        });
    },
};
/** Assign roles + finish verification (shared by all terminal steps). */
async function finalize(i, assignment) {
    const member = await i.guild.members.fetch(i.user.id);
    if (isVerified(member)) {
        await i.update({
            content: "You're already verified. Ask staff to change your assignment.",
            components: [],
        });
        return;
    }
    await i.deferUpdate();
    const result = await assignRoles(member, assignment);
    const missingNote = result.missing.length > 0
        ? `\n\nWarning — these roles do not exist yet (run /setup first): ${result.missing.join(", ")}`
        : "";
    await i.editReply({
        content: `Verification complete. Roles assigned:\n- ${result.assigned.join("\n- ")}` + missingNote,
        components: [],
    });
}
export const projectHandler = {
    id: "verification:project",
    matches(i) {
        return (i.isStringSelectMenu() &&
            (customId(i)?.startsWith(IDS.project + ":") ?? false));
    },
    async handle(i) {
        if (!i.isStringSelectMenu() || !i.inCachedGuild())
            return;
        const id = customId(i);
        const batch = decodeURIComponent(id.split(":")[2] ?? "");
        const projectKey = i.values[0];
        if (!projectKey) {
            await i.reply({ content: "No project selected.", flags: MessageFlags.Ephemeral });
            return;
        }
        const p = findProject(projectKey);
        // Project without modules → finish here.
        if (!p || p.modules === 0) {
            await finalize(i, { batch, projectKey });
            return;
        }
        await i.update({
            content: `Batch: **${batch}** | Project: **${p.name}**. Step 4 of 5: select your module.`,
            components: [moduleMenu(batch, projectKey)],
        });
    },
};
export const moduleHandler = {
    id: "verification:module",
    matches(i) {
        return (i.isStringSelectMenu() &&
            (customId(i)?.startsWith(IDS.module + ":") ?? false));
    },
    async handle(i) {
        if (!i.isStringSelectMenu() || !i.inCachedGuild())
            return;
        const id = customId(i);
        const parts = id.split(":");
        const batch = decodeURIComponent(parts[2] ?? "");
        const projectKey = parts[3] ?? "";
        const moduleNum = Number(i.values[0]);
        if (!batch || !projectKey || !Number.isFinite(moduleNum)) {
            await i.reply({ content: "Invalid selection state.", flags: MessageFlags.Ephemeral });
            return;
        }
        const p = findProject(projectKey);
        // Module without pods → finish here.
        if (!p || p.podsPerModule === 0) {
            await finalize(i, { batch, projectKey, moduleNum });
            return;
        }
        await i.update({
            content: `Batch: **${batch}** | Project: **${p.name}** | Module: **${moduleLabel(p, moduleNum)}**. Step 5 of 5: select your pod.`,
            components: [podMenu(batch, projectKey, moduleNum)],
        });
    },
};
export const podHandler = {
    id: "verification:pod",
    matches(i) {
        return (i.isStringSelectMenu() && (customId(i)?.startsWith(IDS.pod + ":") ?? false));
    },
    async handle(i) {
        if (!i.isStringSelectMenu())
            return;
        if (!i.inCachedGuild()) {
            await i.reply({ content: "Guild only.", flags: MessageFlags.Ephemeral });
            return;
        }
        const id = customId(i);
        const parts = id.split(":");
        const batch = decodeURIComponent(parts[2] ?? "");
        const projectKey = parts[3] ?? "";
        const moduleNum = Number(parts[4]);
        const podNum = Number(i.values[0]);
        if (!batch ||
            !projectKey ||
            !Number.isFinite(moduleNum) ||
            !Number.isFinite(podNum)) {
            await i.reply({ content: "Invalid selection state.", flags: MessageFlags.Ephemeral });
            return;
        }
        await finalize(i, { batch, projectKey, moduleNum, podNum });
    },
};
export const verificationHandlers = [
    beginHandler,
    nameModalHandler,
    batchHandler,
    projectHandler,
    moduleHandler,
    podHandler,
];
//# sourceMappingURL=verification.js.map