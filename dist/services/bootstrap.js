import { ChannelType, EmbedBuilder, MessageFlags, PermissionFlagsBits, PermissionsBitField, Colors, } from "discord.js";
import { activeProjects, org } from "../config/loader.js";
import { logger } from "../core/logger.js";
import { readState, updateState } from "../core/state.js";
import { roleNames, channelNames, moduleShort } from "../lib/names.js";
import { beginButton, IDS as ONBOARD_IDS } from "./onboarding.js";
import { LEAVE_IDS, leavePanelButton, leavePanelEmbed } from "./leave.js";
import { TICKET_IDS, panelButton, panelEmbed, projectPanelButton, projectPanelEmbed, } from "./tickets.js";
const F = PermissionFlagsBits;
const VIEW = F.ViewChannel;
const SEND = F.SendMessages;
const CONNECT = F.Connect;
const SPEAK = F.Speak;
const MANAGE_CH = F.ManageChannels;
const MANAGE_MSG = F.ManageMessages;
const READ_HISTORY = F.ReadMessageHistory;
// Discord permission bundles granted to each custom role. These drive
// per-command visibility via setDefaultMemberPermissions (RBAC).
const ROLE_PERMS = {
    Founder: [F.Administrator],
    Manager: [
        F.ManageGuild,
        F.ManageRoles,
        F.ManageChannels,
        F.KickMembers,
        F.BanMembers,
        F.ModerateMembers,
        F.MoveMembers,
        F.MuteMembers,
        F.DeafenMembers,
        F.ManageMessages,
        F.ViewAuditLog,
    ],
    HR: [
        F.ManageGuild,
        F.ManageRoles,
        F.ManageChannels,
        F.KickMembers,
        F.ModerateMembers,
        F.MoveMembers,
        F.ManageMessages,
        F.ViewAuditLog,
    ],
    "Team Lead": [F.ManageMessages, F.ModerateMembers, F.MuteMembers],
    "Co-Lead": [F.ManageMessages],
    Intern: [],
};
async function getOrCreateRole(guild, name, opts = {}) {
    const perms = opts.permissions !== undefined
        ? new PermissionsBitField(opts.permissions)
        : undefined;
    const existing = guild.roles.cache.find((r) => r.name === name);
    if (existing) {
        // Keep permissions in sync on re-run (idempotent)
        if (perms && existing.permissions.bitfield !== perms.bitfield) {
            await existing.setPermissions(perms, "Sync RBAC permissions").catch(() => { });
        }
        return existing;
    }
    logger.info({ name }, "Creating role");
    return guild.roles.create({
        name,
        hoist: opts.hoist ?? false,
        color: opts.color,
        mentionable: opts.mentionable ?? false,
        permissions: perms,
    });
}
async function getOrCreateCategory(guild, name, overwrites = []) {
    const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
    if (existing) {
        // Do NOT re-apply overwrites on every run — that caused a "channel updated"
        // storm whenever bootstrap re-ran (e.g. /project create). Overwrites are set
        // only at creation. Use `/setup` after a deliberate permissions change.
        return existing;
    }
    logger.info({ name }, "Creating category");
    return guild.channels.create({
        name,
        type: ChannelType.GuildCategory,
        permissionOverwrites: overwrites,
    });
}
async function getOrCreateTextChannel(guild, name, parent, overwrites) {
    const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
        c.name === name &&
        c.parentId === parent.id);
    if (existing)
        return existing;
    return guild.channels.create({
        name,
        type: ChannelType.GuildText,
        parent: parent.id,
        permissionOverwrites: overwrites,
    });
}
async function getOrCreateVoiceChannel(guild, name, parent, overwrites) {
    const existing = guild.channels.cache.find((c) => c.type === ChannelType.GuildVoice &&
        c.name === name &&
        c.parentId === parent.id);
    if (existing)
        return existing;
    return guild.channels.create({
        name,
        type: ChannelType.GuildVoice,
        parent: parent.id,
        permissionOverwrites: overwrites,
    });
}
async function ensureRoles(guild) {
    const map = new Map();
    const set = (key, role) => map.set(key, role);
    for (const a of org.roles.admin) {
        set(`admin:${a}`, await getOrCreateRole(guild, a, {
            hoist: true,
            color: Colors.Red,
            permissions: ROLE_PERMS[a] ?? [],
        }));
    }
    for (const l of org.roles.leadership) {
        set(`lead:${l}`, await getOrCreateRole(guild, l, {
            hoist: true,
            color: Colors.Orange,
            permissions: ROLE_PERMS[l] ?? [],
        }));
    }
    set("intern", await getOrCreateRole(guild, roleNames.intern(), {
        hoist: true,
        color: Colors.Blue,
        permissions: [],
    }));
    // Membership roles (batch/project/module/pod) carry NO server permissions —
    // access is purely via channel overwrites.
    for (const b of org.batches) {
        set(`batch:${b}`, await getOrCreateRole(guild, b, { permissions: [] }));
    }
    for (const p of activeProjects()) {
        set(`project:${p.key}`, await getOrCreateRole(guild, roleNames.project(p), {
            color: Colors.Purple,
            permissions: [],
        }));
        // Per-project leadership scoping roles.
        //
        // The Team Lead variant carries ManageMessages for one reason: Discord gates
        // slash-command visibility on permissions, and /meeting is gated on
        // ManageMessages. Without it a project lead cannot even SEE the command, and
        // the only alternative would be granting the org-wide "Team Lead" role —
        // which confers cross-project powers (e.g. /announce to any project).
        // Scheduling itself stays scoped to this role's own project (see
        // canSchedule in commands/meeting.ts). ManageMessages only ever applies in
        // channels the holder can already see, i.e. their own project's.
        set(`plead:${p.key}`, await getOrCreateRole(guild, roleNames.projectTeamLead(p), {
            color: Colors.Orange,
            permissions: [F.ManageMessages],
        }));
        // Co-Leads get no server perms: they cannot schedule meetings, so there is
        // nothing to make visible to them.
        set(`pcolead:${p.key}`, await getOrCreateRole(guild, roleNames.projectCoLead(p), {
            color: Colors.Gold,
            permissions: [],
        }));
        for (let m = 1; m <= p.modules; m++) {
            set(`module:${p.key}:${m}`, await getOrCreateRole(guild, roleNames.module(p, m), { permissions: [] }));
            for (let pd = 1; pd <= p.podsPerModule; pd++) {
                set(`pod:${p.key}:${m}:${pd}`, await getOrCreateRole(guild, roleNames.pod(p, m, pd), { permissions: [] }));
            }
        }
    }
    return map;
}
function adminRoleIds(roles) {
    return org.roles.admin
        .map((a) => roles.get(`admin:${a}`)?.id)
        .filter((x) => !!x);
}
function denyEveryone(guild) {
    return { id: guild.roles.everyone.id, deny: [VIEW] };
}
async function buildInformation(guild, roles) {
    const cat = await getOrCreateCategory(guild, org.categories.information.name);
    const internRoleId = roles.get("intern")?.id;
    for (const ch of org.categories.information.channels) {
        // #welcome should be visible only to unverified members. Once the Intern
        // role is assigned, the channel becomes hidden. Everyone else (including
        // @everyone before verification) can still see it and click Begin Verify.
        const overwrites = ch === "welcome" && internRoleId
            ? [{ id: internRoleId, deny: [VIEW] }]
            : undefined;
        await getOrCreateTextChannel(guild, ch, cat, overwrites);
    }
    await seedInfoContent(guild, cat);
    return cat;
}
/**
 * Content versions. Bump when content is updated so the next bootstrap deletes
 * the old bot-posted messages and posts the new copy. Idempotency is tracked
 * in data/state.json (never in visible message text).
 */
const CONTENT_VERSIONS = {
    rules: "v3",
    guide: "v3",
    announcements: "v3",
};
/** A clickable #channel mention, resolved by name; falls back to plain text if not found. */
function chMention(guild, name) {
    const ch = guild.channels.cache.find((c) => c.type === ChannelType.GuildText && c.name === name);
    return ch ? `<#${ch.id}>` : `#${name}`;
}
/** Post professional intro content in #rules, #intern-guide, #announcements. */
export async function seedInfoContent(guild, cat) {
    const find = (name) => guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
        c.name === name &&
        c.parentId === cat.id);
    const rules = find("rules");
    if (rules)
        await postContentOnce(rules, guild.id, "rules", CONTENT_VERSIONS.rules, rulesContent(guild));
    const guide = find("intern-guide");
    if (guide)
        await postContentOnce(guide, guild.id, "guide", CONTENT_VERSIONS.guide, guideContent(guild));
    const announcements = find("announcements");
    if (announcements)
        await postContentOnce(announcements, guild.id, "announcements", CONTENT_VERSIONS.announcements, announcementsContent(guild));
}
/**
 * Post a professional message once per guild+key+version, tracked in
 * data/state.json. On version bump, or on first run with legacy markers in
 * the channel, delete previous bot-posted seed messages before posting the new
 * copy. No visible marker text is ever embedded in the message.
 */
async function postContentOnce(channel, guildId, key, version, body) {
    const stateKey = `seededInfo.${guildId}.${key}`;
    const state = readState();
    if (state[stateKey] === version)
        return;
    const me = channel.guild.members.me?.id ?? channel.client.user?.id;
    const recent = await channel.messages.fetch({ limit: 50 }).catch(() => null);
    if (recent) {
        // Remove any prior bot-authored seed messages in this channel. Legacy
        // messages carried a `<!-- cyart-<key>-vN -->` marker; new messages start
        // with the same title. Match either.
        const legacyRe = new RegExp(`<!--\\s*cyart-${key}-v\\d+\\s*-->`);
        const title = body.split("\n", 1)[0] ?? "";
        for (const m of recent.values()) {
            if (m.author.id !== me)
                continue;
            if (legacyRe.test(m.content) || (title && m.content.startsWith(title))) {
                await m.delete().catch(() => { });
            }
        }
    }
    // Discord caps a single message at 2000 characters. Split on blank lines and
    // pack into chunks that fit. Also verify each send succeeds before marking
    // state, so a silent failure does not leave the channel empty forever.
    const parts = chunkBy2000(body);
    try {
        for (const part of parts) {
            await channel.send(part);
        }
        updateState(stateKey, version);
        logger.info({ channel: channel.name, key, version, parts: parts.length }, "Seeded info content");
    }
    catch (err) {
        logger.error({ err, channel: channel.name, key }, "Seed post failed");
    }
}
/** Pack text into <=2000-char chunks, splitting on blank-line paragraph breaks. */
function chunkBy2000(body) {
    const LIMIT = 1900; // leave headroom
    if (body.length <= LIMIT)
        return [body];
    const paragraphs = body.split(/\n{2,}/);
    const chunks = [];
    let buf = "";
    for (const p of paragraphs) {
        const candidate = buf ? `${buf}\n\n${p}` : p;
        if (candidate.length <= LIMIT) {
            buf = candidate;
        }
        else {
            if (buf)
                chunks.push(buf);
            // A single paragraph over the limit should be sliced hard.
            if (p.length > LIMIT) {
                let rest = p;
                while (rest.length > LIMIT) {
                    chunks.push(rest.slice(0, LIMIT));
                    rest = rest.slice(LIMIT);
                }
                buf = rest;
            }
            else {
                buf = p;
            }
        }
    }
    if (buf)
        chunks.push(buf);
    return chunks;
}
function rulesContent(guild) {
    return [
        "**Server Rules**",
        "",
        "1. Treat every member with respect. Harassment, discrimination, or personal attacks are not acceptable.",
        "2. Keep discussion relevant to the channel you are in. Off-topic conversations belong in general channels.",
        "3. Do not share confidential project material, credentials, or client data anywhere on this server.",
        "4. No spam, self-promotion, invite links, or advertising without prior HR approval.",
        "5. Follow Discord's Terms of Service and Community Guidelines at all times.",
        "6. Use your real full name in the format assigned during onboarding.",
        "7. Interns are required to be connected to their assigned pod or module voice channel and to remain active during working hours. Attendance and activity are monitored automatically.",
        "8. Working window: Monday to Friday, 11:30 AM to 5:30 PM IST. Join your voice channel between 11:30 AM and 2:00 PM. A minimum of 5 hours and 30 minutes of active voice presence per day is expected.",
        "9. Manager and HR availability, along with the ticket window, is 11:30 AM to 5:30 PM IST. Please raise tickets only during this window unless the matter is urgent.",
        `10. All leave must be requested through the ${chMention(guild, "leave-request")} channel. Unapproved absences are recorded and can lead to escalation.`,
        "11. Direct messages to Founders, Managers, or HR should be reserved for genuine concerns. Use tickets for routine questions.",
        "12. Violations may result in warnings, timeout, or removal. Repeated violations are escalated to HR and Management.",
    ].join("\n");
}
function guideContent(guild) {
    return [
        "**Intern Guide**",
        "",
        "Welcome to the organization. This guide explains how to use this server day to day.",
        "",
        "**Getting started**",
        `Complete verification in the ${chMention(guild, "welcome")} channel first. Select your batch, project, module, and pod. Roles and channel access are assigned automatically once you finish.`,
        "",
        "**Working hours**",
        "The daily working window is Monday to Friday, 11:30 AM to 5:30 PM IST. This is also the window during which Managers and HR are available and tickets should be raised.",
        "",
        "**Daily voice presence**",
        "You are required to join your assigned pod or module voice channel between 11:30 AM and 2:00 PM IST, and to remain connected for a minimum of 5 hours and 30 minutes per day.",
        "",
        "Presence and activity are monitored automatically while you are connected. If you are found inactive (for example, disconnected, idle, or without any voice or interaction activity for extended periods), it will be recorded and action may be taken. Repeated inactivity is escalated to your Team Lead, HR, and Management as per the attendance policy.",
        "",
        "**Meetings**",
        "When your Team Lead or a Manager schedules a meeting, you will receive reminders 24 hours, 1 hour, 15 minutes, and 5 minutes before the start. Join the designated voice channel on time. If you join after the attendance window closes, you are marked late.",
        "",
        "**Support tickets**",
        "Tickets can be raised between 11:30 AM and 5:30 PM IST when Managers and HR are available. Use the appropriate channel:",
        "- Project-related help: your project's support channel.",
        `- HR, Manager, or general questions: the ${chMention(guild, "open-a-ticket")} channel under Tickets.`,
        "Each ticket opens a private channel with the relevant staff so your conversation stays confidential.",
        "",
        "**Requesting leave**",
        `Go to the ${chMention(guild, "leave-request")} channel and click Request Leave.`,
        "- Casual Leave: up to 1 day, requested at least 1 day in advance.",
        "- Sick Leave: 1 day without a document. Longer periods require a medical certificate uploaded in the private HR channel that is created for your request.",
        "- University Examination Leave: request the exam period 3 days in advance and upload your timetable. HR approves the specific exam days from the timetable.",
        "Approved leave automatically excuses you from meetings on the covered days. Your Team Lead is notified so handovers can be arranged.",
        "",
        "**Getting help**",
        "If something is not working, contact HR or your Team Lead through a ticket.",
    ].join("\n");
}
function announcementsContent(guild) {
    return [
        "**Welcome to the Organization**",
        "",
        "This channel is used for official announcements from the Founders, Management, and HR. Please check here regularly for updates on organization-wide events, policy changes, and important dates.",
        "",
        `For project-specific announcements, refer to your project's announcements channel. For questions or clarifications, open a ticket in the ${chMention(guild, "open-a-ticket")} channel between 11:30 AM and 5:30 PM IST.`,
    ].join("\n");
}
async function buildHr(guild, roles) {
    const hrRole = roles.get("admin:HR");
    const overwrites = [
        denyEveryone(guild),
        ...adminRoleIds(roles).map((id) => ({ id, allow: [VIEW, SEND] })),
    ];
    const internRole = roles.get("intern");
    if (internRole)
        overwrites.push({ id: internRole.id, allow: [VIEW, SEND] });
    if (hrRole)
        overwrites.push({ id: hrRole.id, allow: [VIEW, SEND, MANAGE_MSG] });
    const cat = await getOrCreateCategory(guild, org.categories.hr.name, overwrites);
    for (const ch of org.categories.hr.channels) {
        await getOrCreateTextChannel(guild, ch, cat);
    }
    // HR-ops channels visible ONLY to Founder/Manager/HR (interns excluded).
    const staffOnly = [
        denyEveryone(guild),
        ...adminRoleIds(roles).map((id) => ({ id, allow: [VIEW, SEND] })),
    ];
    for (const name of ["attendance-reports", "leave-approvals"]) {
        await getOrCreateTextChannel(guild, name, cat, staffOnly);
    }
}
async function buildPrivateOffice(guild, roles, cfg, adminKeys) {
    const allowed = [];
    for (const key of adminKeys) {
        const r = roles.get(key);
        if (r)
            allowed.push(r.id);
    }
    const overwrites = [
        denyEveryone(guild),
        ...allowed.map((id) => ({
            id,
            allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_MSG],
        })),
    ];
    const cat = await getOrCreateCategory(guild, cfg.name, overwrites);
    for (const t of cfg.textChannels)
        await getOrCreateTextChannel(guild, t, cat);
    for (const v of cfg.voiceChannels)
        await getOrCreateVoiceChannel(guild, v, cat);
}
async function buildTicketsCategory(guild, roles) {
    const overwrites = [
        denyEveryone(guild),
        ...adminRoleIds(roles).map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
    ];
    return getOrCreateCategory(guild, org.categories.tickets.name, overwrites);
}
async function buildProject(guild, roles, p) {
    const projectRoleId = roles.get(`project:${p.key}`)?.id;
    // Channel access is scoped to the PER-PROJECT leadership roles, so a lead of
    // one project never sees another project's channels.
    const teamLeadId = roles.get(`plead:${p.key}`)?.id;
    const coLeadId = roles.get(`pcolead:${p.key}`)?.id;
    if (!projectRoleId)
        return;
    const adminIds = adminRoleIds(roles);
    const projectOverwrites = [
        denyEveryone(guild),
        ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
        { id: projectRoleId, allow: [VIEW, SEND, CONNECT, SPEAK] },
    ];
    // Team Lead can create/manage channels within their own project category.
    if (teamLeadId)
        projectOverwrites.push({
            id: teamLeadId,
            allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_CH],
        });
    const cat = await getOrCreateCategory(guild, p.name.toUpperCase(), projectOverwrites);
    await getOrCreateTextChannel(guild, channelNames.projectGeneral(), cat);
    await getOrCreateTextChannel(guild, channelNames.projectAnnouncements(), cat);
    // Per-project support channel: project members see it and open tickets here;
    // tickets are handled by Team Lead and visible to Manager (+ Founder).
    const supportOverwrites = [
        denyEveryone(guild),
        ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
        { id: projectRoleId, allow: [VIEW] }, // interns: view + use the button, no chatting
    ];
    if (teamLeadId)
        supportOverwrites.push({ id: teamLeadId, allow: [VIEW, SEND, MANAGE_MSG] });
    const support = await getOrCreateTextChannel(guild, `${p.key}-support`, cat, supportOverwrites);
    if (support && support.type === ChannelType.GuildText) {
        // Idempotent: only post if a project-support panel isn't already present.
        // (Previously purged + reposted every run, which spammed the channel.)
        await postPanelOnce(support, `${TICKET_IDS.openproject}:${p.key}`, projectPanelEmbed(p.name), [projectPanelButton(p.key)]);
    }
    // Common project voice channel — usable by everyone in the project (and leads).
    const projectVcOverwrites = [
        denyEveryone(guild),
        ...adminIds.map((id) => ({ id, allow: [VIEW, CONNECT, SPEAK] })),
        { id: projectRoleId, allow: [VIEW, CONNECT, SPEAK] },
    ];
    if (teamLeadId)
        projectVcOverwrites.push({ id: teamLeadId, allow: [VIEW, CONNECT, SPEAK, MANAGE_CH] });
    await getOrCreateVoiceChannel(guild, `${p.name} General VC`, cat, projectVcOverwrites);
    // Leadership sub-area: build as channels under same category (Discord has no nested categories)
    const leadershipOverwrites = [
        denyEveryone(guild),
        ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_MSG] })),
    ];
    if (teamLeadId)
        leadershipOverwrites.push({
            id: teamLeadId,
            allow: [VIEW, SEND, CONNECT, SPEAK],
        });
    if (coLeadId)
        leadershipOverwrites.push({
            id: coLeadId,
            allow: [VIEW, SEND, CONNECT, SPEAK],
        });
    await getOrCreateTextChannel(guild, `lead-${p.key}-${channelNames.teamLeadChat()}`, cat, leadershipOverwrites);
    await getOrCreateTextChannel(guild, `lead-${p.key}-${channelNames.coleadChat()}`, cat, leadershipOverwrites);
    await getOrCreateVoiceChannel(guild, `${p.name} ${channelNames.leadershipVc()}`, cat, leadershipOverwrites);
    // Per-module categories with per-pod channels
    for (let m = 1; m <= p.modules; m++) {
        const moduleRoleId = roles.get(`module:${p.key}:${m}`)?.id;
        if (!moduleRoleId)
            continue;
        const modOverwrites = [
            denyEveryone(guild),
            ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
            { id: moduleRoleId, allow: [VIEW] },
        ];
        if (teamLeadId)
            modOverwrites.push({
                id: teamLeadId,
                allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_CH],
            });
        const modCat = await getOrCreateCategory(guild, `${p.name} ${moduleShort(p, m)}`, modOverwrites);
        // Pod-based modules have no module-wide chat (members live in pod channels),
        // so module-scoped meeting reminders had nowhere to land and fell through to
        // the voice channel. Give each such module a read-only `#<key>-mN-info`
        // channel: the whole module sees it, Team Lead + admins post, and the
        // scheduler routes module meeting notifications here.
        if (p.podsPerModule > 0) {
            const infoOverwrites = [
                denyEveryone(guild),
                ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
                { id: moduleRoleId, allow: [VIEW, READ_HISTORY], deny: [SEND] },
            ];
            if (teamLeadId)
                infoOverwrites.push({ id: teamLeadId, allow: [VIEW, SEND, MANAGE_MSG] });
            await getOrCreateTextChannel(guild, `${p.key}-m${m}-info`, modCat, infoOverwrites);
        }
        // Module-wide channels, open to everyone holding the module role.
        //
        // The voice channel is unconditional: every other VC is pod-specific, so a
        // module standup would otherwise have nowhere to meet. It used to be gated
        // behind `moduleVoice`, which meant any project created by a bot process
        // running pre-fix code silently came out without one.
        //
        // Text is still opt-in. Pod-less modules get chat + resources (they are the
        // module's only channels); pod-based modules get chat only via
        // `moduleChannels`, since module-wide text is already covered by the
        // read-only `#<key>-mN-info` channel above.
        const wantsModuleChat = p.podsPerModule === 0 || p.moduleChannels;
        {
            const moduleChanOverwrites = [
                denyEveryone(guild),
                ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
                { id: moduleRoleId, allow: [VIEW, SEND, CONNECT, SPEAK] },
            ];
            if (teamLeadId)
                moduleChanOverwrites.push({
                    id: teamLeadId,
                    allow: [VIEW, SEND, CONNECT, SPEAK, MANAGE_CH],
                });
            if (wantsModuleChat) {
                await getOrCreateTextChannel(guild, `${p.key}-m${m}-chat`, modCat, moduleChanOverwrites);
                // Pods carry their own resources channels, so only add a module-level
                // one when there are no pods to hold it.
                if (p.podsPerModule === 0) {
                    await getOrCreateTextChannel(guild, `${p.key}-m${m}-resources`, modCat, moduleChanOverwrites);
                }
            }
            await getOrCreateVoiceChannel(guild, `${p.name} ${moduleShort(p, m)} VC`, modCat, moduleChanOverwrites);
        }
        for (let pd = 1; pd <= p.podsPerModule; pd++) {
            const podRoleId = roles.get(`pod:${p.key}:${m}:${pd}`)?.id;
            if (!podRoleId)
                continue;
            const podOverwrites = [
                denyEveryone(guild),
                ...adminIds.map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
                { id: podRoleId, allow: [VIEW, SEND, CONNECT, SPEAK] },
            ];
            // Team Lead sees every pod in their project. Co-Leads get pod access via
            // the per-pod role assigned to them (so they only see their own pod), not
            // via the project-wide Co-Lead role.
            if (teamLeadId)
                podOverwrites.push({
                    id: teamLeadId,
                    allow: [VIEW, SEND, CONNECT, SPEAK],
                });
            await getOrCreateTextChannel(guild, `${p.key}-m${m}-p${pd}-${channelNames.podChat()}`, modCat, podOverwrites);
            await getOrCreateTextChannel(guild, `${p.key}-m${m}-p${pd}-${channelNames.podResources()}`, modCat, podOverwrites);
            await getOrCreateVoiceChannel(guild, `${p.name} ${moduleShort(p, m)} P${pd} VC`, modCat, podOverwrites);
        }
    }
}
async function buildArchiveAndLogs(guild, roles) {
    const adminIds = adminRoleIds(roles);
    const overwrites = [
        denyEveryone(guild),
        ...adminIds.map((id) => ({ id, allow: [VIEW, SEND] })),
    ];
    await getOrCreateCategory(guild, org.categories.archive.name, overwrites);
    const logsCat = await getOrCreateCategory(guild, org.categories.logs.name, overwrites);
    for (const ch of [
        "audit",
        "member-events",
        "voice-events",
        "moderation",
        "tickets",
    ]) {
        await getOrCreateTextChannel(guild, ch, logsCat);
    }
}
/** Returns true if the bot has already posted a message bearing this button customId. */
/** The bot's existing panel message carrying `customId`, if one is posted. */
async function findPanel(channel, customId) {
    const me = channel.guild.members.me?.id ?? channel.client.user?.id;
    const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!messages)
        return undefined;
    return messages.find((m) => m.author.id === me &&
        m.components.some((row) => {
            if (!("components" in row))
                return false;
            const children = row
                .components;
            return children.some((c) => c.customId === customId);
        }));
}
async function postPanelOnce(channel, customId, embed, components) {
    const existing = await findPanel(channel, customId);
    if (existing) {
        // Panels seeded by older builds carry the button but no embed, so the
        // channel showed a bare button with no instructions. Repair in place
        // rather than reposting, which would break any pinned link to it.
        const suppressed = existing.flags.has(MessageFlags.SuppressEmbeds);
        if (existing.embeds.length === 0 || suppressed) {
            // SuppressEmbeds makes Discord accept an embed and then hide it, so the
            // flag has to be cleared in the same edit or the repair looks successful
            // while the panel stays blank.
            await existing
                .edit({ embeds: [embed], components, flags: [] })
                .catch((err) => logger.warn({ err, channel: channel.name }, "Panel repair failed"));
            logger.info({ channel: channel.name, suppressed }, "Repaired panel embed");
        }
        return;
    }
    await channel.send({ embeds: [embed], components });
    logger.info({ channel: channel.name }, "Seeded panel");
}
/** Delete stale bot panels whose button customId starts with the given prefix. */
async function purgeBotPanels(channel, prefix) {
    const me = channel.guild.members.me?.id ?? channel.client.user?.id;
    const messages = await channel.messages.fetch({ limit: 25 }).catch(() => null);
    if (!messages)
        return;
    for (const m of messages.values()) {
        if (m.author.id !== me)
            continue;
        const hit = m.components.some((row) => {
            if (!("components" in row))
                return false;
            const children = row
                .components;
            return children.some((c) => c.customId?.startsWith(prefix));
        });
        if (hit)
            await m.delete().catch(() => { });
    }
}
function verificationPanelEmbed() {
    return new EmbedBuilder()
        .setTitle("Verification Required")
        .setDescription("Welcome. Click **Begin Verification** below and select your Batch, Project, Module, and Pod.\n\n" +
        "Your roles and channel access will be assigned automatically. Until you complete verification, only this channel is visible to you.")
        .setColor(0x5865f2);
}
/** Seed the interactive panels so the channels are functional, not empty. */
async function seedPanels(guild, roles, ticketsCat) {
    // 1) Verification panel in #welcome
    const informationCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory &&
        c.name === org.categories.information.name);
    const welcome = guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
        c.name === "welcome" &&
        c.parentId === informationCat?.id);
    if (welcome) {
        await postPanelOnce(welcome, ONBOARD_IDS.begin, verificationPanelEmbed(), [
            beginButton(),
        ]);
    }
    // 2) Public "open-a-ticket" channel + panel under TICKETS
    const everyoneView = [
        {
            id: guild.roles.everyone.id,
            allow: [VIEW, PermissionFlagsBits.ReadMessageHistory],
            deny: [SEND],
        },
        ...adminRoleIds(roles).map((id) => ({ id, allow: [VIEW, SEND, MANAGE_CH] })),
    ];
    const openChannel = await getOrCreateTextChannel(guild, "open-a-ticket", ticketsCat, everyoneView);
    if (openChannel && openChannel.type === ChannelType.GuildText) {
        await postPanelOnce(openChannel, TICKET_IDS.open, panelEmbed(), [
            panelButton(),
        ]);
    }
    // 3) Leave request panel in #leave-request (HR category, intern-visible).
    const hrCat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === org.categories.hr.name);
    const leaveCh = guild.channels.cache.find((c) => c.type === ChannelType.GuildText &&
        c.name === "leave-request" &&
        c.parentId === hrCat?.id);
    if (leaveCh) {
        await postPanelOnce(leaveCh, LEAVE_IDS.start, leavePanelEmbed(), [leavePanelButton()]);
    }
}
/**
 * Order the role hierarchy automatically (top → bottom):
 * Founder ▸ Manager ▸ HR ▸ Team Lead ▸ Co-Lead ▸ per-project leads ▸ projects ▸
 * modules ▸ pods ▸ batches ▸ Intern. All placed directly below the bot's own
 * highest role. Discord forbids a bot from moving roles above its own role, so
 * the bot role must sit near the top first (one manual drag, once).
 */
async function orderRoles(guild, roles) {
    const me = guild.members.me;
    if (!me)
        return;
    const botTop = me.roles.highest.position;
    if (!me.permissions.has(PermissionFlagsBits.ManageRoles)) {
        logger.warn("Bot lacks Manage Roles — cannot order the role hierarchy");
        return;
    }
    const ordered = [];
    const push = (key) => {
        const r = roles.get(key);
        if (r)
            ordered.push(r);
    };
    for (const a of org.roles.admin)
        push(`admin:${a}`);
    for (const l of org.roles.leadership)
        push(`lead:${l}`);
    for (const p of activeProjects())
        push(`plead:${p.key}`);
    for (const p of activeProjects())
        push(`pcolead:${p.key}`);
    for (const p of activeProjects())
        push(`project:${p.key}`);
    for (const p of activeProjects())
        for (let m = 1; m <= p.modules; m++)
            push(`module:${p.key}:${m}`);
    for (const p of activeProjects())
        for (let m = 1; m <= p.modules; m++)
            for (let pd = 1; pd <= p.podsPerModule; pd++)
                push(`pod:${p.key}:${m}:${pd}`);
    for (const b of org.batches)
        push(`batch:${b}`);
    push("intern");
    if (botTop <= ordered.length) {
        logger.warn({ botPosition: botTop, rolesToOrder: ordered.length }, "Bot role is too low to order the hierarchy. Drag the bot's role to the TOP of Server Settings → Roles, then re-run setup.");
        return;
    }
    // Per-role positioning (top → bottom). More permissive than the bulk
    // setPositions call, which Discord rejects in some configurations.
    let ok = 0;
    let failed = 0;
    for (let idx = 0; idx < ordered.length; idx++) {
        const role = ordered[idx];
        const target = botTop - 1 - idx;
        try {
            if (role.position !== target)
                await role.setPosition(target);
            ok++;
        }
        catch (err) {
            failed++;
            if (failed <= 3)
                logger.error({ role: role.name, target, err: err.message }, "Could not position role");
        }
    }
    logger.info({ ok, failed, total: ordered.length }, "Role hierarchy ordering done");
}
/**
 * Reconcile a project's structure with its config: delete module categories,
 * module roles, and pod roles that exceed the configured modules/podsPerModule
 * (e.g. after reducing a project to zero modules).
 */
/**
 * Delete duplicate child channels within a category. Groups by (type, lowercase
 * name); keeps the oldest (smallest snowflake ID) and deletes the rest. Safe
 * because Discord snowflakes are monotonic — the "keep" is the original.
 */
async function dedupCategoryChildren(guild, cat) {
    const groups = new Map();
    for (const ch of guild.channels.cache.values()) {
        if (ch.parentId !== cat.id)
            continue;
        if (ch.type !== ChannelType.GuildText && ch.type !== ChannelType.GuildVoice)
            continue;
        const key = `${ch.type}:${ch.name.toLowerCase()}`;
        const bucket = groups.get(key) ?? [];
        bucket.push({ id: ch.id, delete: () => ch.delete("Duplicate channel cleanup") });
        groups.set(key, bucket);
    }
    let removed = 0;
    for (const bucket of groups.values()) {
        if (bucket.length < 2)
            continue;
        bucket.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        for (const dup of bucket.slice(1)) {
            await dup.delete().catch(() => { });
            removed++;
        }
    }
    if (removed > 0)
        logger.info({ category: cat.name, removed }, "Deduplicated child channels");
    return removed;
}
/** Run dedup on every category that belongs to the project. */
async function dedupProject(guild, p) {
    const projectCatNames = new Set([p.name.toUpperCase()]);
    for (let m = 1; m <= p.modules; m++)
        projectCatNames.add(`${p.name} M${m}`);
    for (const cat of guild.channels.cache.values()) {
        if (cat.type !== ChannelType.GuildCategory)
            continue;
        if (!projectCatNames.has(cat.name))
            continue;
        await dedupCategoryChildren(guild, cat);
    }
}
async function pruneProject(guild, p) {
    // Module categories named "<Project> M<n>" with n > modules.
    const catPrefix = `${p.name} M`;
    for (const c of guild.channels.cache.values()) {
        if (c.type !== ChannelType.GuildCategory)
            continue;
        if (!c.name.startsWith(catPrefix))
            continue;
        const n = Number(c.name.slice(catPrefix.length));
        if (!Number.isInteger(n) || n <= p.modules)
            continue;
        for (const child of guild.channels.cache.values()) {
            if (child.parentId === c.id)
                await child.delete("Module pruned").catch(() => { });
        }
        await c.delete("Module pruned").catch(() => { });
        logger.info({ project: p.key, category: c.name }, "Pruned module category");
    }
    // Custom-named module categories/roles beyond the configured count (their
    // names don't follow the "M<n>" / "Module <n>" patterns matched below).
    for (const [numStr, label] of Object.entries(p.moduleNames ?? {})) {
        const n = Number(numStr);
        if (!Number.isInteger(n) || n <= p.modules)
            continue;
        const catName = `${p.name} ${label}`;
        const cat = guild.channels.cache.find((c) => c.type === ChannelType.GuildCategory && c.name === catName);
        if (cat) {
            for (const child of guild.channels.cache.values()) {
                if (child.parentId === cat.id)
                    await child.delete("Module pruned").catch(() => { });
            }
            await cat.delete("Module pruned").catch(() => { });
            logger.info({ project: p.key, category: catName }, "Pruned module category");
        }
        for (const role of guild.roles.cache.values()) {
            if (role.name === catName || role.name.startsWith(`${catName} Pod `)) {
                await role.delete("Module/pod pruned").catch(() => { });
                logger.info({ project: p.key, role: role.name }, "Pruned role");
            }
        }
    }
    // Module / pod roles beyond configured counts.
    const rolePrefix = `${p.name} Module `;
    for (const role of guild.roles.cache.values()) {
        if (!role.name.startsWith(rolePrefix))
            continue;
        const rest = role.name.slice(rolePrefix.length);
        const pod = rest.match(/^(\d+) Pod (\d+)$/);
        const mod = rest.match(/^(\d+)$/);
        let remove = false;
        if (pod)
            remove = Number(pod[1]) > p.modules || Number(pod[2]) > p.podsPerModule;
        else if (mod)
            remove = Number(mod[1]) > p.modules;
        if (remove) {
            await role.delete("Module/pod pruned").catch(() => { });
            logger.info({ project: p.key, role: role.name }, "Pruned role");
        }
    }
}
export async function bootstrapServer(guild) {
    logger.info({ guild: guild.name }, "Bootstrap start");
    const before = guild.roles.cache.size;
    const roles = await ensureRoles(guild);
    await buildInformation(guild, roles);
    await buildHr(guild, roles);
    await buildPrivateOffice(guild, roles, org.categories.managerOffice, ["admin:Founder", "admin:Manager"]);
    await buildPrivateOffice(guild, roles, org.categories.hrOffice, ["admin:Founder", "admin:HR"]);
    const ticketsCat = await buildTicketsCategory(guild, roles);
    const projects = activeProjects();
    for (const p of projects) {
        await buildProject(guild, roles, p);
        await pruneProject(guild, p);
        await dedupProject(guild, p);
    }
    await buildArchiveAndLogs(guild, roles);
    await seedPanels(guild, roles, ticketsCat);
    await orderRoles(guild, roles);
    const after = guild.roles.cache.size;
    logger.info({ guild: guild.name }, "Bootstrap done");
    return { rolesCreated: Math.max(0, after - before), projectsBuilt: projects.length };
}
//# sourceMappingURL=bootstrap.js.map