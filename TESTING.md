# End-to-End Test Plan

How to verify the bot manually in Discord, plus the automated tests.

## Automated tests

```bash
npm test          # unit tests (time parsing, CSV) via vitest
npm run typecheck # full TypeScript check
```

## Prerequisites for manual testing

1. `npm run db:migrate && npm run db:generate`
2. `npm run register` (slash commands)
3. `npm run build:server` (creates roles/channels/panels; orders hierarchy)
4. `npm run dev` (bot online — keep this running; buttons only work while it runs)
5. Bot role dragged to the **top** of Server Settings → Roles.

Use **two accounts**: a staff account (Founder/owner) and a test "intern" account.

## 1. Registration & onboarding

- [ ] Intern account: in `#welcome`, click **Begin Verification**.
- [ ] Modal asks Full Name. Try `Jo` → rejected (min 3). Try `John 😀` → rejected (symbols). Enter `John Smith` → accepted.
- [ ] Pick Batch → Project → Module → Pod. Final message: "Verified."
- [ ] Intern's nickname becomes `John Smith | <Project>`.
- [ ] Intern can now see only their pod/module/project channels; not other projects.
- [ ] Click **Begin Verification** again → blocked ("already verified").
- [ ] Register a second account with the same name → first account's flow still works, and a "Duplicate name flagged" note appears in `#audit`.

## 2. Leadership scoping

- [ ] Staff: `/lead assign member:@intern project:<X>` → intern gets `<X> Team Lead`, sees all of project X, none of project Y.
- [ ] `/colead assign … module: pod:` → co-lead sees only that pod.

## 3. Tickets

- [ ] In `#open-a-ticket`, click **Open a Ticket** → pick a category → fill modal → private ticket channel created with the right staff role.
- [ ] In a project's `#<key>-support`, **Open Support Ticket** → ticket visible to that project's Team Lead + Manager only.
- [ ] Open 4 tickets quickly → 4th refused (max 3 open).
- [ ] Staff: **Claim**, then **Close** → transcript posted to `#logs/tickets`, channel deleted.

## 4. Meetings, reminders & attendance (core)

Schedule a meeting a few minutes out so you can watch the cycle:

- [ ] Staff: `/meeting schedule title:"Standup" date:<today DD/MM/YYYY> start:<~3 min ahead, e.g. 2:35 PM> duration:10 audience:pod project:<X> module:1 pod:1 voice_channel:<a VC> window:2`
- [ ] Reply confirms schedule with IST time + audience size.
- [ ] `/meeting list` shows it.
- [ ] At start time, a reminder pings the pod role in the VC chat; meeting flips to `monitoring`.
- [ ] Intern joins the VC **within** the window → later marked ✅ Present. Have another required member **not** join → ❌ Absent. Join **after** the window → 🟡 Late.
- [ ] After `start + duration + window`, a report appears in `#attendance-reports` (HR-only) with counts + absent list + late list.

## 5. Leave & auto-excuse

- [ ] Intern: `/leave request start_date:<meeting day> start_time:9:00 AM end_date:<same> end_time:6:00 PM reason:"Exam"`.
- [ ] Approve/Reject card appears in `#leave-approvals` (HR-only).
- [ ] Staff approves → intern gets a DM.
- [ ] Schedule a meeting during that window → that intern is auto-marked 🟣 Excused (not absent) in the report.

## 6. Escalation

- [ ] Make a test intern absent from meetings until their unexcused-absence count hits 3 → Team Lead pinged in `#attendance-reports`. (5 → HR, 7 → Manager, 10 → disciplinary flag.)

## 7. Dashboard, reports & exports

- [ ] `/attendance report project:<X>` → attendance %, counts, avg delay.
- [ ] `/attendance leaderboard` → ranked list.
- [ ] `/attendance export format:excel` → downloadable `.xlsx`; `format:pdf` → `.pdf`; default CSV.
- [ ] `/dashboard overview` → org-wide counts.

## 8. Web dashboard (optional)

- [ ] Set `WEB_TOKEN` in `.env`, run `npm run web`, open `http://localhost:8090`, enter the token → leaderboard renders.

## 9. Moderation & logging

- [ ] `/warn`, `/timeout`, `/purge`, `/lock` → actions logged in `#moderation` / `#audit`.
- [ ] Member join/leave, role changes, voice join/leave appear in the relevant `#logs` channels.

## 10. Resilience

- [ ] Restart the bot mid-cycle (Ctrl-C, `npm run dev`) → scheduled meetings still fire (state is in the DB); active VC grants are restored.
