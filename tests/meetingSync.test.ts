import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collection, type Guild } from "discord.js";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const enqueueEvent = vi.fn(async () => {});
vi.mock("../src/services/emsOutbox.js", () => ({ enqueueEvent }));

const meetingCreate = vi.fn();
const meetingUpdate = vi.fn();
const meetingUpdateMany = vi.fn();
const meetingFindUnique = vi.fn();
const meetingFindMany = vi.fn();
const attendanceFindMany = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: {
    meeting: {
      create: meetingCreate, update: meetingUpdate, updateMany: meetingUpdateMany,
      findUnique: meetingFindUnique, findMany: meetingFindMany,
    },
    meetingAttendance: { findMany: attendanceFindMany },
  },
}));
vi.mock("../src/services/meeting.js", () => ({ getOfficeVoiceChannel: () => undefined, officeOfVoiceChannel: () => null }));

const { meetingDto, attendanceRows, emitAttendance } = await import("../src/services/meetingSync.js");
const { scheduleMeeting, cancelMeeting, transitionStatus, sweep, setMeetingHooks } = await import("../src/services/meetingScheduler.js");

const base = {
  id: 7, guildId: "g1", title: "Standup", description: null, organizerId: "100000000000000001",
  startAt: new Date("2026-10-28T06:00:00Z"), durationMin: 30, audienceType: "org", audienceBatch: null,
  audienceProject: null, audienceModule: null, audiencePod: null, audienceMemberIds: null, office: null,
  notifyChannelId: null, voiceChannelId: "v1", mandatory: true, attendanceWindowMin: 10, reminderIntervalMin: null,
  remindersSent: "", status: "scheduled", createdAt: new Date("2026-10-27T00:00:00Z"),
  uid: "0f8fad5b-d9cb-469f-a165-70867728950e", source: "dis", updatedAt: new Date("2026-10-27T01:00:00Z"), recurrenceUid: null,
};
// Empty guild: notifications find no channel and quietly return false.
const guild = { id: "g1", channels: { cache: new Collection() }, roles: { cache: new Collection() } } as unknown as Guild;
const args = {
  guild, organizerId: base.organizerId, title: "Standup", startAt: base.startAt, durationMin: 30,
  audienceType: "org" as const, voiceChannelId: "v1", mandatory: true, attendanceWindowMin: 10,
};

beforeEach(() => {
  enqueueEvent.mockClear();
  for (const f of [meetingCreate, meetingUpdate, meetingUpdateMany, meetingFindUnique, meetingFindMany, attendanceFindMany]) f.mockReset();
});

describe("meetingDto / attendanceRows", () => {
  it("maps the Prisma row to the EMS wire shape", () => {
    const dto = meetingDto({ ...base, audienceType: "people", audienceMemberIds: "1,2" });
    expect(dto).toMatchObject({
      uid: base.uid, organizerDiscordId: base.organizerId, startAt: "2026-10-28T06:00:00.000Z",
      audienceMemberIds: ["1", "2"], source: "dis", updatedAt: "2026-10-27T01:00:00.000Z",
    });
    expect(meetingDto(base).audienceMemberIds).toBeNull();
  });
  it("attendance rows carry discordUserId, status, minutesLate, secondsAttended", () => {
    expect(attendanceRows([{ userId: "u1", status: "left_early", minutesLate: 3, secondsAttended: 600 }]))
      .toEqual([{ discordUserId: "u1", status: "left_early", minutesLate: 3, secondsAttended: 600 }]);
  });
});

describe("no echo of API-made changes", () => {
  it("a Discord-made meeting is sent to EMS as meeting.created", async () => {
    meetingCreate.mockResolvedValue(base);
    await scheduleMeeting(args);
    expect(meetingCreate.mock.calls[0]![0].data.source).toBe("dis");
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.created", expect.objectContaining({ uid: base.uid }));
  });
  it("a meeting that came from EMS is stored with its uid and not echoed", async () => {
    meetingCreate.mockResolvedValue({ ...base, source: "ems" });
    await scheduleMeeting({ ...args, uid: base.uid, source: "ems", updatedAt: base.updatedAt });
    expect(meetingCreate.mock.calls[0]![0].data).toMatchObject({ uid: base.uid, source: "ems", updatedAt: base.updatedAt });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("/meeting cancel is sent as meeting.cancelled; an API cancel is not", async () => {
    meetingFindUnique.mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, status: "cancelled" });
    meetingUpdateMany.mockResolvedValue({ count: 1 });
    await cancelMeeting(7);
    expect(meetingUpdateMany.mock.calls[0]![0]).toEqual({ where: { id: 7, status: "scheduled" }, data: { status: "cancelled" } });
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.cancelled", expect.objectContaining({ status: "cancelled" }));
    enqueueEvent.mockClear();
    meetingFindUnique.mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, status: "cancelled" });
    await cancelMeeting(7, { source: "ems", updatedAt: new Date("2026-10-27T02:00:00Z") });
    expect(meetingUpdateMany.mock.calls[1]![0].data).toEqual({ status: "cancelled", updatedAt: new Date("2026-10-27T02:00:00Z") });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("cancel never moves the clock backwards: an older supplied updatedAt keeps the stored one", async () => {
    meetingFindUnique.mockResolvedValueOnce(base).mockResolvedValueOnce({ ...base, status: "cancelled" });
    meetingUpdateMany.mockResolvedValue({ count: 1 });
    await cancelMeeting(7, { source: "ems", updatedAt: new Date("2026-10-27T00:30:00Z") });
    expect(meetingUpdateMany.mock.calls[0]![0].data).toEqual({ status: "cancelled", updatedAt: base.updatedAt });
  });
  it("cancel loses cleanly to the sweep: not scheduled, or the conditional write matched nothing → null, no event", async () => {
    meetingFindUnique.mockResolvedValueOnce({ ...base, status: "monitoring" });
    expect(await cancelMeeting(7)).toBeNull();
    expect(meetingUpdateMany).not.toHaveBeenCalled();
    meetingFindUnique.mockResolvedValueOnce(base);
    meetingUpdateMany.mockResolvedValue({ count: 0 });
    expect(await cancelMeeting(7)).toBeNull();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("sweep status changes go out as meeting.updated with the fresh row", async () => {
    meetingUpdateMany.mockResolvedValue({ count: 1 });
    meetingFindUnique.mockResolvedValue({ ...base, status: "monitoring", updatedAt: new Date("2026-10-28T06:00:05Z") });
    const fresh = await transitionStatus(base, "monitoring");
    expect(fresh!.status).toBe("monitoring");
    expect(meetingUpdateMany.mock.calls[0]![0]).toEqual({
      where: { id: 7, status: "scheduled", startAt: base.startAt }, data: { status: "monitoring" },
    });
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.updated", expect.objectContaining({ status: "monitoring", updatedAt: "2026-10-28T06:00:05.000Z" }));
  });
  it("a transition the API beat (cancelled / moved) writes nothing and sends no event", async () => {
    meetingUpdateMany.mockResolvedValue({ count: 0 });
    expect(await transitionStatus(base, "monitoring")).toBeNull();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});

describe("sync clock: bookkeeping writes keep updatedAt", () => {
  it("the people-meeting channel id is stored with the unchanged updatedAt", async () => {
    const created = { ...base, audienceType: "people", audienceMemberIds: "100000000000000002", source: "ems" };
    meetingCreate.mockResolvedValue(created);
    meetingUpdate.mockResolvedValue({});
    const g = {
      ...guild,
      roles: { cache: new Collection(), everyone: { id: "g1" } },
      channels: { cache: new Collection(), create: vi.fn(async () => ({ id: "c-meet" })) },
    } as unknown as Guild;
    const m = await scheduleMeeting({ ...args, guild: g, audienceType: "people", audienceMemberIds: "100000000000000002", source: "ems" });
    expect(meetingUpdate.mock.calls[0]![0]).toEqual({ where: { id: 7 }, data: { notifyChannelId: "c-meet", updatedAt: base.updatedAt } });
    expect(m.updatedAt).toEqual(base.updatedAt);
  });
});

describe("sweep", () => {
  const clientWith = (g: Guild) => ({ guilds: { cache: new Map([["g1", g]]) } }) as never;
  const hooks = { onStart: vi.fn(async () => {}), onTick: vi.fn(async () => {}), onEnd: vi.fn(async () => {}), onFinalize: vi.fn(async () => {}) };
  beforeEach(() => {
    for (const h of Object.values(hooks)) h.mockReset().mockResolvedValue(undefined);
    setMeetingHooks(hooks);
  });

  it("reminder bookkeeping keeps updatedAt and is conditional on startAt + updatedAt", async () => {
    // Starts in 30 min: the 24h reminder is long stale (marked sent), 1h cannot be delivered (no channel).
    const m = { ...base, startAt: new Date(Date.now() + 30 * 60_000) };
    meetingFindMany.mockResolvedValue([m]);
    meetingUpdateMany.mockResolvedValue({ count: 1 });
    await sweep(clientWith(guild));
    expect(meetingUpdateMany).toHaveBeenCalledTimes(1);
    expect(meetingUpdateMany.mock.calls[0]![0]).toEqual({
      where: { id: 7, startAt: m.startAt, updatedAt: m.updatedAt },
      data: { remindersSent: "24h", updatedAt: m.updatedAt },
    });
  });
  it("a PATCH that reset the reminders wins: a stale snapshot stops work on that meeting this pass", async () => {
    const m = { ...base, startAt: new Date(Date.now() - 1000) }; // due to start too
    meetingFindMany.mockResolvedValue([m]);
    meetingUpdateMany.mockResolvedValue({ count: 0 });
    await sweep(clientWith(guild));
    expect(meetingUpdateMany).toHaveBeenCalledTimes(1); // only the first reminder write; no status change
    expect(hooks.onStart).not.toHaveBeenCalled();
  });
  it("an API cancel that beat the start transition: no onStart", async () => {
    const m = { ...base, remindersSent: "24h,1h,15m,5m,start", startAt: new Date(Date.now() - 1000) };
    meetingFindMany.mockResolvedValue([m]);
    meetingUpdateMany.mockResolvedValue({ count: 0 });
    await sweep(clientWith(guild));
    expect(hooks.onStart).not.toHaveBeenCalled();
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("end: finalize runs before completed, then onEnd with the completed row", async () => {
    const m = { ...base, status: "monitoring", remindersSent: "24h,1h,15m,5m,start", startAt: new Date(Date.now() - 3 * 3600_000) };
    meetingFindMany.mockResolvedValue([m]);
    const order: string[] = [];
    hooks.onFinalize.mockImplementation(async () => { order.push("finalize"); });
    meetingUpdateMany.mockImplementation(async () => { order.push("completed"); return { count: 1 }; });
    meetingFindUnique.mockResolvedValue({ ...m, status: "completed" });
    hooks.onEnd.mockImplementation(async () => { order.push("end"); });
    await sweep(clientWith(guild));
    expect(order).toEqual(["finalize", "completed", "end"]);
    expect(hooks.onEnd.mock.calls[0]![0]).toMatchObject({ status: "completed" });
  });
  it("end: a failed finalize leaves the meeting monitoring for the next sweep", async () => {
    const m = { ...base, status: "monitoring", remindersSent: "24h,1h,15m,5m,start", startAt: new Date(Date.now() - 3 * 3600_000) };
    meetingFindMany.mockResolvedValue([m]);
    hooks.onFinalize.mockRejectedValue(new Error("db down"));
    await sweep(clientWith(guild));
    expect(meetingUpdateMany).not.toHaveBeenCalled();
    expect(hooks.onEnd).not.toHaveBeenCalled();
  });
});

describe("emitAttendance", () => {
  it("queues meeting.attendance for a completed meeting", async () => {
    meetingFindUnique.mockResolvedValue({ ...base, status: "completed" });
    attendanceFindMany.mockResolvedValue([{ userId: "u1", status: "absent", minutesLate: 0, secondsAttended: 0 }]);
    await emitAttendance(7);
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.attendance", {
      uid: base.uid, generatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.*Z$/),
      rows: [{ discordUserId: "u1", status: "absent", minutesLate: 0, secondsAttended: 0 }],
    });
  });
  it("does nothing for a meeting that is not completed", async () => {
    meetingFindUnique.mockResolvedValue({ ...base, status: "monitoring" });
    await emitAttendance(7);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
