import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { ChannelType, } from "discord.js";
import { CONFIG_PATH, org } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { channelNames, moduleShort, roleNames } from "../lib/names.js";
import { bootstrapServer } from "./bootstrap.js";
import { syncGuildCommands } from "./commandSync.js";
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
function backupDir() {
    return resolve(process.cwd(), "data", "backups");
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
export async function dissolveProject(guild, key) {
    const p = org.projects.find((pr) => pr.key === key);
    if (!p)
        throw new Error(`Project '${key}' not found`);
    const catNames = new Set(categoryNamesOf(p));
    const roleSet = new Set(roleNamesOf(p));
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
    const file = writeBackup(`dissolve-${key}`, snapshot);
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
    logger.info({ project: key, backup: file }, "Project dissolved");
    await refreshCommands();
    return file;
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