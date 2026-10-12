# Security Review & Hardening

Audit of the intern-org bot. Covers what was checked, what was hardened in this pass, and the operational steps you must take.

## Threat model

The bot holds an Administrator token for a 500–1000+ member server. Primary risks:
1. **Token compromise** → full server takeover.
2. **Privilege escalation** → an intern granting themselves staff/lead roles or access.
3. **Abuse / DoS** → spamming tickets, channels, mentions.
4. **Information disclosure** → interns seeing other pods/projects or staff-only data.

## Access control (RBAC) — verified

Every privileged action is gated **twice**: by Discord's `setDefaultMemberPermissions` (hides the command) **and** a runtime role check (authoritative). Defense in depth — a server-settings override of command visibility still can't bypass the runtime check.

| Surface | Runtime guard |
|---|---|
| `/setup`, `/project` create/rename/archive | `isStaff` (+ `isFounder` for dissolve/restore) |
| `/lead`, `/colead`, `/assign` | `canManageLeadership` / `isStaff` (Founder/Manager/HR only) |
| `/ticket`, `/panel`, `/meeting`, `/dashboard` | `isStaff` |
| `/warn /timeout /kick /ban /purge /lock /unlock /slowmode` | `isStaff` or the matching Discord mod permission |
| Ticket claim / close / VC-grant buttons | `isStaff` |
| Verification (interns) | self-service, but cannot assign anything beyond their own pod |

- **No command can assign admin or leadership roles to interns.** `/assign` only touches batch/project/module/pod. `/lead`/`/colead` are staff-gated.
- **Leadership roles carry no `ManageRoles`** (Team Lead = ManageMessages/Timeout/Mute; Co-Lead = ManageMessages), so a lead cannot escalate. Only Founder (Admin) / Manager / HR can manage roles.
- Membership roles (Intern, batch, project, module, pod) have **zero** server permissions; access is purely channel overwrites.

## Isolation — verified

- `@everyone` is denied `ViewChannel` on every restricted category.
- Pods grant view only to the specific pod role (+ that project's Team Lead + admins). A Co-Lead sees only their own pod (via the per-pod role, not a project-wide role).
- **Per-project leadership**: a lead of one project cannot see another project's channels or tickets.
- Project-support tickets route to **that project's** Team Lead + Manager + Founder only.
- DM-delivered interactions are rejected (`inCachedGuild()` checks); the verification flow only runs inside the guild.

## Hardened in this pass

- **Ticket DoS guard**: max **3 open tickets per user** (`MAX_OPEN_TICKETS_PER_USER`). Prevents channel-exhaustion via ticket spam.
- **Re-verification blocked**: once a member holds the Intern role, the verification button refuses to restart (prevents role stacking / flow abuse).
- **Single-membership enforcement**: assignment strips any prior batch/project/module/pod role, so a member can only ever belong to one pod.
- **Interaction error handling**: failures are logged server-side; users only ever see a generic message (no internal error text leaked). Handles deferred/replied interactions correctly.
- **Welcome flood removed**: no per-join channel post (was a spam/abuse vector on mass joins); a best-effort DM is sent instead.
- **Startup health check**: on boot the bot warns if it is missing required permissions or if its role sits below the Intern role (which would silently break role assignment).
- **Auto role-hierarchy ordering**: `/setup` orders all 123 roles correctly beneath the bot, so privilege hierarchy is correct by construction.

## Code-level safety — verified

- **SQL injection**: not possible — all DB access is via Prisma (parameterized).
- **Input validation**: slash options are typed/bounded; modal inputs validated; `/assign` validates module/pod against the project's real counts.
- **Secrets**: `.env` is git-ignored and validated by zod at boot; the token is never logged.
- **Crash safety**: `unhandledRejection` is logged; DB disconnects cleanly on SIGINT/SIGTERM; dangling voice sessions and expired VC grants are reconciled on boot.

## Operational actions you MUST take

1. **Rotate the bot token now.** It was pasted into a chat. Developer Portal → Bot → Reset Token, then update `DISCORD_TOKEN` in `.env`. Nothing else changes.
2. **Keep the token only in `.env`** (already git-ignored). Never commit it; never paste it anywhere.
3. **Limit who holds Founder / Administrator.** Founder = full control. Grant it to as few humans as possible.
4. **Enable "Require 2FA for moderation"** in Server Settings → Safety Setup. Discord then requires 2FA for kick/ban/etc.
5. **Back up `data/app.db`** regularly (tickets, attendance, warns, grants live there).
6. **Scope the bot invite**: it needs Administrator only during setup/role-ordering. If you want least privilege afterward, you can replace Administrator with: Manage Roles, Manage Channels, Manage Server, Kick, Ban, Moderate Members, Move Members, Manage Messages, View Audit Log, Read/Send Messages, Connect — but keep its role at the top.
7. **Production**: run behind a process manager (PM2/systemd) with auto-restart; set `NODE_ENV=production`.

## Residual notes

- The `MessageContent` intent is enabled because message edit/delete logging records content. If you don't need content in audit logs, you can drop that intent for a smaller attack/PII surface.
- SQLite is fine for a single instance. For multi-instance/high-availability, move `DATABASE_URL` to Postgres (schema is portable).
