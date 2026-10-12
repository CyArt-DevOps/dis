# Intern Org Discord Bot

Enterprise Discord management bot for an intern organization (Founder / Manager / HR / Team Leads / Co-Leads / Interns) structured as Projects → Modules → Pods.

This drop contains **Phases 1–3** of the full roadmap:

1. **Foundation** — TS + discord.js v14, env validation (zod), structured logging (pino), command/handler registry, RBAC core.
2. **Server bootstrap** — `/setup` auto-creates all roles, categories, and channels from `src/config/org.json`. Idempotent.
3. **Onboarding** — new members get a welcome embed with a **Begin Verification** button. Dropdowns walk them through Batch → Project → Module → Pod. Roles are assigned automatically.

Later phases (tickets, attendance, dashboards, announcements, moderation, archive/dissolve, dashboard UI, DB) plug into the same registry without changes to existing files.

## Project layout

```
src/
  config/
    env.ts           # zod-validated env vars
    org.json         # org structure: batches, projects, modules, pods, role names, categories
    loader.ts        # parses + validates org.json
  core/
    client.ts        # discord.js Client + intents
    logger.ts        # pino
    registry.ts      # slash command + interaction handler registry
  lib/
    rbac.ts          # role-based access checks
    names.ts         # canonical role/channel name builders
  events/
    ready.ts
    interactionCreate.ts
    guildMemberAdd.ts
  commands/
    index.ts         # registers all slash commands
    ping.ts
    setup.ts         # /setup
  interactions/
    verification.ts  # button + select-menu handlers for onboarding
  services/
    bootstrap.ts     # creates roles/categories/channels
    onboarding.ts    # builds verification UI + assigns roles
  index.ts           # entrypoint
scripts/
  register-commands.ts  # registers slash commands with Discord
```

## Prerequisites

- Node.js 20+
- A Discord application + bot token
- A test guild where the bot is invited with `applications.commands` + `bot` scopes
- Bot needs: **Administrator** during initial `/setup` (creates ~100+ roles and channels). Tighter perms can come later.
- Privileged Gateway Intents to enable in the Developer Portal:
  - **Server Members Intent** (for `guildMemberAdd`)
  - **Message Content Intent** (only required if you later add prefix commands)

## Setup

```bash
# 1. Install
npm install

# 2. Configure
cp .env.example .env
# Fill DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID
# DATABASE_URL defaults to file:./data/app.db (SQLite)

# 3. Set up the database (creates data/app.db + Prisma client)
npm run db:migrate
npm run db:generate

# 4. Register slash commands with Discord (guild-scoped, instant)
npm run register

# 5. Run in dev (hot reload)
npm run dev
```

For production:

```bash
npm run build
npm start
```

## First-run flow

1. Invite the bot to your guild with Administrator.
2. `npm run register` — slash commands appear immediately in the guild.
3. In Discord, run `/setup` as the server owner.
4. Bot creates: roles (Founder, Manager, HR, Team Lead, Co-Lead, Intern, per-project, per-batch, per-module, per-pod) + all categories + project channels + leadership channels + per-pod channels + private offices + tickets + archive + logs.
5. Drag the bot's role above every role it needs to manage (Discord requires this — bot can't assign roles ranked above its own).
6. New member joins → bot DMs/posts welcome → user clicks **Begin Verification** → batch/project/module/pod dropdowns → roles auto-assigned.

## Configuration

Edit `src/config/org.json`. No code changes required to:

- Add or rename batches
- Add a project (set `active: true`, pick `modules` and `podsPerModule`)
- Rename categories
- Change which channels go in INFORMATION / HR

Re-run `/setup` after edits — it is idempotent and only creates what's missing.

## What the bot creates

- **Admin roles:** Founder, Manager, HR (red, hoisted)
- **Leadership roles:** Team Lead, Co-Lead (orange, hoisted)
- **Intern role** (blue, hoisted)
- **Per-project:** `<Project>` role + category, `#general`, `#announcements`
- **Per-module:** `<Project> Module N` role + `<Project> M<N>` category
- **Per-pod:** `<Project> Module N Pod M` role + `#<key>-mN-pM-chat`, `#<key>-mN-pM-resources`, `<Project> MN PM VC`
- **Private offices:** MANAGER OFFICE (Founder + Manager) and HR OFFICE (Founder + HR), each with a text + voice channel
- **TICKETS, ARCHIVE, LOGS** categories
- **#logs/audit, member-events, voice-events, moderation, tickets** subchannels

Pod-channel names are prefixed with the project key + module + pod (e.g. `ai-siem-m2-p3-chat`) because Discord requires unique channel slugs and there is no nested-category feature.

## Permission model

- `@everyone` is **denied ViewChannel** on every restricted category.
- Pods grant view only to the **specific Pod role** (and Team Lead / Co-Lead / admins).
- Modules grant view to the **specific Module role** (and Team Lead / admins).
- Projects grant view to the **Project role** (and admins).
- Interns end up with Intern + Batch + Project + Module + Pod roles → see exactly their pod + module + project + general server info. Nothing else.

## What is NOT in this drop

Implemented since the initial drop:

- **Database** — Prisma + SQLite (`prisma/schema.prisma`): Member, Ticket, VoiceSession, Attendance, Warn. Swap `DATABASE_URL` to Postgres for production; schema is portable.
- **`/lead` / `/colead`** assign/remove/transfer/list with auto role + perm application.
- **`/announce`** target=org/project/module/pod/batch (pings the right role).
- **Moderation** — `/warn` (DB-backed, list/clear), `/timeout`, `/kick`, `/ban`, `/purge`, `/lock`, `/unlock`, `/slowmode`.
- **`/project`** create/rename/archive/dissolve/restore (dissolve = Founder + key confirm, auto-backup to `data/backups/`).
- **Event logging** → `#audit`, `#member-events`, `#voice-events`, `#moderation`, `#tickets`.
- **Ticket system** — `/ticket panel|close|stats`, 6 categories, modal intake, private channels, claim/close buttons, transcripts attached to `#tickets` log.

- **VC meeting requests** — `/meeting grant|revoke`, plus a "Grant VC (30m)" button on HR/Manager-meeting tickets. Grants temp Connect on the office VC, auto-revokes on a timer, survives restart (`VoiceGrant` table + `restoreGrants` on boot), and disconnects the member when time's up.
- **Attendance** — voice join/leave tracked into `VoiceSession`, rolled up daily into `Attendance`. `/attendance me` and `/attendance user` (staff) show today/week/month. Dangling sessions closed on boot.

- **`/dashboard`** — `overview` (total interns, per-project counts, leadership, modules/pods, tickets, active today, weekly voice, inactive count), `project <key>` (per-module/per-pod member breakdown), `inactive` (interns with no voice activity in 7 days). Staff only; fetches all members for accurate role counts.

Still pending (next sessions):

- CSV/Excel/PDF report export
- Web dashboard
- Tests, CI, Docker compose

The registry pattern (`src/core/registry.ts`) means new commands and interaction handlers register themselves in their own files — no changes required to the central dispatcher.

## Troubleshooting

- **"Missing Permissions" during /setup** — bot role isn't above the roles it tries to create/manage. Move it up in Server Settings → Roles.
- **No welcome message on join** — Server Members Intent not enabled in Developer Portal, or `#welcome` not created yet. Run `/setup` first.
- **Slash commands don't appear** — run `npm run register`. Guild commands are instant; global would take an hour.
- **Verification button does nothing** — check the bot logs (pino). The `interactionCreate` handler logs all errors.
