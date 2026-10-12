# Named-people meetings with auto office VC access

## Problem

`/meeting schedule` only supports role-based audiences (org/batch/project/module/pod). There's no way to schedule a meeting for a specific, arbitrary set of people (e.g. "these 4 interns to Manager Office at 2:30 PM"). VC access for the office channels is currently granted one person at a time via a separate staff-only `/meeting grant`.

## Goal

Let staff (Founder/Manager/HR only) schedule a meeting for named people, with automatic VC access granted to Manager/HR office for the meeting's time slot, auto-revoked after — reusing the existing scheduler, attendance, and voice-grant infrastructure rather than building parallel systems.

## Command changes (`src/commands/meeting.ts`)

- `AUDIENCES` gains `{ name: "Specific People", value: "people" }`.
- New optional string option `members`: mentions/IDs separated by comma or whitespace, e.g. `@Alice @Bob 123456789012345678`.
- New optional string option `office`: reuses existing `OFFICES` choices (`manager`/`hr`).
- `voice_channel` option moves from required to optional at the Discord API level (must be repositioned after all required options in the builder — Discord requires required options before optional ones). Code-level validation still requires it for org/batch/project/module/pod audiences.
- Validation for `audience === "people"`:
  - `members` must be present and parse to at least one valid guild member ID (see parsing below). Any unparseable/unresolvable token → reply with an error naming which token failed.
  - `office` must be present.
  - `voice_channel` is ignored; the meeting's `voiceChannelId` is set to the office's actual VC (resolved via a newly-exported lookup in `services/meeting.ts`, e.g. `getOfficeVoiceChannel(guild, office)` built from the existing internal `findOfficeVoice`).
- `canSchedule`: add a check — `audienceType === "people"` requires `isStaff(actor)` (Founder/Manager/HR only); Team Lead/Co-Lead cannot schedule this audience type regardless of the general Team Lead allowance.

### Parsing `members`

Extract with regex: Discord mention format `<@!?(\d+)>` and bare snowflakes (17–19 digits), split on comma/whitespace, dedupe. For each extracted ID, `guild.members.fetch(id)` — collect failures and report them together in one error message rather than failing on the first bad ID.

## Data model (`prisma/schema.prisma`)

`Meeting` gains two nullable columns:
- `audienceMemberIds String?` — CSV of Discord user IDs (only set when `audienceType === "people"`)
- `office String?` — `"manager"` | `"hr"` (only set when `audienceType === "people"`)

New migration required (name suggestion: `people_audience`).

## Scheduler changes (`src/services/meetingScheduler.ts`)

- `resolveAudienceRole` / whatever resolves the audience for validation at schedule time: special-case `audienceType === "people"` to skip role resolution entirely (no Discord role is involved) — instead just validate the parsed member count > 0.
- `audienceLabel(args)`: add a `people` case returning `"Specific people (N)"` where N is the parsed member count.
- `scheduleMeeting(args)` persists `audienceMemberIds` (CSV) and `office` on the `Meeting` row when present.

## Attendance changes (`src/services/meetingAttendance.ts`)

Add `resolveAudienceMembers(guild, meeting)`:
- If `meeting.audienceType === "people"`: parse `meeting.audienceMemberIds` CSV, fetch each as a `GuildMember`, return that list.
- Else: existing behavior — fetch the audience role's `.cache` members.

`onStart` (attendance monitoring) uses this helper instead of inlining role-member lookup. Everything downstream — `MeetingAttendance` row creation (present/late/absent, leave-excusal via `hasApprovedLeaveCovering`), `onTick` VC-presence checks, `onEnd` HR report, and `escalation.ts`'s `countAbsences`/threshold logic — is already keyed by Discord user ID, not by role, so it works unmodified once given the right roster. Escalation thresholds (3→team lead, 5→HR, 7→manager, 10→flag) apply to named-people meetings the same as any other meeting — an absence counts regardless of meeting type.

## Auto VC grant/revoke

No new grant/revoke machinery. At the meeting's existing `onStart` hook (already wired in `index.ts` via `setMeetingHooks`), when `meeting.audienceType === "people"`:

```
for each userId in parsed audienceMemberIds:
  await grantVoiceAccess(guild, userId, meeting.office, meeting.durationMin, meeting.organizerId)
```

This reuses `services/meeting.ts`'s existing `grantVoiceAccess`, which already:
- Sets `ViewChannel`/`Connect`/`Speak` overwrites on the office VC
- Persists a `VoiceGrant` row
- Arms a self-expiring `setTimeout` revoke sized to `durationMin` (computed from actual start time, so a late-starting meeting doesn't get cut short)
- Logs to `#audit`
- Is already restart-safe via `restoreGrants()` on boot (no changes needed there — it iterates all non-revoked `VoiceGrant` rows generically)

No explicit revoke call is needed at `onEnd` — the grant's own timer expires it at `durationMin` from grant time, which coincides with the meeting's scheduled end.

## Out of scope

- No cap on number of named people (comma/space list, no hard limit like a fixed 5-user-option design would have).
- No new UI for picking people (no autocomplete/picker — plain text mentions).
- Not building a separate subcommand — this is a new audience type on the existing `/meeting schedule`.
