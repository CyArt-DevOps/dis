import { describe, it, expect, vi, beforeEach } from "vitest";
import { Collection, type Guild } from "discord.js";

vi.mock("../src/core/logger.js", () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));
const enqueueEvent = vi.fn(async () => {});
vi.mock("../src/services/emsOutbox.js", () => ({ enqueueEvent }));

const meetingCreate = vi.fn();
const meetingUpdate = vi.fn();
const meetingFindUnique = vi.fn();
const attendanceFindMany = vi.fn();
vi.mock("../src/core/db.js", () => ({
  prisma: {
    meeting: { create: meetingCreate, update: meetingUpdate, findUnique: meetingFindUnique },
    meetingAttendance: { findMany: attendanceFindMany },
  },
}));

const { meetingDto, attendanceRows, emitAttendance } = await import("../src/services/meetingSync.js");
const { scheduleMeeting, cancelMeeting, transitionStatus } = await import("../src/services/meetingScheduler.js");

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
  meetingCreate.mockReset();
  meetingUpdate.mockReset();
  meetingFindUnique.mockReset();
  attendanceFindMany.mockReset();
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
    meetingUpdate.mockResolvedValue({ ...base, status: "cancelled" });
    await cancelMeeting(7);
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.cancelled", expect.objectContaining({ status: "cancelled" }));
    enqueueEvent.mockClear();
    await cancelMeeting(7, { source: "ems", updatedAt: new Date("2026-10-27T02:00:00Z") });
    expect(meetingUpdate.mock.calls[1]![0].data).toEqual({ status: "cancelled", updatedAt: new Date("2026-10-27T02:00:00Z") });
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
  it("sweep status changes go out as meeting.updated with the fresh row", async () => {
    meetingUpdate.mockResolvedValue({ ...base, status: "monitoring", updatedAt: new Date("2026-10-28T06:00:05Z") });
    const fresh = await transitionStatus(base, "monitoring");
    expect(fresh.status).toBe("monitoring");
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.updated", expect.objectContaining({ status: "monitoring", updatedAt: "2026-10-28T06:00:05.000Z" }));
  });
});

describe("emitAttendance", () => {
  it("queues meeting.attendance for a completed meeting", async () => {
    meetingFindUnique.mockResolvedValue({ ...base, status: "completed" });
    attendanceFindMany.mockResolvedValue([{ userId: "u1", status: "absent", minutesLate: 0, secondsAttended: 0 }]);
    await emitAttendance(7);
    expect(enqueueEvent).toHaveBeenCalledWith("meeting.attendance", {
      uid: base.uid, rows: [{ discordUserId: "u1", status: "absent", minutesLate: 0, secondsAttended: 0 }],
    });
  });
  it("does nothing for a meeting that is not completed", async () => {
    meetingFindUnique.mockResolvedValue({ ...base, status: "monitoring" });
    await emitAttendance(7);
    expect(enqueueEvent).not.toHaveBeenCalled();
  });
});
