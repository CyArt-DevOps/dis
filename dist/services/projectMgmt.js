import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelType, } from "discord.js";
import { CONFIG_PATH, org } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { prisma } from "../core/db.js";
import { channelNames, moduleShort, podRepRoleNames, roleNames } from "../lib/names.js";
import { bootstrapServer } from "./bootstrap.js";
import { syncGuildCommands } from "./commandSync.js";
import { normProject, projectKeyOf } from "./integrationPayloads.js";
import { BackupError, collectProjectMessages } from "./messageBackup.js";
import { backupDir, messageBackupName } from "./messageBackupFiles.js";
import { renderBackupHtml } from "../lib/backupHtml.js";
import { pickProjectMembers } from "../lib/projectMembers.js";
import { isStaff } from "../lib/rbac.js";
import { enqueueEventStrict } from "./emsOutbox.js";
import { integrationEnabled } from "./emsClient.js";
/** Choice lists in slash commands are baked at registration — refresh them. */
async function refreshCommands() {
    await syncGuildCommands().catch((err) => logger.warn({ err }, "Slash command re-sync failed — run `npm run register` manually"));
}
function persistOrg(cfg) {
    // Same canonical file the loader reads — never a src/dist-local copy.
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}
function dedupe(list) {
    return [...new Set(list)];
}
/**
 * Exact category names bootstrap creates for a project, plus their ARCH-
 * variants. Never prefix-match project names: "CyGRC " also prefixes
 * "CyGRC 2.0 M1", so a prefix test on one project eats the other's channels.
 * Order is deterministic so renameProject can zip old names against new ones.
 */
function categoryNamesOf(p) {
    const names = [p.name.toUpperCase()];
    for (let m = 1; m <= p.modules; m++)
        names.push(`${p.name} ${moduleShort(p, m)}`);
    // Custom module labels linger in config even after `modules` shrinks.
    for (const label of Object.values(p.moduleNames ?? {}))
        names.push(`${p.name} ${label}`);
    const base = dedupe(names);
    return [...base, ...base.map((n) => `ARCH-${n}`.slice(0, 100))];
}
/** Exact role names bootstrap creates for a project. Deterministic order. */
function roleNamesOf(p) {
    const names = [p.name, roleNames.projectTeamLead(p), roleNames.projectCoLead(p)];
    for (let m = 1; m <= p.modules; m++) {
        names.push(roleNames.module(p, m));
        for (let pd = 1; pd <= p.podsPerModule; pd++)
            names.push(roleNames.pod(p, m, pd));
    }
    for (const label of Object.values(p.moduleNames ?? {}))
        names.push(`${p.name} ${label}`);
    // Pod Representative roles last, so renames still zip old ↔ new names position by position.
    names.push(...podRepRoleNames(p));
    return dedupe(names);
}
/**
 * Voice channels carry the display name (text channels use the key), so a
 * rename has to move them too — otherwise the next bootstrap creates a second
 * copy under the new name and orphans these.
 */
function voiceNamesOf(p) {
    const names = [`${p.name} General VC`, `${p.name} ${channelNames.leadershipVc()}`];
    for (let m = 1; m <= p.modules; m++) {
        if (p.podsPerModule === 0)
            names.push(`${p.name} ${moduleShort(p, m)} VC`);
        for (let pd = 1; pd <= p.podsPerModule; pd++) {
            names.push(`${p.name} ${moduleShort(p, m)} P${pd} VC`);
        }
    }
    return dedupe(names);
}
function writeBackup(name, data) {
    mkdirSync(backupDir(), { recursive: true });
    const file = resolve(backupDir(), `${name}-${Date.now()}.json`);
    writeFileSync(file, JSON.stringify(data, null, 2));
    return file;
}
export async function createProject(guild, input) {
    input = { ...input, key: input.key.toLowerCase() };
    if (org.projects.some((p) => p.key === input.key)) {
        throw new Error(`Project key '${input.key}' already exists`);
    }
    // Module VC on by default: pod-based projects otherwise get only pod VCs and
    // a module standup has nowhere to meet. Callers can still pass false.
    const def = { moduleChannels: false, moduleVoice: true, ...input };
    const next = { ...org, projects: [...org.projects, def] };
    persistOrg(next);
    // Mutate in-memory cache so bootstrap sees it
    org.projects = next.projects;
    await bootstrapServer(guild);
    await refreshCommands();
}
export async function renameProject(guild, key, newName) {
    const idx = org.projects.findIndex((p) => p.key === key);
    if (idx === -1)
        throw new Error(`Project '${key}' not found`);
    const old = org.projects[idx];
    const updated = { ...old, name: newName };
    // Rename every name-bearing asset before persisting: if the config says
    // "X" while the guild still holds "Y" categories, the next bootstrap builds
    // a whole duplicate project under "X" and orphans "Y".
    const roleMap = new Map(roleNamesOf(old).map((n, i) => [n, roleNamesOf(updated)[i]]));
    for (const role of guild.roles.cache.values()) {
        const next = roleMap.get(role.name);
        if (next && next !== role.name)
            await role.setName(next).catch(() => { });
    }
    const catMap = new Map(categoryNamesOf(old).map((n, i) => [n, categoryNamesOf(updated)[i]]));
    const vcMap = new Map(voiceNamesOf(old).map((n, i) => [n, voiceNamesOf(updated)[i]]));
    for (const c of guild.channels.cache.values()) {
        const next = c.type === ChannelType.GuildCategory ? catMap.get(c.name) : vcMap.get(c.name);
        if (next && next !== c.name)
            await c.edit({ name: next.slice(0, 100) }).catch(() => { });
    }
    org.projects[idx] = updated;
    persistOrg(org);
    // Member.project stores the display name (onboarding writes p.name). Left alone,
    // every intern of the renamed project would stop resolving to its key — and so
    // drop out of EMS's auto-warn switch, back under the bot's own auto-warnings.
    if (old.name !== newName) {
        // projectKeyOf tolerates stray whitespace/case and the key form, so move every
        // raw value that resolves the same way. Prisma can't trim in a where clause
        // portably: fetch the guild's distinct values and match them here.
        const targets = new Set([normProject(old.name), normProject(old.key)]);
        const rows = await prisma.member.findMany({
            where: { guildId: guild.id },
            select: { project: true },
            distinct: ["project"],
        });
        const matches = rows
            .map((r) => r.project)
            .filter((v) => v !== null && targets.has(normProject(v)));
        if (matches.length > 0) {
            const moved = await prisma.member.updateMany({
                where: { guildId: guild.id, project: { in: matches } },
                data: { project: newName },
            });
            logger.info({ project: key, members: moved.count }, "Member project names updated");
        }
    }
    logger.info({ project: key, from: old.name, to: newName }, "Project renamed");
    await refreshCommands();
}
export async function archiveProject(guild, key) {
    const p = org.projects.find((pr) => pr.key === key);
    if (!p)
        throw new Error(`Project '${key}' not found`);
    const archiveCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory &&
        c.name === org.categories.archive.name);
    if (!archiveCat)
        throw new Error("ARCHIVE category missing. Run /setup.");
    const catNames = new Set(categoryNamesOf(p));
    const cats = guild.channels.cache.filter((c) => c.type === ChannelType.GuildCategory &&
        catNames.has(c.name) &&
        !c.name.startsWith("ARCH-"));
    for (const cat of cats.values()) {
        for (const child of guild.channels.cache.values()) {
            if (child.parentId === cat.id && "permissionOverwrites" in child) {
                await child.permissionOverwrites
                    .edit(guild.roles.everyone, { SendMessages: false, Connect: false })
                    .catch(() => { });
            }
        }
        await cat.edit({
            name: `ARCH-${cat.name}`.slice(0, 100),
        }).catch(() => { });
    }
    const idx = org.projects.findIndex((pr) => pr.key === key);
    if (idx !== -1) {
        org.projects[idx] = { ...p, active: false };
        persistOrg(org);
    }
    logger.info({ project: key }, "Project archived");
    await refreshCommands();
}
async function notifyEms(data) {
    if (!integrationEnabled())
        return "off";
    for (let attempt = 1; attempt <= 3; attempt++) {
        try {
            await enqueueEventStrict("project.dissolved", data);
            return "queued";
        }
        catch (err) {
            logger.error({ err, project: data.key, attempt }, "Could not queue project.dissolved for EMS");
            await new Promise((r) => setTimeout(r, attempt * 500));
        }
    }
    return "failed";
}
function safeWriteBackup(name, data) {
    try {
        return writeBackup(name, data);
    }
    catch (err) {
        logger.error({ err, name }, "Could not write dissolve backup file");
        return null;
    }
}
function safeWriteFile(file, data) {
    try {
        writeFileSync(file, JSON.stringify(data, null, 2));
    }
    catch (err) {
        logger.error({ err, file }, "Could not update dissolve backup file");
    }
}
/** One dissolve per project at a time: a second click would double-kick and double-notify. */
const dissolving = new Set();
export async function dissolveProject(guild, key, opts = {}) {
    if (dissolving.has(key))
        throw new BackupError(`Project '${key}' is already being dissolved.`);
    dissolving.add(key);
    try {
        return await runDissolve(guild, key, opts);
    }
    finally {
        dissolving.delete(key);
    }
}
async function runDissolve(guild, key, opts) {
    const p = org.projects.find((pr) => pr.key === key);
    if (!p)
        throw new Error(`Project '${key}' not found`);
    const catNames = new Set(categoryNamesOf(p));
    const roleSet = new Set(roleNamesOf(p));
    // Messages first: if anything can't be read, this throws and nothing is deleted.
    const data = await collectProjectMessages(guild, catNames, {
        project: p.name,
        dissolvedBy: opts.actorTag ?? "unknown",
        onProgress: opts.onProgress,
    });
    const html = renderBackupHtml(data);
    mkdirSync(backupDir(), { recursive: true });
    const messagesFile = resolve(backupDir(), messageBackupName(p.name));
    writeFileSync(messagesFile, html);
    const messagesBytes = Buffer.byteLength(html);
    // Members: decided before anything is deleted (roles are how we find them).
    const others = org.projects.filter((pr) => pr.key !== key);
    const otherRoles = new Set(others.flatMap((pr) => roleNamesOf(pr)));
    let dbIds;
    let all;
    try {
        const dbRows = await prisma.member.findMany({
            where: { guildId: guild.id, project: { not: null } },
            select: { id: true, project: true },
        });
        // Resolve each row against every project, so a member of "Alpha" is never taken for "Alpha Labs".
        dbIds = new Set(dbRows.filter((r) => projectKeyOf(r.project, org.projects) === p.key).map((r) => r.id));
        all = await guild.members.fetch();
    }
    catch (err) {
        throw new BackupError(`Could not load the member list: ${err instanceof Error ? err.message : String(err)}`);
    }
    const pick = pickProjectMembers([...all.values()].map((gm) => ({
        id: gm.id,
        tag: gm.user.tag,
        bot: gm.user.bot,
        staff: isStaff(gm),
        roleNames: [...gm.roles.cache.values()].map((r) => r.name),
        gm,
    })), roleSet, otherRoles, dbIds);
    // The plan goes on disk before the first kick, so a crash mid-way still leaves a record of who was meant to go.
    const membersRecord = {
        project: { key: p.key, name: p.name },
        planned: pick.remove.map((x) => ({ id: x.id, tag: x.tag })),
        skipped: pick.skipped,
        kicked: [],
        kickFailed: [],
        ems: "pending",
        at: new Date().toISOString(),
    };
    const membersFile = safeWriteBackup(`dissolve-members-${key}`, membersRecord);
    const kicked = [];
    const kickedIds = [];
    const kickFailed = [];
    const reason = `Project ${p.name} dissolved`;
    for (const [i, x] of pick.remove.entries()) {
        try {
            await x.gm.kick(reason);
            kicked.push(x.tag);
            kickedIds.push(x.id);
            membersRecord.kicked.push({ id: x.id, tag: x.tag });
        }
        catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            kickFailed.push({ tag: x.tag, error });
            membersRecord.kickFailed.push({ id: x.id, tag: x.tag, error });
        }
        opts.onKickProgress?.(i + 1, pick.remove.length);
    }
    // Only people who really left: someone whose kick failed keeps both Discord and EMS access.
    if (kickedIds.length) {
        await prisma.member
            .updateMany({
            where: { guildId: guild.id, id: { in: kickedIds } },
            data: { status: "former", formerAt: new Date(), formerReason: reason, project: null, module: null, pod: null },
        })
            .catch((err) => logger.error({ err, project: key }, "Could not mark kicked members former"));
    }
    const ems = await notifyEms({ key: p.key, name: p.name, memberIds: kickedIds, dissolvedAt: new Date().toISOString() });
    membersRecord.ems = ems;
    if (membersFile)
        safeWriteFile(membersFile, membersRecord);
    logger.info({ project: key, kicked: kicked.length, skipped: pick.skipped.length, failed: kickFailed.length, ems }, "Project members removed");
    logger.info({ project: key, file: messagesFile, bytes: messagesBytes, channels: data.channels.length }, "Project message backup written");
    const snapshot = {
        project: p,
        roles: guild.roles.cache
            .filter((r) => roleSet.has(r.name))
            .map((r) => ({ id: r.id, name: r.name, color: r.color })),
        channels: guild.channels.cache
            .filter((c) => c.type === ChannelType.GuildCategory && catNames.has(c.name))
            .map((c) => ({ id: c.id, name: c.name })),
        at: new Date().toISOString(),
    };
    // Members are already gone: a failed snapshot write must not stop the clean-up.
    const file = safeWriteBackup(`dissolve-${key}`, snapshot) ?? "(settings backup could not be written)";
    // Collect first, children before categories: deleting a category while
    // iterating orphans its children (parent becomes null) and they get skipped.
    const targets = [...guild.channels.cache.values()].filter((c) => {
        const cat = c.type === ChannelType.GuildCategory ? c : c.parent;
        return !!cat && catNames.has(cat.name);
    });
    targets.sort((a, b) => Number(a.type === ChannelType.GuildCategory) - Number(b.type === ChannelType.GuildCategory));
    for (const c of targets)
        await c.delete("Project dissolve").catch(() => { });
    for (const role of guild.roles.cache.values()) {
        if (roleSet.has(role.name))
            await role.delete("Project dissolve").catch(() => { });
    }
    org.projects = org.projects.filter((pr) => pr.key !== key);
    persistOrg(org);
    logger.info({ project: key, backup: file, messages: messagesFile }, "Project dissolved");
    await refreshCommands();
    return {
        backup: file,
        messagesFile,
        messagesBytes,
        imageFailures: data.imageFailures ?? 0,
        kicked,
        skipped: pick.skipped,
        kickFailed,
        ems,
    };
}
export async function restoreFromBackup(guild, backupFile) {
    if (!existsSync(backupFile))
        throw new Error(`Backup not found: ${backupFile}`);
    const data = JSON.parse(readFileSync(backupFile, "utf-8"));
    if (!data.project)
        throw new Error("Invalid backup");
    await createProject(guild, { ...data.project, active: true });
}
//# sourceMappingURL=projectMgmt.js.map