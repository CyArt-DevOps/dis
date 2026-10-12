# Named-People Meetings with Auto Office VC Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let Founder/Manager/HR schedule `/meeting schedule` for a named list of people (not a role), auto-granting them Manager/HR office VC access for the meeting window with attendance tracking + escalation identical to role-based meetings.

**Architecture:** Add a `people` audience type alongside the existing `org/batch/project/module/pod` ones. Store the parsed member IDs as a CSV column on `Meeting` plus an `office` column. Reuse every existing piece of infrastructure (scheduler sweep, reminders, `MeetingAttendance` rows, HR report, escalation, `VoiceGrant`/`grantVoiceAccess`) by feeding them the right roster/office instead of a Discord role — no parallel systems.

**Tech Stack:** TypeScript, discord.js v14, Prisma + SQLite, vitest.

**Repo note:** This project (`Discord Bot/New folder`) is not a git repository (`git rev-parse` fails). Commit steps below are replaced with a no-op comment — there's nothing to commit to.

---

### Task 1: Pure mention/ID parsing helper

**Files:**
- Create: `src/lib/mentions.ts`
- Test: `tests/mentions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/mentions.test.ts
import { describe, it, expect } from "vitest";
import { parseMentionIds } from "../src/lib/mentions.js";

describe("parseMentionIds", () => {
  it("extracts IDs from Discord mention syntax", () => {
    expect(parseMentionIds("<@123456789012345678> <@!223456789012345678>")).toEqual([
      "123456789012345678",
      "223456789012345678",
    ]);
  });

  it("extracts bare snowflake IDs separated by comma or whitespace", () => {
    expect(parseMentionIds("111111111111111111, 222222222222222222")).toEqual([
      "111111111111111111",
      "222222222222222222",
    ]);
  });

  it("mixes mentions and bare IDs, ignoring stray text", () => {
    expect(parseMentionIds("<@123456789012345678>, 222222222222222222 please attend")).toEqual([
      "123456789012345678",
      "222222222222222222",
    ]);
  });

  it("dedupes repeated IDs", () => {
    expect(parseMentionIds("<@123456789012345678> 123456789012345678")).toEqual([
      "123456789012345678",
    ]);
  });

  it("returns an empty array for garbage input", () => {
    expect(parseMentionIds("no ids here")).toEqual([]);
    expect(parseMentionIds("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- mentions` (from `Discord Bot/New folder`)
Expected: FAIL — `Cannot find module '../src/lib/mentions.js'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/lib/mentions.ts

/** Extract unique Discord user IDs from a free-text mentions/IDs string. */
export function parseMentionIds(input: string): string[] {
  const ids = new Set<string>();

  const mentionRegex = /<@!?(\d{17,20})>/g;
  let match: RegExpExecArray | null;
  while ((match = mentionRegex.exec(input)) !== null) {
    ids.add(match[1]);
  }

  const withoutMentions = input.replace(/<@!?(\d{17,20})>/g, " ");
  for (const token of withoutMentions.split(/[\s,]+/)) {
    if (/^\d{17,20}$/.test(token)) ids.add(token);
  }

  return Array.from(ids);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test -- mentions`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
# no git repo in this project — skip commit
```

---

### Task 2: Schema migration — `audienceMemberIds` + `office` on `Meeting`

**Files:**
- Modify: `prisma/schema.prisma`

- [ ] **Step 1: Add the two nullable columns to the `Meeting` model**

Edit the `Meeting` model (currently ends with `remindersSent`/`status`/`createdAt` before the `attendance` relation) to add:

```prisma
model Meeting {
  id              Int      @id @default(autoincrement())
  guildId         String
  title           String
  description     String?
  organizerId     String
  startAt         DateTime // UTC
  durationMin     Int
  audienceType    String   // org | batch | project | module | pod | people
  audienceBatch   String?
  audienceProject String?  // project key
  audienceModule  Int?
  audiencePod     Int?
  audienceMemberIds String? // CSV of Discord user IDs, only set when audienceType = people
  office          String?  // manager | hr, only set when audienceType = people
  voiceChannelId  String
  mandatory       Boolean  @default(true)
  attendanceWindowMin Int  @default(10)
  reminderIntervalMin Int? // optional extra custom reminder
  remindersSent   String   @default("") // CSV of fired reminder keys
  status          String   @default("scheduled") // scheduled | monitoring | completed | cancelled
  createdAt       DateTime @default(now())

  attendance MeetingAttendance[]

  @@index([guildId, status])
  @@index([startAt])
}
```

- [ ] **Step 2: Generate and apply the migration**

Run (from `Discord Bot/New folder`): `npm run db:migrate -- --name people_audience`
Expected: prompts nothing further (additive nullable columns), creates `prisma/migrations/<timestamp>_people_audience/`, prints "Your database is now in sync with your schema."

- [ ] **Step 3: Regenerate the Prisma client**

Run: `npm run db:generate`
Expected: "Generated Prisma Client" with no errors — `Meeting` type now has `audienceMemberIds`/`office` fields.

- [ ] **Step 4: Commit**

```bash
# no git repo in this project — skip commit
```

---

### Task 3: Export an office-VC lookup from `services/meeting.ts`

**Files:**
- Modify: `src/services/meeting.ts:28-33` (the `findOfficeVoice` function and its two call sites)

- [ ] **Step 1: Rename `findOfficeVoice` to an exported `getOfficeVoiceChannel`**

Replace:

```ts
function findOfficeVoice(guild: Guild, office: Office): VoiceChannel | undefined {
  const name = officeVoiceName(office);
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === name
  ) as VoiceChannel | undefined;
}
```

with:

```ts
export function getOfficeVoiceChannel(guild: Guild, office: Office): VoiceChannel | undefined {
  const name = officeVoiceName(office);
  return guild.channels.cache.find(
    (c) => c.type === ChannelType.GuildVoice && c.name === name
  ) as VoiceChannel | undefined;
}
```

- [ ] **Step 2: Update the two internal call sites**

In `grantVoiceAccess` (currently `const vc = findOfficeVoice(guild, office);`) and in `revokeNow` (currently `const vc = findOfficeVoice(guild, office);`), rename both calls to `getOfficeVoiceChannel(guild, office)`.

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors (this file has no other callers of the old name — confirmed via grep in Task planning).

- [ ] **Step 4: Commit**

```bash
# no git repo in this project — skip commit
```

---

### Task 4: `meetingScheduler.ts` — add the `people` audience type

**Files:**
- Modify: `src/services/meetingScheduler.ts`
- Test: `tests/meetingScheduler.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/meetingScheduler.test.ts
import { describe, it, expect } from "vitest";
import { audienceLabel, resolveAudienceRole } from "../src/services/meetingScheduler.js";
import type { Guild } from "discord.js";

describe("people audience", () => {
  it("labels a people meeting with its member count", () => {
    const m = { audienceType: "people", audienceMemberIds: "1,2,3", audienceProject: null } as any;
    expect(audienceLabel(m)).toBe("Specific people (3)");
  });

  it("labels a people meeting with zero parsed members as (0)", () => {
    const m = { audienceType: "people", audienceMemberIds: null, audienceProject: null } as any;
    expect(audienceLabel(m)).toBe("Specific people (0)");
  });

  it("resolveAudienceRole returns undefined for people audience without touching the guild", () => {
    const m = { audienceType: "people" } as any;
    expect(resolveAudienceRole({} as Guild, m)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test -- meetingScheduler`
Expected: FAIL — `audienceLabel`/`resolveAudienceRole` throw or return wrong value for the unhandled `"people"` switch case (TypeScript's exhaustiveness won't catch it at runtime; the switch simply falls through returning `undefined` from `audienceLabel` too, which doesn't match `"Specific people (3)"`).

- [ ] **Step 3: Extend `AudienceType` and `ScheduleArgs`**

Change:

```ts
export type AudienceType = "org" | "batch" | "project" | "module" | "pod";
```

to:

```ts
export type AudienceType = "org" | "batch" | "project" | "module" | "pod" | "people";
```

Add two fields to `ScheduleArgs` (after `audiencePod?: number;`):

```ts
  audienceMemberIds?: string; // CSV of Discord user IDs (audienceType = people)
  office?: "manager" | "hr"; // audienceType = people
```

- [ ] **Step 4: Handle `people` in `resolveAudienceRole` and `audienceLabel`**

In `resolveAudienceRole`, add a case that returns `undefined` (no Discord role backs a people meeting) right before the closing brace of the `switch`:

```ts
    case "pod": {
      const p = m.audienceProject ? findProject(m.audienceProject) : undefined;
      return p && m.audienceModule && m.audiencePod
        ? find(roleNames.pod(p, m.audienceModule, m.audiencePod))
        : undefined;
    }
    case "people":
      return undefined;
  }
```

In `audienceLabel`, add a case before the closing brace of its `switch`:

```ts
    case "pod":
      return `${p?.name ?? ""} Module ${m.audienceModule} Pod ${m.audiencePod}`.trim();
    case "people": {
      const count = m.audienceMemberIds
        ? m.audienceMemberIds.split(",").filter(Boolean).length
        : 0;
      return `Specific people (${count})`;
    }
  }
```

- [ ] **Step 5: Persist the new fields in `scheduleMeeting`**

In the `prisma.meeting.create({ data: {...} })` call, add two lines after `audiencePod: args.audiencePod,`:

```ts
      audiencePod: args.audiencePod,
      audienceMemberIds: args.audienceMemberIds,
      office: args.office,
      voiceChannelId: args.voiceChannelId,
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm test -- meetingScheduler`
Expected: PASS (3 tests)

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
# no git repo in this project — skip commit
```

---

### Task 5: `meetingAttendance.ts` — roster resolution works for named people too

**Files:**
- Modify: `src/services/meetingAttendance.ts`

- [ ] **Step 1: Add a `resolveAudienceMembers` helper**

Add this function after the existing `getVoice` helper (around line 27), and add `GuildMember` to the `discord.js` import at the top, plus import `grantVoiceAccess` and the `Office` type from `./meeting.js`:

```ts
import {
  ChannelType,
  Client,
  EmbedBuilder,
  Guild,
  GuildMember,
  type VoiceBasedChannel,
} from "discord.js";
import type { Meeting } from "@prisma/client";
import { prisma } from "../core/db.js";
import { logger } from "../core/logger.js";
import { hasApprovedLeaveCovering, attendanceReportsChannel } from "./leave.js";
import { audienceLabel, resolveAudienceRole } from "./meetingScheduler.js";
import { runEscalations } from "./escalation.js";
import { grantVoiceAccess, type Office } from "./meeting.js";
import { formatInTz } from "../lib/time.js";
```

```ts
/** Resolve the meeting's required participants: a role's members, or a named-people list. */
function resolveAudienceMembers(guild: Guild, meeting: Meeting): GuildMember[] {
  if (meeting.audienceType === "people") {
    const ids = (meeting.audienceMemberIds ?? "").split(",").filter(Boolean);
    return ids
      .map((id) => guild.members.cache.get(id))
      .filter((m): m is GuildMember => Boolean(m) && !m!.user.bot);
  }
  const role = resolveAudienceRole(guild, meeting);
  if (!role) return [];
  return Array.from(role.members.filter((m) => !m.user.bot).values());
}
```

- [ ] **Step 2: Use the helper in `handleMeetingStart` instead of inlining role lookup**

Replace:

```ts
  await guild.members.fetch().catch(() => {});
  const role = resolveAudienceRole(guild, meeting);
  if (!role) {
    logger.warn({ meeting: meeting.id }, "Audience role not found — cannot track attendance");
    return;
  }

  const required = role.members.filter((m) => !m.user.bot);
```

with:

```ts
  await guild.members.fetch().catch(() => {});
  const required = resolveAudienceMembers(guild, meeting);
  if (required.length === 0) {
    logger.warn({ meeting: meeting.id }, "No audience members resolved — cannot track attendance");
    return;
  }
```

- [ ] **Step 3: Fix the two spots that assumed `required` was a discord.js `Collection`**

Replace `for (const m of required.values()) {` with `for (const m of required) {`.

Replace `logger.info({ meeting: meeting.id, required: required.size }, "Attendance monitoring started");` with `logger.info({ meeting: meeting.id, required: required.length }, "Attendance monitoring started");`.

- [ ] **Step 4: Auto-grant office VC access for people meetings**

Immediately before the final `logger.info(...)` / `await handleMeetingTick(meeting);` lines at the end of `handleMeetingStart`, add:

```ts
  if (meeting.audienceType === "people" && meeting.office) {
    const office = meeting.office as Office;
    for (const m of required) {
      await grantVoiceAccess(guild, m.id, office, meeting.durationMin, meeting.organizerId).catch(
        (err) => logger.warn({ err, meeting: meeting.id, user: m.id }, "Office VC grant failed")
      );
    }
  }
```

So the end of `handleMeetingStart` reads (in order): the `for` loop creating `MeetingAttendance` rows, then this new office-grant block, then the existing `logger.info(...)`, then `await handleMeetingTick(meeting);`.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
# no git repo in this project — skip commit
```

---

### Task 6: `commands/meeting.ts` — the `people` audience end-to-end

**Files:**
- Modify: `src/commands/meeting.ts`

- [ ] **Step 1: Add imports**

Add `getOfficeVoiceChannel` to the existing `services/meeting.js` import, and import `parseMentionIds`:

```ts
import { grantVoiceAccess, revokeNow, getOfficeVoiceChannel, type Office } from "../services/meeting.js";
import { parseMentionIds } from "../lib/mentions.js";
```

- [ ] **Step 2: Add "Specific People" to the audience choices**

```ts
const AUDIENCES = [
  { name: "Entire Organization", value: "org" },
  { name: "Batch", value: "batch" },
  { name: "Project", value: "project" },
  { name: "Module", value: "module" },
  { name: "Pod", value: "pod" },
  { name: "Specific People", value: "people" },
] as const;
```

- [ ] **Step 3: Reorder the schedule subcommand's options and add `members`/`office`**

The current `schedule` subcommand builder has `voice_channel` (required) positioned right after `audience`, followed by the optional `description/project/module/pod/batch/mandatory/window`. Discord requires all required options before any optional one, so `voice_channel` must move to the optional group. Replace the whole `.addSubcommand((sc) => sc.setName("schedule")...)` block with:

```ts
    .addSubcommand((sc) =>
      sc
        .setName("schedule")
        .setDescription("Schedule a meeting with reminders + attendance")
        .addStringOption((o) => o.setName("title").setDescription("Meeting title").setRequired(true))
        .addStringOption((o) =>
          o.setName("date").setDescription("Date DD/MM/YYYY").setRequired(true)
        )
        .addStringOption((o) =>
          o.setName("start").setDescription("Start time, e.g. 2:30 PM").setRequired(true)
        )
        .addIntegerOption((o) =>
          o.setName("duration").setDescription("Duration in minutes").setRequired(true).setMinValue(5).setMaxValue(600)
        )
        .addStringOption((o) =>
          o.setName("audience").setDescription("Who must attend").setRequired(true).addChoices(...AUDIENCES)
        )
        .addChannelOption((o) =>
          o
            .setName("voice_channel")
            .setDescription("Meeting voice channel (not used for Specific People — pick office instead)")
            .addChannelTypes(ChannelType.GuildVoice)
        )
        .addStringOption((o) => o.setName("description").setDescription("Details"))
        .addStringOption((o) =>
          o.setName("project").setDescription("Project (for project/module/pod)").addChoices(...projectChoices())
        )
        .addIntegerOption((o) => o.setName("module").setDescription("Module number").setMinValue(1))
        .addIntegerOption((o) => o.setName("pod").setDescription("Pod number").setMinValue(1))
        .addStringOption((o) =>
          o.setName("batch").setDescription("Batch (for batch audience)").addChoices(...batchChoices())
        )
        .addBooleanOption((o) => o.setName("mandatory").setDescription("Mandatory? (default yes)"))
        .addIntegerOption((o) =>
          o.setName("window").setDescription("Attendance window minutes (default 10)").setMinValue(1).setMaxValue(120)
        )
        .addStringOption((o) =>
          o
            .setName("members")
            .setDescription("Specific People only: @mentions or IDs, comma/space separated")
        )
        .addStringOption((o) =>
          o
            .setName("office")
            .setDescription("Specific People only: which office VC to grant access to")
            .addChoices(...OFFICES)
        )
    )
```

- [ ] **Step 4: Gate `people` scheduling to staff only in `canSchedule`**

Replace:

```ts
function canSchedule(
  actor: GuildMember,
  audienceType: AudienceType,
  projectKey?: string,
  moduleNum?: number,
  podNum?: number
): boolean {
  if (isStaff(actor)) return true;
  const has = (name: string) => actor.roles.cache.some((r) => r.name === name);
  if (has("Team Lead")) return true; // base Team Lead role
```

with:

```ts
function canSchedule(
  actor: GuildMember,
  audienceType: AudienceType,
  projectKey?: string,
  moduleNum?: number,
  podNum?: number
): boolean {
  if (audienceType === "people") return isStaff(actor); // office VC access is staff-only
  if (isStaff(actor)) return true;
  const has = (name: string) => actor.roles.cache.some((r) => r.name === name);
  if (has("Team Lead")) return true; // base Team Lead role
```

- [ ] **Step 5: Rewrite `handleSchedule`'s validation + args construction**

Replace the entire `handleSchedule` function with:

```ts
async function handleSchedule(
  interaction: import("discord.js").ChatInputCommandInteraction<"cached">,
  actor: GuildMember
): Promise<void> {
  const audienceType = interaction.options.getString("audience", true) as AudienceType;
  const projectKey = interaction.options.getString("project") ?? undefined;
  const moduleNum = interaction.options.getInteger("module") ?? undefined;
  const podNum = interaction.options.getInteger("pod") ?? undefined;
  const batch = interaction.options.getString("batch") ?? undefined;
  const membersRaw = interaction.options.getString("members") ?? undefined;
  const office = (interaction.options.getString("office") as Office | null) ?? undefined;
  const voiceChannelOpt = interaction.options.getChannel("voice_channel");

  if (!canSchedule(actor, audienceType, projectKey, moduleNum, podNum)) {
    await interaction.reply({
      content:
        "You can't schedule this meeting. Founder/Manager/HR/Team Lead can schedule; Co-Leads only their own pod; Specific People meetings are Founder/Manager/HR only.",
      ephemeral: true,
    });
    return;
  }

  // Validate audience parameters.
  if ((audienceType === "project" || audienceType === "module" || audienceType === "pod") && !projectKey) {
    await interaction.reply({ content: "`project` is required for this audience.", ephemeral: true });
    return;
  }
  if ((audienceType === "module" || audienceType === "pod") && !moduleNum) {
    await interaction.reply({ content: "`module` is required for this audience.", ephemeral: true });
    return;
  }
  if (audienceType === "pod" && !podNum) {
    await interaction.reply({ content: "`pod` is required for a pod meeting.", ephemeral: true });
    return;
  }
  if (audienceType === "batch" && !batch) {
    await interaction.reply({ content: "`batch` is required for a batch meeting.", ephemeral: true });
    return;
  }

  let memberIdsCsv: string | undefined;
  let voiceChannelId: string;

  if (audienceType === "people") {
    if (!office) {
      await interaction.reply({ content: "`office` is required for a Specific People meeting.", ephemeral: true });
      return;
    }
    if (!membersRaw) {
      await interaction.reply({
        content: "`members` is required for a Specific People meeting (mentions or IDs).",
        ephemeral: true,
      });
      return;
    }
    const ids = parseMentionIds(membersRaw);
    if (ids.length === 0) {
      await interaction.reply({
        content: "Could not parse any mentions/IDs from `members`.",
        ephemeral: true,
      });
      return;
    }
    const resolved: string[] = [];
    const unresolved: string[] = [];
    for (const id of ids) {
      const m = await interaction.guild.members.fetch(id).catch(() => null);
      if (m) resolved.push(id);
      else unresolved.push(id);
    }
    if (unresolved.length > 0) {
      await interaction.reply({
        content: `Could not find these members in this server: ${unresolved.join(", ")}`,
        ephemeral: true,
      });
      return;
    }
    const vc = getOfficeVoiceChannel(interaction.guild, office);
    if (!vc) {
      await interaction.reply({
        content: `${office === "manager" ? "Manager" : "HR"} Office voice channel not found. Run /setup.`,
        ephemeral: true,
      });
      return;
    }
    memberIdsCsv = resolved.join(",");
    voiceChannelId = vc.id;
  } else {
    if (!voiceChannelOpt) {
      await interaction.reply({ content: "`voice_channel` is required for this audience.", ephemeral: true });
      return;
    }
    voiceChannelId = voiceChannelOpt.id;
  }

  const startAt = parseDateTime(
    interaction.options.getString("date", true),
    interaction.options.getString("start", true)
  );
  if (!startAt) {
    await interaction.reply({
      content: "Invalid date/time. Use date `DD/MM/YYYY` and start like `2:30 PM`.",
      ephemeral: true,
    });
    return;
  }
  if (startAt.getTime() <= Date.now()) {
    await interaction.reply({ content: "Start time must be in the future.", ephemeral: true });
    return;
  }

  const args = {
    guild: interaction.guild,
    organizerId: actor.id,
    title: interaction.options.getString("title", true),
    description: interaction.options.getString("description") ?? undefined,
    startAt,
    durationMin: interaction.options.getInteger("duration", true),
    audienceType,
    audienceBatch: batch,
    audienceProject: projectKey,
    audienceModule: moduleNum,
    audiencePod: podNum,
    audienceMemberIds: memberIdsCsv,
    office,
    voiceChannelId,
    mandatory: interaction.options.getBoolean("mandatory") ?? true,
    attendanceWindowMin: interaction.options.getInteger("window") ?? 10,
  };

  let memberCount: number;
  if (audienceType === "people") {
    memberCount = memberIdsCsv ? memberIdsCsv.split(",").filter(Boolean).length : 0;
  } else {
    const role = resolveAudienceRole(interaction.guild, args);
    if (!role) {
      await interaction.reply({
        content: "Could not resolve the audience role — check the project/module/pod exists (run /setup).",
        ephemeral: true,
      });
      return;
    }
    memberCount = role.members.size;
  }

  const m = await scheduleMeeting(args);
  await interaction.reply({
    content:
      `Scheduled **#${m.id} — ${m.title}**\n` +
      `When: ${formatInTz(startAt)} (${tzName()}) · ${discordTimestamp(startAt, "R")}\n` +
      `Audience: ${audienceLabel(args)} (${memberCount} members)\n` +
      `Reminders: 24h / 1h / 15m / 5m / start. Attendance window: ${args.attendanceWindowMin}m.`,
    ephemeral: true,
  });
}
```

- [ ] **Step 6: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
# no git repo in this project — skip commit
```

---

### Task 7: Full test suite + manual verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full automated test suite**

Run: `npm test`
Expected: all suites pass, including the new `mentions.test.ts` and `meetingScheduler.test.ts`.

- [ ] **Step 2: Re-register commands so Discord picks up the new options**

Run: `npm run register`
Expected: `registered: 21` (same command count — this is an option change on an existing command, not a new command).

- [ ] **Step 3: Manual smoke test in Discord (bot must be running via `npm run dev`)**

1. As Founder/Manager/HR, run `/meeting schedule` with `audience: Specific People`, `members: @someone @someoneelse`, `office: Manager Office`, a `date`/`start` a few minutes in the future, and a short `duration` (e.g. 5).
2. Confirm the reply shows `Audience: Specific people (2)`.
3. Wait for the scheduled start (scheduler sweeps every 30s). Confirm each named person's permission overwrites on the Manager Office VC channel show `Connect`/`Speak` granted (check via Discord channel permissions UI), and that an audit-log entry appears in `#audit` for each grant.
4. After the meeting's `durationMin` elapses, confirm the VC grants are auto-revoked (permission overwrites removed) — no manual `/meeting revoke` needed.
5. Confirm an attendance report posts to `#attendance-reports` listing the named people as present/late/absent based on whether they joined the Manager Office VC.
6. As a Team Lead (non-staff), attempt `/meeting schedule` with `audience: Specific People` — confirm it's rejected with "Specific People meetings are Founder/Manager/HR only."

- [ ] **Step 4: Commit**

```bash
# no git repo in this project — skip commit
```
